import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EventRecord } from "../src/db.js";
import { SessionStore, type Persist } from "../src/session.js";

const vote = (trackId: string, participantId = "participant_aaaa") => ({
  trackId,
  eventId: randomUUID(),
  participantId,
});

describe("persist-then-apply", () => {
  it("BE-07/TD-07: does not apply or broadcast an event the database failed to save", async () => {
    const failing: Persist = async () => {
      throw new Error("connection refused");
    };
    const store = new SessionStore("demo", "Demo", { persist: failing });
    let broadcasts = 0;
    store.onChange(() => broadcasts++);
    const before = store.getState();

    const outcome = await store.submitVote(vote("track_01"));

    expect(outcome).toMatchObject({ status: "rejected", httpStatus: 503 });
    expect(store.getState().tracks).toEqual(before.tracks);
    expect(store.getState().version).toBe(before.version);
    expect(broadcasts).toBe(0);
  });

  it("lets the same eventId succeed on retry after a failed write", async () => {
    let fail = true;
    const flaky: Persist = async () => {
      if (fail) throw new Error("timeout");
      return "stored";
    };
    const store = new SessionStore("demo", "Demo", { persist: flaky });
    const v = vote("track_02");
    expect((await store.submitVote(v)).status).toBe("rejected");
    fail = false;
    expect((await store.submitVote(v)).status).toBe("accepted");
    expect(store.getState().tracks.find((t) => t.id === "track_02")?.votes).toBe(1);
  });

  it("treats a database-level duplicate as already counted", async () => {
    const store = new SessionStore("demo", "Demo", { persist: async () => "duplicate" });
    const outcome = await store.submitVote(vote("track_03"));
    expect(outcome.status).toBe("duplicate");
    expect(store.getState().tracks.find((t) => t.id === "track_03")?.votes).toBe(0);
  });

  it("blocks a concurrent double vote while the first write is in flight", async () => {
    let release!: () => void;
    const slow: Persist = () => new Promise((r) => (release = () => r("stored")));
    const store = new SessionStore("demo", "Demo", { persist: slow });
    const first = store.submitVote(vote("track_04"));
    const second = await store.submitVote(vote("track_04"));
    expect(second).toMatchObject({ status: "rejected", httpStatus: 409 });
    release();
    expect((await first).status).toBe("accepted");
    expect(store.getState().tracks.find((t) => t.id === "track_04")?.votes).toBe(1);
  });

  it("records host actions and does not change the stage if saving fails", async () => {
    const saved: EventRecord[] = [];
    const store = new SessionStore("demo", "Demo", { persist: async (r) => (saved.push(r), "stored") });
    await store.setVisual({ theme: "sunset", intensity: 0.6 });
    expect(saved.at(-1)).toMatchObject({ eventType: "host_visual", metadata: { visual: { theme: "sunset", intensity: 0.6 } } });

    const broken = new SessionStore("demo", "Demo", {
      persist: async () => {
        throw new Error("down");
      },
    });
    expect((await broken.setVisual({ theme: "sunset", intensity: 0.6 })).status).toBe("rejected");
    expect(broken.getState().visualMode).toBe("auto");
  });
});

describe("replay", () => {
  it("rebuilds votes, moods, quest, host visual, and now playing from saved events", async () => {
    const saved: Required<EventRecord>[] = [];
    let t = Date.parse("2026-10-17T00:00:00Z");
    const persist: Persist = async (r) => {
      saved.push({ ...r, time: new Date((t += 1000)) } as Required<EventRecord>);
      return "stored";
    };
    const original = new SessionStore("demo", "Demo", { persist });
    await original.submitVote(vote("track_05", "participant_a1"));
    await original.submitVote(vote("track_05", "participant_b2"));
    await original.submitVote(vote("track_06", "participant_a1"));
    await original.recordMood({ mood: "wild", eventId: randomUUID(), participantId: "participant_a1" });
    await original.recordTaps({ count: 12, eventId: randomUUID(), participantId: "participant_b2" });
    await original.advance();
    await original.setVisual({ theme: "neon_pulse", intensity: 0.9 });
    await original.sampleEnergy(); // metrics only — must be ignored by replay

    const restored = new SessionStore("demo", "Demo");
    restored.replay(saved.filter((r) => r.eventType !== "energy_sample"));
    const a = original.getState();
    const b = restored.getState();
    expect(b.tracks).toEqual(a.tracks);
    expect(b.nowPlaying).toEqual(a.nowPlaying);
    expect(b.moods).toEqual(a.moods);
    expect(b.crowdQuest).toEqual(a.crowdQuest);
    expect(b.visualState).toEqual(a.visualState);
    expect(b.participants).toBe(a.participants);

    // Replayed event IDs are treated as already seen.
    const firstVote = saved[0];
    const again = await restored.submitVote({
      trackId: "track_05",
      eventId: firstVote.eventId,
      participantId: "participant_a1",
    });
    expect(again.status).toBe("duplicate");
  });
});
