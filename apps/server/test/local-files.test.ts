import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type Sessions } from "../src/app.js";
import type { EventRecord } from "../src/db.js";
import type { RecommendationModel } from "../src/gemini.js";
import { SessionStore } from "../src/session.js";

// Local files: songs from the host's laptop are added by their details only (the audio stays on the
// laptop), and can be renamed.

const HOST = { "x-host-key": "k" };
const id = (n: number) => `lf_${String(n).padStart(16, "0")}`;

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
