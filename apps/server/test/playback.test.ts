import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type Sessions } from "../src/app.js";
import type { EventRecord } from "../src/db.js";
import { SessionStore } from "../src/session.js";

const HOST = { "x-host-key": "k" };
function setup(now = () => Date.now()) {
  const store = new SessionStore("demo", "Demo", { now });
  const sessions: Sessions = new Map([["demo", store]]);
  const { app } = createApp({ sessions, hostKey: "k", now });
  const report = (body: object) => request(app).post("/api/host/sessions/demo/playback/report").set(HOST).send(body);
  const mode = (m: string) => request(app).post("/api/host/sessions/demo/playback/mode").set(HOST).send({ mode: m });
  return { store, app, report, mode };
}
const vote = (s: SessionStore, trackId: string, who = "participant_p1") =>
  s.submitVote({ trackId, eventId: randomUUID(), participantId: who });

describe("playback", () => {
  it("a chosen track is 'loading' until the player reports it started", async () => {
    const { store, report } = setup();
    await store.advance("track_03");
    expect(store.getState().playback).toMatchObject({ status: "loading", trackId: "track_03", round: 1, mode: "dj", playerOnline: false });
    const r = await report({ event: "started", trackId: "track_03", round: 1, durationMs: 90_000, positionMs: 0, source: "generated" });
    expect(r.status).toBe(200);
    expect(store.getState().playback).toMatchObject({ status: "playing", durationMs: 90_000, source: "generated", playerOnline: true });
  });

  it("DJ mode: when a song ends nothing else starts until the host picks", async () => {
    const { store, report } = setup();
    await vote(store, "track_05");
    await store.advance("track_03");
    await report({ event: "ended", trackId: "track_03", round: 1 });
    const s = store.getState();
    expect(s.nowPlaying?.trackId).toBe("track_03");
    expect(s.playback.status).toBe("ended");
    expect(s.queue[0].trackId).toBe("track_05");
  });

  it("auto mode: when a song ends the top-voted track starts", async () => {
    const { store, report, mode } = setup();
    expect((await mode("auto")).status).toBe(200);
    await vote(store, "track_05");
    await store.advance("track_03");
    await report({ event: "ended", trackId: "track_03", round: 1 });
    expect(store.getState().nowPlaying?.trackId).toBe("track_05");
    expect(store.getState().playback).toMatchObject({ status: "loading", trackId: "track_05" });
  });

  it("auto mode with an empty queue plays the least-recently-played track", async () => {
    const { store, report, mode } = setup();
    await mode("auto");
    await store.advance("track_01");
    await report({ event: "ended", trackId: "track_01", round: 1 });
    expect(store.getState().nowPlaying?.trackId).toBe("track_02"); // never played, first in catalog
  });

  it("a song can only end once: duplicate or stale reports are ignored", async () => {
    const { store, report, mode } = setup();
    await mode("auto");
    await vote(store, "track_05");
    await vote(store, "track_06", "participant_p2");
    await store.advance("track_03");
    await report({ event: "ended", trackId: "track_03", round: 1 }); // → track_05
    const again = await report({ event: "ended", trackId: "track_03", round: 1 }); // second player tab
    expect(again.status).toBe(409);
    expect(store.getState().nowPlaying?.trackId).toBe("track_05"); // not skipped to track_06
  });

  it("a player error in DJ mode shows on the host page", async () => {
    const { store, report } = setup();
    await store.advance("track_02");
    await report({ event: "error", trackId: "track_02", round: 1, message: "decode failed" });
    expect(store.getState().playback).toMatchObject({ status: "error", message: "decode failed" });
  });

  it("player reports and mode changes are host-only and validated", async () => {
    const { app } = setup();
    expect((await request(app).post("/api/host/sessions/demo/playback/report").send({ event: "ended", trackId: "track_01", round: 1 })).status).toBe(401);
    expect((await request(app).post("/api/host/sessions/demo/playback/mode").send({ mode: "auto" })).status).toBe(401);
    expect((await request(app).post("/api/host/sessions/demo/playback/mode").set(HOST).send({ mode: "shuffle" })).status).toBe(400);
  });

  it("the player shows as offline 15s after its last report", async () => {
    let t = Date.now();
    const { store, report } = setup(() => t);
    await store.advance("track_03");
    await report({ event: "started", trackId: "track_03", round: 1, durationMs: 60_000 });
    expect(store.getState().playback.playerOnline).toBe(true);
    t += 16_000;
    expect(store.tick()).toBe(true); // broadcast the change
    expect(store.getState().playback.playerOnline).toBe(false);
  });

  it("the mode survives a restart (replay)", async () => {
    const saved: Required<EventRecord>[] = [];
    let n = Date.now();
    const store = new SessionStore("demo", "Demo", {
      persist: async (r) => (saved.push({ ...r, time: new Date((n += 10)) } as Required<EventRecord>), "stored"),
    });
    await store.setPlaybackMode("auto");
    const restored = new SessionStore("demo", "Demo");
    restored.replay(saved);
    expect(restored.getState().playback.mode).toBe("auto");
  });
});

