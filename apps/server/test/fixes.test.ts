import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EventRecord } from "../src/db.js";
import { SessionStore, type Persist } from "../src/session.js";

/** A persist function whose writes complete only when the test says so, recording DB order. */
function controlledPersist() {
  const order: string[] = [];
  const pending: { rec: EventRecord; resolve: () => void; reject: (e: Error) => void }[] = [];
  const persist: Persist = (rec) =>
    new Promise((resolve, reject) => {
      pending.push({
        rec,
        resolve: () => {
          order.push(`${rec.eventType}:${(rec.metadata as { trackId?: string }).trackId ?? ""}`);
          resolve("stored");
        },
        reject,
      });
    });
  // Newest write finishes first: the worst case, where a host action's save beats an event's.
  const flush = async () => {
    await new Promise((r) => setTimeout(r, 0));
    while (pending.length) {
      pending.pop()!.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return { persist, pending, order, flush };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const votesFor = (s: SessionStore, id: string) => s.getState().tracks.find((t) => t.id === id)!.votes;

describe("host actions vs in-flight events", () => {
  it("a vote being saved while the host plays that track lands before the play, so live state matches replay", async () => {
    const c = controlledPersist();
    const store = new SessionStore("demo", "Demo", { persist: c.persist });
    const vote = store.submitVote({ trackId: "track_02", eventId: randomUUID(), participantId: "participant_a1" });
    await tick();
    const play = store.advance("track_02"); // must wait for the vote to finish
    await c.flush();
    await Promise.all([vote, play]);
    expect(c.order).toEqual(["vote:track_02", "track_advance:track_02"]);
    expect(store.getState().nowPlaying?.trackId).toBe("track_02");
    expect(votesFor(store, "track_02")).toBe(0); // no stale vote on the playing track
    expect(store.getState().queue).toHaveLength(0);
  });

  it("an event arriving during a reset waits and counts in the new run", async () => {
    const c = controlledPersist();
    const store = new SessionStore("demo", "Demo", { persist: c.persist });
    const reset = store.reset();
    await tick();
    const vote = store.submitVote({ trackId: "track_03", eventId: randomUUID(), participantId: "participant_b2" });
    await c.flush();
    await Promise.all([reset, vote]);
    expect(c.order).toEqual(["session_reset:", "vote:track_03"]);
    expect(votesFor(store, "track_03")).toBe(1);
    expect(store.getState().run).toBe(2);
  });
});

describe("retries while the original is still saving", () => {
  it("get the original's real result, so a failed save is retried instead of lost", async () => {
    const c = controlledPersist();
    const store = new SessionStore("demo", "Demo", { persist: c.persist });
    const input = { trackId: "track_01", eventId: randomUUID(), participantId: "participant_c3" };
    const first = store.submitVote(input);
    await tick();
    const retry = store.submitVote(input); // e.g. resent from the outbox after a reconnect
    c.pending.shift()!.reject(new Error("db down"));
    expect((await first).status).toBe("rejected");
    expect(await retry).toMatchObject({ status: "rejected", httpStatus: 503 });
    expect(votesFor(store, "track_01")).toBe(0);
  });

  it("report duplicate once the original was saved", async () => {
    const c = controlledPersist();
    const store = new SessionStore("demo", "Demo", { persist: c.persist });
    const input = { trackId: "track_01", eventId: randomUUID(), participantId: "participant_d4" };
    const first = store.submitVote(input);
    await tick();
    const retry = store.submitVote(input);
    await c.flush();
    expect((await first).status).toBe("accepted");
    expect((await retry).status).toBe("duplicate");
    expect(votesFor(store, "track_01")).toBe(1);
  });
});

describe("boosts on the playing track", () => {
  it("are recorded but don't put the track back in the queue (live and replay agree)", async () => {
    const saved: Required<EventRecord>[] = [];
    let t = Date.now();
    const store = new SessionStore("demo", "Demo", {
      persist: async (r) => (saved.push({ ...r, time: new Date((t += 10)) } as Required<EventRecord>), "stored"),
    });
    await store.advance("track_04");
    const out = await store.recordBoost({ trackId: "track_04", eventId: randomUUID(), participantId: "participant_e5", signature: "sig", lamports: 1 });
    expect(out.status).toBe("accepted");
    expect(store.getState().latestEvent?.message).toMatch(/already playing/);
    await store.advance("track_01");
    expect(store.getState().queue.find((q) => q.trackId === "track_04")).toBeUndefined();

    const restored = new SessionStore("demo", "Demo");
    restored.replay(saved);
    expect(restored.getState().queue).toEqual(store.getState().queue);
  });
});

describe("crowd quest", () => {
  it("carries taps past the goal into the next quest", async () => {
    const store = new SessionStore("demo", "Demo");
    await store.recordTaps({ count: 25, eventId: randomUUID(), participantId: "participant_f6" });
    await store.recordTaps({ count: 25, eventId: randomUUID(), participantId: "participant_f6" });
    await store.recordTaps({ count: 25, eventId: randomUUID(), participantId: "participant_f6" });
    await store.recordTaps({ count: 20, eventId: randomUUID(), participantId: "participant_f6" }); // 95/100
    await store.recordTaps({ count: 30, eventId: randomUUID(), participantId: "participant_f6" }); // → 125
    expect(store.getState().crowdQuest).toMatchObject({ progress: 25, goal: 200, label: "Quest 2: send 200 hype taps" });
  });
});

describe("run and round counters (let phones reset vote buttons)", () => {
  it("round increases each time a track starts playing; run increases on reset", async () => {
    const store = new SessionStore("demo", "Demo");
    const round = (id: string) => store.getState().tracks.find((t) => t.id === id)!.round;
    expect(store.getState().run).toBe(1);
    await store.advance("track_02");
    await store.advance("track_03");
    await store.advance("track_02");
    expect(round("track_02")).toBe(2);
    expect(round("track_03")).toBe(1);
    await store.reset();
    expect(store.getState().run).toBe(2);
    expect(round("track_02")).toBe(0);
  });
});
