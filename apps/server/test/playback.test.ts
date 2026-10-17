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