describe("host queue, skip, seek, clear", () => {
  it("the host's queue plays first, in order, before voted songs", async () => {
    const { store, app } = setup();
    await vote(store, "track_05");
    const r = await request(app).put("/api/host/sessions/demo/queue").set(HOST).send({ trackIds: ["track_03", "track_01"] });
    expect(r.status).toBe(200);
    expect(store.getState().queue.map((q) => [q.trackId, !!q.hostPick])).toEqual([
      ["track_03", true],
      ["track_01", true],
      ["track_05", false],
    ]);
    await store.advance(); // Skip
    expect(store.getState().nowPlaying?.trackId).toBe("track_03");
    expect(store.getState().queue[0].trackId).toBe("track_01"); // played pick leaves the queue
  });

  it("Skip works with no votes and no queue (least recently played song)", async () => {
    const { store, app } = setup();
    await store.advance("track_01");
    const r = await request(app).post("/api/host/sessions/demo/advance").set(HOST).send({});
    expect(r.status).toBe(200);
    expect(store.getState().nowPlaying?.trackId).toBe("track_02");
  });

  it("the queue is host-only, validated, and survives a restart", async () => {
    const saved: Required<EventRecord>[] = [];
    let n = Date.now();
    const store = new SessionStore("demo", "Demo", {
      persist: async (r) => (saved.push({ ...r, time: new Date((n += 10)) } as Required<EventRecord>), "stored"),
    });
    const { app } = createApp({ sessions: new Map([["demo", store]]), hostKey: "k" });
    expect((await request(app).put("/api/host/sessions/demo/queue").send({ trackIds: [] })).status).toBe(401);
    expect((await request(app).put("/api/host/sessions/demo/queue").set(HOST).send({ trackIds: ["nope"] })).status).toBe(400);
    await request(app).put("/api/host/sessions/demo/queue").set(HOST).send({ trackIds: ["track_04", "track_02", "track_04"] });
    const restored = new SessionStore("demo", "Demo");
    restored.replay(saved);
    expect(restored.getState().queue.filter((q) => q.hostPick).map((q) => q.trackId)).toEqual(["track_04", "track_02"]);
  });

  it("Clear library removes every song — the playing one keeps playing to its end — and replays", async () => {
    const saved: Required<EventRecord>[] = [];
    let n = Date.now();
    const store = new SessionStore("demo", "Demo", {
      persist: async (r) => (saved.push({ ...r, time: new Date((n += 10)) } as Required<EventRecord>), "stored"),
    });
    const { app } = createApp({ sessions: new Map([["demo", store]]), hostKey: "k" });
    await store.advance("track_03");
    const r = await request(app).delete("/api/host/sessions/demo/library").set(HOST);
    expect(r.status).toBe(200);
    expect(store.getState().tracks).toEqual([]);
    expect(store.getState().nowPlaying?.trackId).toBe("track_03"); // still playing
    // The player's reports for it still count (its play round is kept).
    expect((await request(app).post("/api/host/sessions/demo/playback/report").set(HOST).send({ event: "started", trackId: "track_03", round: 1, durationMs: 100_000 })).status).toBe(200);
    expect((await request(app).post("/api/host/sessions/demo/playback/report").set(HOST).send({ event: "ended", trackId: "track_03", round: 1 })).status).toBe(200);
    expect((await request(app).delete("/api/host/sessions/demo/library").set(HOST)).status).toBe(409);
    const restored = new SessionStore("demo", "Demo");
    restored.replay(saved);
    expect(restored.getState().tracks).toEqual([]);
    expect(restored.getState().nowPlaying?.trackId).toBe("track_03");
  });

  it("seek moves the song position and bumps seekSeq; progress reports don't undo it", async () => {
    let t = Date.now();
    const { store, app, report } = setup(() => t);
    await store.advance("track_03");
    await report({ event: "started", trackId: "track_03", round: 1, durationMs: 200_000, positionMs: 0 });
    const r = await request(app).post("/api/host/sessions/demo/playback/seek").set(HOST).send({ positionMs: 90_000 });
    expect(r.status).toBe(200);
    const pb = store.getState().playback;
    expect(pb.seekSeq).toBe(1);
    expect(t - Date.parse(pb.startedAt!)).toBe(90_000);
    t += 1_000;
    await report({ event: "progress", trackId: "track_03", round: 1, positionMs: 6_000 }); // player hasn't jumped yet
    expect(t - Date.parse(store.getState().playback.startedAt!)).toBe(91_000);
  });

  it("seek is refused when nothing is playing", async () => {
    const { app } = setup();
    expect((await request(app).post("/api/host/sessions/demo/playback/seek").set(HOST).send({ positionMs: 1000 })).status).toBe(409);
  });

  it("auto mode stops skipping after 3 songs in a row fail (no endless cycling)", async () => {
    const { store, report, mode } = setup();
    await mode("auto");
    await store.advance("track_01");
    for (let i = 0; i < 3; i++) {
      const np = store.getState().playback;
      await report({ event: "error", trackId: np.trackId, round: np.round, message: "not found on Spotify" });
    }
    const pb = store.getState().playback;
    expect(pb.status).toBe("error");
    expect(pb.message).toMatch(/Auto play paused: 3 songs in a row/);
  });
});

