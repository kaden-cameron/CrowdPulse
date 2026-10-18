import request from "supertest";
import { describe, expect, it } from "vitest";
import type { TrackAnalysis } from "@crowdpulse/shared";
import { createApp, type Sessions } from "../src/app.js";
import type { EventRecord } from "../src/db.js";
import type { RecommendationModel } from "../src/gemini.js";
import { SessionStore } from "../src/session.js";

// Local files + the AI DJ: local songs are added by their details only, the speaker's measurements
// are saved, a mix hands the next song over early, and auto play favors songs that mix well.

const HOST = { "x-host-key": "k" };
const id = (n: number) => `lf_${String(n).padStart(16, "0")}`;
const analysis = (bpm: number, key: string | null, extra: Partial<TrackAnalysis> = {}): TrackAnalysis => ({
  bpm,
  beatMs: 200,
  key,
  gainDb: -2,
  mixInMs: 200,
  mixOutMs: 150_000,
  durationMs: 200_000,
  ...extra,
});

function setup(model?: RecommendationModel) {
  const saved: Required<EventRecord>[] = [];
  let n = Date.now();
  const store = new SessionStore("demo", "Demo", {
    catalog: [],
    persist: async (r) => (saved.push({ ...r, time: new Date((n += 10)) } as Required<EventRecord>), "stored"),
  });
  const sessions: Sessions = new Map([["demo", store]]);
  const { app } = createApp({ sessions, hostKey: "k", trackEstimator: model });
  const post = (path: string, body: object) => request(app).post(`/api/host/sessions/demo${path}`).set(HOST).send(body);
  const put = (path: string, body: object) => request(app).put(`/api/host/sessions/demo${path}`).set(HOST).send(body);
  const addLocal = (count: number) =>
    post("/local-tracks", { tracks: Array.from({ length: count }, (_, i) => ({ id: id(i + 1), title: `Song ${i + 1}`, artist: "DJ", genre: "house" })) });
  return { store, app, saved, post, put, addLocal };
}

describe("local files", () => {
  it("adds local songs by their details only (host-only, validated, no duplicates)", async () => {
    const { store, app, addLocal, post } = setup();
    expect((await request(app).post("/api/host/sessions/demo/local-tracks").send({ tracks: [{ id: id(1), title: "A", artist: "B" }] })).status).toBe(401);
    expect((await post("/local-tracks", { tracks: [{ id: "not-a-local-id", title: "A", artist: "B" }] })).status).toBe(400);
    expect((await post("/local-tracks", { tracks: [{ id: id(1), title: "A", artist: "B", url: "file:///x" }] })).status).toBe(400);
    const r = await addLocal(2);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ added: 2, skipped: 0, trackIds: [id(1), id(2)] });
    expect(store.getState().tracks[0]).toMatchObject({ id: id(1), title: "Song 1", source: "local", genre: "house" });
    expect(store.getState().tracks[0].spotifyUri).toBeUndefined();
    expect((await addLocal(3)).body).toMatchObject({ added: 1, skipped: 2 });
  });

  it("saves the speaker's measurements (BPM from the audio) and keeps them after a restart", async () => {
    const { store, put, addLocal, saved } = setup();
    await addLocal(1);
    expect((await put(`/analysis/${id(1)}`, { ...analysis(124.5, "8A"), extra: 1 })).status).toBe(400);
    expect((await put(`/analysis/${id(1)}`, { ...analysis(124.5, "8A"), key: "13A" })).status).toBe(400);
    expect((await put(`/analysis/${id(9)}`, analysis(124.5, "8A"))).status).toBe(404);
    expect((await put(`/analysis/${id(1)}`, analysis(124.5, "8A"))).status).toBe(200);
    expect(store.getState().tracks[0]).toMatchObject({ bpm: 125, analysis: { bpm: 124.5, key: "8A", mixOutMs: 150_000 } });
    const restored = new SessionStore("demo", "Demo", { catalog: [] });
    restored.replay(saved);
    expect(restored.getState().tracks[0].analysis).toEqual(analysis(124.5, "8A"));
  });
});

describe("renaming local songs", () => {
  it("renames title and artist (local songs only, validated) and keeps it after a restart; the id stays", async () => {
    const { store, app, addLocal, saved } = setup();
    await addLocal(2);
    await store.advance(id(1));
    const patch = (trackId: string, body: object) => request(app).patch(`/api/host/sessions/demo/library/${trackId}`).set(HOST).send(body);
    expect((await request(app).patch(`/api/host/sessions/demo/library/${id(1)}`).send({ title: "A", artist: "B" })).status).toBe(401);
    expect((await patch(id(1), { title: " ", artist: "B" })).status).toBe(400);
    expect((await patch(id(9), { title: "A", artist: "B" })).status).toBe(404);
    const r = await patch(id(1), { title: "Sunrise", artist: "DJ Gator" });
    expect(r.status).toBe(200);
    expect(store.getState().tracks[0]).toMatchObject({ id: id(1), title: "Sunrise", artist: "DJ Gator", source: "local" });
    // The song playing shows the new name too.
    expect(store.getState().nowPlaying).toMatchObject({ trackId: id(1), title: "Sunrise", artist: "DJ Gator" });
    const restored = new SessionStore("demo", "Demo", { catalog: [] });
    restored.replay(saved);
    expect(restored.getState().tracks[0]).toMatchObject({ title: "Sunrise", artist: "DJ Gator" });
  });

  it("Spotify songs can't be renamed", async () => {
    const store = new SessionStore("demo", "Demo");
    const { app } = createApp({ sessions: new Map([["demo", store]]), hostKey: "k" });
    const r = await request(app).patch("/api/host/sessions/demo/library/track_01").set(HOST).send({ title: "A", artist: "B" });
    expect(r.status).toBe(409);
  });
});

