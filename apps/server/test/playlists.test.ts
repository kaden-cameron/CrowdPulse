import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { EventRecord } from "../src/db.js";
import { SessionStore } from "../src/session.js";

const HOST = { "x-host-key": "k" };

function setup() {
  const saved: Required<EventRecord>[] = [];
  let n = Date.now();
  const store = new SessionStore("demo", "Demo", {
    persist: async (r) => (saved.push({ ...r, time: new Date((n += 10)) } as Required<EventRecord>), "stored"),
  });
  const { app } = createApp({ sessions: new Map([["demo", store]]), hostKey: "k" });
  const api = (method: "get" | "post" | "patch" | "delete", path: string, body?: object) => {
    const r = request(app)[method](`/api/host/sessions/demo/playlists${path}`).set(HOST);
    return body ? r.send(body) : r;
  };
  return { store, app, saved, api };
}

describe("saved playlists", () => {
  it("saves the library under a name, lists it, shows its songs", async () => {
    const { api } = setup();
    const r = await api("post", "", { name: "Friday warm-up" });
    expect(r.status).toBe(200);
    expect(r.body.playlist).toMatchObject({ name: "Friday warm-up", count: 7 });
    const list = (await api("get", "")).body.playlists;
    expect(list).toHaveLength(1);
    const detail = (await api("get", `/${list[0].id}`)).body;
    expect(detail.tracks.map((t: { id: string }) => t.id)).toEqual(["track_01", "track_02", "track_03", "track_04", "track_05", "track_06", "track_07"]);
    expect(detail.tracks[0]).toMatchObject({ genre: "house", bpm: 122 }); // details kept: no Gemini on load
  });

  it("renames, updates with the current library, and deletes", async () => {
    const { api, store } = setup();
    const id = (await api("post", "", { name: "A" })).body.playlist.id;
    expect((await api("patch", `/${id}`, { name: "Late night" })).status).toBe(200);
    await store.removeTrack("track_07");
    expect((await api("post", "", { id })).body.playlist).toMatchObject({ name: "Late night", count: 6 });
    expect((await api("delete", `/${id}`)).status).toBe(200);
    expect((await api("get", "")).body.playlists).toEqual([]);
    expect((await api("delete", `/${id}`)).status).toBe(404);
  });

  it("loads a playlist: replace the library (the playing song keeps playing) and queue it in order", async () => {
    const { api, store } = setup();
    await store.removeTrack("track_06");
    await store.removeTrack("track_07");
    const id = (await api("post", "", { name: "Five" })).body.playlist.id; // track_01..05
    await store.advance("track_03");
    await store.clearLibrary();
    expect(store.getState().tracks).toEqual([]);
    const r = await api("post", `/${id}/load`, { replace: true, queue: true });
    expect(r.status).toBe(200);
    expect(store.getState().tracks.map((t) => t.id)).toEqual(["track_01", "track_02", "track_03", "track_04", "track_05"]);
    expect(store.getState().nowPlaying?.trackId).toBe("track_03");
    expect(store.getState().queue.filter((q) => q.hostPick).map((q) => q.trackId)).toEqual(["track_01", "track_02", "track_03", "track_04", "track_05"]);
  });

  it("loads a playlist by adding to the library (no duplicates), and survives a restart", async () => {
    const { api, store, saved } = setup();
    const id = (await api("post", "", { name: "All" })).body.playlist.id;
    await store.clearLibrary();
    await store.addTracks([{ id: "sp_x", title: "X", artist: "Y", genre: "pop", bpm: 100, energy: 0.5 }]);
    const r = await api("post", `/${id}/load`, { replace: false, queue: false });
    expect(r.body.added).toBe(7);
    expect(store.getState().tracks).toHaveLength(8);
    expect((await api("post", `/${id}/load`, {})).body.added).toBe(0);
    const restored = new SessionStore("demo", "Demo");
    restored.replay(saved);
    expect(restored.getState().tracks).toHaveLength(8);
    expect(restored.listPlaylists().map((p) => p.name)).toEqual(["All"]);
  });

  it("is host-only and validated", async () => {
    const { app, api, store } = setup();
    expect((await request(app).get("/api/host/sessions/demo/playlists")).status).toBe(401);
    expect((await api("post", "", { name: "" })).status).toBe(400);
    expect((await api("post", "", { name: "<b>x</b>" })).status).toBe(400);
    expect((await api("post", "", { name: "x".repeat(61) })).status).toBe(400);
    await store.clearLibrary();
    expect((await api("post", "", { name: "Empty" })).body.error).toMatch(/library is empty/);
  });
});