describe("one speaker at a time", () => {
  it("the tab that last started the song is the player; the other tab's reports are ignored", async () => {
    const { store, report } = setup();
    await store.advance("track_03");
    await report({ event: "started", trackId: "track_03", round: 1, durationMs: 200_000, playerId: "pl_tabA" });
    expect(store.getState().playback.playerId).toBe("pl_tabA");
    // A second tab presses Start audio: it takes over.
    await report({ event: "started", trackId: "track_03", round: 1, durationMs: 200_000, playerId: "pl_tabB" });
    expect(store.getState().playback.playerId).toBe("pl_tabB");
    // The old tab's "ended"/"error" can no longer skip the song.
    expect((await report({ event: "ended", trackId: "track_03", round: 1, playerId: "pl_tabA" })).status).toBe(409);
    expect(store.getState().playback.status).toBe("playing");
    expect((await report({ event: "ended", trackId: "track_03", round: 1, playerId: "pl_tabB" })).status).toBe(200);
  });
});

describe("⏸ pause, ▶ resume, ⏮ previous", () => {
  it("pause holds the position; progress reports don't undo it; resume carries on from there", async () => {
    let t = Date.now();
    const { store, app, report } = setup(() => t);
    await store.advance("track_03");
    await report({ event: "started", trackId: "track_03", round: 1, durationMs: 200_000, positionMs: 0 });
    t += 30_000;
    expect((await request(app).post("/api/host/sessions/demo/playback/pause").set(HOST)).status).toBe(200);
    expect(store.getState().playback).toMatchObject({ status: "paused", pausedPositionMs: 30_000 });
    t += 60_000; // a minute paused
    await report({ event: "progress", trackId: "track_03", round: 1, positionMs: 30_000 });
    expect((await report({ event: "ended", trackId: "track_03", round: 1 })).body.status).toBe("duplicate"); // ignored while paused
    expect(store.getState().playback.status).toBe("paused");
    const seq = store.getState().playback.seekSeq;
    expect((await request(app).post("/api/host/sessions/demo/playback/resume").set(HOST)).status).toBe(200);
    const pb = store.getState().playback;
    expect(pb).toMatchObject({ status: "playing", pausedPositionMs: null, seekSeq: seq + 1 });
    expect(t - Date.parse(pb.startedAt!)).toBe(30_000);
    expect((await request(app).post("/api/host/sessions/demo/playback/resume").set(HOST)).status).toBe(409);
  });

  it("previous: early in a song goes back a song, and Skip returns to the one we left", async () => {
    let t = Date.now();
    const { store, app, report } = setup(() => t);
    await store.advance("track_01");
    await store.advance("track_02");
    await report({ event: "started", trackId: "track_02", round: 1, durationMs: 200_000, positionMs: 0 });
    t += 2_000;
    expect((await request(app).post("/api/host/sessions/demo/previous").set(HOST)).status).toBe(200);
    expect(store.getState().nowPlaying?.trackId).toBe("track_01");
    expect(store.getState().queue[0]).toMatchObject({ trackId: "track_02", hostPick: true });
    await store.advance(); // ⏭
    expect(store.getState().nowPlaying?.trackId).toBe("track_02");
  });

  it("previous: more than 5 s in restarts the song", async () => {
    let t = Date.now();
    const { store, app, report } = setup(() => t);
    await store.advance("track_01");
    await store.advance("track_02");
    await report({ event: "started", trackId: "track_02", round: 1, durationMs: 200_000, positionMs: 0 });
    t += 40_000;
    await request(app).post("/api/host/sessions/demo/previous").set(HOST);
    expect(store.getState().nowPlaying?.trackId).toBe("track_02");
    expect(Date.parse(store.getState().playback.startedAt!)).toBe(t);
  });

  it("previous survives a restart (replay)", async () => {
    const saved: Required<EventRecord>[] = [];
    let n = Date.now();
    const store = new SessionStore("demo", "Demo", {
      persist: async (r) => (saved.push({ ...r, time: new Date((n += 10)) } as Required<EventRecord>), "stored"),
    });
    await store.advance("track_01");
    await store.advance("track_02");
    await store.previous();
    const restored = new SessionStore("demo", "Demo");
    restored.replay(saved);
    expect(restored.getState().nowPlaying?.trackId).toBe("track_01");
    expect(restored.getState().queue[0]?.trackId).toBe("track_02");
  });

  it("the host can hide crowd energy for everyone, and it survives a restart", async () => {
    const saved: Required<EventRecord>[] = [];
    let n = Date.now();
    const store = new SessionStore("demo", "Demo", {
      persist: async (r) => (saved.push({ ...r, time: new Date((n += 10)) } as Required<EventRecord>), "stored"),
    });
    const { app } = createApp({ sessions: new Map([["demo", store]]), hostKey: "k" });
    expect(store.getState().appearance.showEnergy).toBe(true);
    await request(app).post("/api/host/sessions/demo/appearance").set(HOST).send({ preset: "mint", mode: "dark", showEnergy: false });
    expect(store.getState().appearance).toEqual({ preset: "mint", mode: "dark", showEnergy: false });
    const restored = new SessionStore("demo", "Demo");
    restored.replay(saved);
    expect(restored.getState().appearance.showEnergy).toBe(false);
  });
});