describe("AI DJ", () => {
  it("mix settings are validated, broadcast and saved", async () => {
    const { store, post, saved } = setup();
    expect(store.getState().playback.mix).toEqual({ enabled: false, style: "auto", bars: 16 });
    expect((await post("/playback/mix", { enabled: true, style: "spin", bars: 16 })).status).toBe(400);
    expect((await post("/playback/mix", { enabled: true, style: "blend", bars: 12 })).status).toBe(400);
    expect((await post("/playback/mix", { enabled: true, style: "echo", bars: 32 })).status).toBe(200);
    expect(store.getState().playback.mix).toEqual({ enabled: true, style: "echo", bars: 32 });
    const restored = new SessionStore("demo", "Demo", { catalog: [] });
    restored.replay(saved);
    expect(restored.getState().playback.mix).toEqual({ enabled: true, style: "echo", bars: 32 });
  });

  it("when the speaker starts mixing, the song it mixes into becomes 'now playing' right away", async () => {
    const { store, post, addLocal } = setup();
    await addLocal(3);
    await post("/playback/mode", { mode: "auto" });
    await post("/playback/mix", { enabled: true, style: "auto", bars: 16 });
    await store.advance(id(1));
    await post("/playback/report", { event: "started", trackId: id(1), round: 1, positionMs: 0, durationMs: 200_000, source: "file" });
    const r = await post("/playback/report", { event: "ended", trackId: id(1), round: 1, nextTrackId: id(3) });
    expect(r.status).toBe(200);
    expect(r.body.nowPlaying.trackId).toBe(id(3));
    expect(r.body.playback).toMatchObject({ trackId: id(3), round: 1, status: "loading" });
    // The speaker then reports it started (already ~0.5 s in).
    await post("/playback/report", { event: "started", trackId: id(3), round: 1, positionMs: 500, durationMs: 200_000, source: "file" });
    expect(store.getState().playback.status).toBe("playing");
  });

  it("without the AI DJ on, a 'next song' hint is ignored and auto play picks as usual", async () => {
    const { store, post, addLocal } = setup();
    await addLocal(3);
    await post("/playback/mode", { mode: "auto" });
    await store.advance(id(1));
    await post("/playback/report", { event: "ended", trackId: id(1), round: 1, nextTrackId: id(3) });
    expect(store.getState().nowPlaying?.trackId).toBe(id(2));
  });

  it("auto play favors the song that mixes best with the one playing", async () => {
    const { store, post, put, addLocal } = setup();
    await addLocal(4);
    await put(`/analysis/${id(1)}`, analysis(124, "8A"));
    await put(`/analysis/${id(2)}`, analysis(90, "3B")); // next in line, but far off in tempo and key
    await put(`/analysis/${id(3)}`, analysis(150, "1A"));
    await put(`/analysis/${id(4)}`, analysis(125, "9A")); // fits
    await store.advance(id(1));
    expect(store.getState().autoNext[0].trackId).toBe(id(2));
    await post("/playback/mix", { enabled: true, style: "auto", bars: 16 });
    const next = store.getState().autoNext.map((q) => q.trackId);
    expect(next[0]).toBe(id(4));
    expect(next).toHaveLength(3);
  });

  it("transition: Gemini picks from the styles that can work; rules when it can't", async () => {
    const answers: string[] = [];
    const model: RecommendationModel = {
      model: "fake",
      generate: async ({ user }) => {
        answers.push(user);
        const req = JSON.parse(user);
        if (req.current) return { text: JSON.stringify({ style: req.allowed.includes("blend") ? "filter" : "blend", reason: "Keys clash a little" }), latencyMs: 5 };
        return { text: "[]", latencyMs: 5 };
      },
    } as RecommendationModel;
    const { post, put, addLocal } = setup(model);
    await addLocal(3);
    expect((await post("/transition", { fromId: id(1), toId: id(2) })).status).toBe(404); // not measured yet
    await put(`/analysis/${id(1)}`, analysis(124, "8A"));
    await put(`/analysis/${id(2)}`, analysis(126, "3B"));
    await put(`/analysis/${id(3)}`, analysis(174, "8A"));
    const near = await post("/transition", { fromId: id(1), toId: id(2) });
    expect(near.body).toEqual({ style: "filter", reason: "Keys clash a little", source: "gemini" });
    // 124 → 174 BPM can't blend; Gemini answering "blend" anyway falls back to the rules (echo out).
    const far = await post("/transition", { fromId: id(1), toId: id(3) });
    expect(far.body).toMatchObject({ style: "echo", source: "rules" });
    expect(JSON.parse(answers.at(-1)!).allowed).toEqual(["echo", "cut"]);
  });
});
