import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type Sessions } from "../src/app.js";
import type { EventRecord } from "../src/db.js";
import { SessionStore } from "../src/session.js";

type Saved = Required<EventRecord>[];

function persisted() {
  const saved: Saved = [];
  let t = Date.now() - 60_000;
  const store = new SessionStore("demo", "Demo", {
    persist: async (r) => {
      saved.push({ ...r, time: new Date((t += 100)) } as Saved[number]);
      return "stored";
    },
  });
  return { store, saved };
}

describe("demo reset (Doc 08: two runs without manual DB edits)", () => {
  it("clears the run, keeps dedupe, and is saved for replay", async () => {
    const { store, saved } = persisted();
    const v = { trackId: "track_01", eventId: randomUUID(), participantId: "participant_a1" };
    await store.submitVote(v);
    await store.recordMood({ mood: "wild", eventId: randomUUID(), participantId: "participant_a1" });
    await store.setVisual({ theme: "sunset", intensity: 0.7 });
    await store.advance();

    expect((await store.reset()).status).toBe("accepted");
    const s = store.getState();
    expect(s.tracks.every((t) => t.votes === 0)).toBe(true);
    expect(s.nowPlaying).toBeNull();
    expect(s.participants).toBe(0);
    expect(s.visualMode).toBe("auto");
    expect(s.crowdQuest.progress).toBe(0);
    expect(saved.at(-1)?.eventType).toBe("session_reset");

    // A retried event from the previous run is still a duplicate.
    expect((await store.submitVote(v)).status).toBe("duplicate");

    // After a restart, only the events since the reset count.
    await store.submitVote({ trackId: "track_05", eventId: randomUUID(), participantId: "participant_b2" });
    const restored = new SessionStore("demo", "Demo");
    restored.replay(saved);
    expect(restored.getState().tracks.find((t) => t.id === "track_05")?.votes).toBe(1);
    expect(restored.getState().tracks.find((t) => t.id === "track_01")?.votes).toBe(0);
    expect(restored.getState().nowPlaying).toBeNull();
  });

  it("is host-only", async () => {
    const store = new SessionStore("demo", "Demo");
    const sessions: Sessions = new Map([["demo", store]]);
    const { app } = createApp({ sessions, hostKey: "k" });
    await store.submitVote({ trackId: "track_01", eventId: randomUUID(), participantId: "participant_a1" });
    expect((await request(app).post("/api/host/sessions/demo/reset")).status).toBe(401);
    expect(store.getState().tracks[0].votes).toBe(1);
    expect((await request(app).post("/api/host/sessions/demo/reset").set("x-host-key", "k")).status).toBe(200);
    expect(store.getState().tracks[0].votes).toBe(0);
  });
});

describe("demo data label", () => {
  it("counts simulator participants separately so the UI can label them", async () => {
    const store = new SessionStore("demo", "Demo");
    await store.submitVote({ trackId: "track_01", eventId: randomUUID(), participantId: "sim_00000001" });
    await store.submitVote({ trackId: "track_01", eventId: randomUUID(), participantId: "participant_real" });
    expect(store.getState()).toMatchObject({ participants: 2, simulatedParticipants: 1 });
  });
});