describe("🔁 repeat", () => {
  it("a finished song starts again (same song, same round); off again moves on", async () => {
    const { store, app, report, mode } = setup();
    await mode("auto");
    await vote(store, "track_05");
    await store.advance("track_03");
    expect((await request(app).post("/api/host/sessions/demo/playback/repeat").set(HOST).send({ repeat: true })).status).toBe(200);
    expect(store.getState().playback.repeat).toBe(true);
    await report({ event: "started", trackId: "track_03", round: 1, durationMs: 200_000 });
    await report({ event: "ended", trackId: "track_03", round: 1 });
    expect(store.getState().nowPlaying?.trackId).toBe("track_03");
    expect(store.getState().playback).toMatchObject({ status: "loading", trackId: "track_03", round: 1 });
    await report({ event: "started", trackId: "track_03", round: 1, durationMs: 200_000 });
    await request(app).post("/api/host/sessions/demo/playback/repeat").set(HOST).send({ repeat: false });
    await report({ event: "ended", trackId: "track_03", round: 1 });
    expect(store.getState().nowPlaying?.trackId).toBe("track_05");
  });

  it("repeat is host-only, validated, and survives a restart", async () => {
    const saved: Required<EventRecord>[] = [];
    let n = Date.now();
    const store = new SessionStore("demo", "Demo", {
      persist: async (r) => (saved.push({ ...r, time: new Date((n += 10)) } as Required<EventRecord>), "stored"),
    });
    const { app } = createApp({ sessions: new Map([["demo", store]]), hostKey: "k" });
    expect((await request(app).post("/api/host/sessions/demo/playback/repeat").send({ repeat: true })).status).toBe(401);
    expect((await request(app).post("/api/host/sessions/demo/playback/repeat").set(HOST).send({ repeat: "yes" })).status).toBe(400);
    await request(app).post("/api/host/sessions/demo/playback/repeat").set(HOST).send({ repeat: true });
    const restored = new SessionStore("demo", "Demo");
    restored.replay(saved);
    expect(restored.getState().playback.repeat).toBe(true);
  });
});

describe("auto entries when the queue is empty", () => {
  it("shows the next 5 songs auto play would pick, in the order it picks them", async () => {
    const { store, report, mode } = setup();
    await mode("auto");
    await store.advance("track_01");
    const predicted = store.getState().autoNext.map((q) => q.trackId);
    expect(predicted).toEqual(["track_02", "track_03", "track_04", "track_05", "track_06"]);
    // Auto play really does pick them in that order.
    const played: string[] = [];
    for (let i = 0; i < 5; i++) {
      const pb = store.getState().playback;
      await report({ event: "ended", trackId: pb.trackId, round: pb.round });
      played.push(store.getState().nowPlaying!.trackId);
    }
    expect(played).toEqual(predicted);
  });

  it("disappears as soon as anything is queued or voted for", async () => {
    const { store } = setup();
    expect(store.getState().autoNext).toHaveLength(5);
    await vote(store, "track_07");
    expect(store.getState().autoNext).toEqual([]);
  });
});
