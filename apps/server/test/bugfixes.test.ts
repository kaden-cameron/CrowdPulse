import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp, type Sessions } from "../src/app.js";
import type { EventRecord } from "../src/db.js";
import { ParticipantIds } from "../src/participants.js";
import { RateLimiter } from "../src/rateLimit.js";
import { SessionStore } from "../src/session.js";
import type { SpotifySearchClient } from "../src/spotify.js";

// Regression tests for bugs found in the review (one block per bug).

const HOST = { "x-host-key": "k" };
function setup(
  opts: { persist?: (r: EventRecord) => Promise<"stored" | "duplicate">; participantIds?: ParticipantIds; spotifySearch?: SpotifySearchClient; now?: () => number } = {},
) {
  const saved: Required<EventRecord>[] = [];
  let n = Date.now();
  const store = new SessionStore("demo", "Demo", {
    now: opts.now,
    persist: async (r) => {
      const res = opts.persist ? await opts.persist(r) : "stored";
      saved.push({ ...r, time: new Date((n += 10)) } as Required<EventRecord>);
      return res;
    },
  });
  const sessions: Sessions = new Map([["demo", store]]);
  const { app } = createApp({ sessions, hostKey: "k", participantIds: opts.participantIds, spotifySearch: opts.spotifySearch });
  const report = (body: object) => request(app).post("/api/host/sessions/demo/playback/report").set(HOST).send(body);
  return { store, app, saved, report };
}

describe("song end reports", () => {
  it("two 'ended' reports for the same song advance only once", async () => {
    const { store, report } = setup();
    await store.setPlaybackMode("auto");
    await store.setHostQueue(["track_02", "track_03"]);
    await store.advance("track_01");
    // Both reports pass the "is this the current song?" check before either is applied.
    const [a, b] = await Promise.all([
      store.reportPlayback({ event: "ended", trackId: "track_01", round: 1 }),
      store.reportPlayback({ event: "error", trackId: "track_01", round: 1, message: "x" }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["accepted", "duplicate"]);
    expect(store.getState().nowPlaying?.trackId).toBe("track_02");
  });

  it("a host's Play next that gets in first isn't overwritten by the old song's end", async () => {
    const { store, report } = setup();
    await store.setPlaybackMode("auto");
    await store.advance("track_01");
    await Promise.all([store.advance("track_04"), store.reportPlayback({ event: "ended", trackId: "track_01", round: 1 })]);
    expect(store.getState().nowPlaying?.trackId).toBe("track_04");
  });

  it("auto play keeps going when the song playing is first in the queue (it plays again)", async () => {
    const { store, report } = setup();
    await store.setPlaybackMode("auto");
    await store.advance("track_01");
    await store.setHostQueue(["track_01", "track_02"]);
    await report({ event: "ended", trackId: "track_01", round: 1 });
    const s = store.getState();
    expect(s.nowPlaying?.trackId).toBe("track_01");
    expect(s.playback).toMatchObject({ status: "loading", round: 2 });
    expect(s.queue[0].trackId).toBe("track_02");
  });

  it("the tab that finishes loading while paused becomes the speaker", async () => {
    const { store, report } = setup();
    await store.advance("track_01");
    await report({ event: "started", trackId: "track_01", round: 1, playerId: "pl_aaaaaaaa", positionMs: 0 });
    await store.pause();
    await report({ event: "started", trackId: "track_01", round: 1, playerId: "pl_bbbbbbbb", positionMs: 0 });
    expect(store.getState().playback).toMatchObject({ status: "paused", playerId: "pl_bbbbbbbb" });
  });
});

describe("⏮ Previous", () => {
  it("after a song finished (host picks), goes back to the one before", async () => {
    let t = Date.now();
    const { store, report } = setup({ now: () => t });
    await store.advance("track_01");
    await store.advance("track_02");
    await report({ event: "started", trackId: "track_02", round: 1, positionMs: 0, durationMs: 180_000 });
    t += 180_000; // the whole song played
    await report({ event: "ended", trackId: "track_02", round: 1 });
    expect(store.getState().playback.status).toBe("ended");
    const r = await store.previous();
    expect(r.status).toBe("accepted");
    expect(store.getState().nowPlaying?.trackId).toBe("track_01");
  });

  it("history after going back is the same after a restart", async () => {
    const { store, saved } = setup();
    await store.advance("track_01");
    await store.advance("track_02");
    await store.advance("track_03");
    await store.removeTrack("track_02");
    await store.previous(); // back to track_01 (track_02 is gone)
    const restored = new SessionStore("demo", "Demo");
    restored.replay(saved);
    const history = (s: SessionStore) => (s as unknown as { playHistory: string[] }).playHistory;
    expect(history(store)).toEqual([]);
    expect(history(restored)).toEqual(history(store));
  });
});

describe("loading a playlist", () => {
  it("if a later step fails after the library was cleared, every screen is told", async () => {
    let fail = false;
    const { store } = setup({
      persist: async (r) => {
        if (fail && r.eventType === "catalog_add") throw new Error("db down");
        return "stored";
      },
    });
    const saved = await store.savePlaylist({ name: "Mix" });
    await store.removeTrack("track_01");
    fail = true;
    const before = store.getState().version;
    const r = await store.loadPlaylist(saved.playlist!.id, { replace: true, queue: false });
    expect(r.status).toBe("rejected");
    expect(store.getState().version).toBeGreaterThan(before);
  });
});

describe("restart consistency", () => {
  it("an appearance without showEnergy means 'show it' live and after a restart", async () => {
    const { store, saved } = setup();
    await store.setAppearance({ preset: "sky", mode: "light", showEnergy: false });
    await store.setAppearance({ preset: "mint", mode: "dark" } as never);
    const restored = new SessionStore("demo", "Demo");
    restored.replay(saved);
    expect(restored.getState().appearance.showEnergy).toBe(store.getState().appearance.showEnergy);
  });
});

describe("attendee song adds", () => {
  const URI = "spotify:track:4uLU6hMCjMI75M1A2tKUQC";
  it("the library id always comes from the Spotify link, never the client", async () => {
    const { store, app } = setup();
    const r = await request(app).post("/api/sessions/demo/tracks").send({ id: "track_01x", title: "T", artist: "A", spotifyUri: URI });
    expect(r.status).toBe(201);
    expect(store.getState().tracks.some((t) => t.id === "sp_4uLU6hMCjMI75M1A2tKUQC")).toBe(true);
    expect(store.getState().tracks.some((t) => t.id === "sp_track_01x")).toBe(false);
    expect((await request(app).post("/api/sessions/demo/tracks").send({ title: "T", artist: "A", spotifyUri: "not a link" })).status).toBe(400);
  });

  it("uses Spotify's real title and artist when search is set up", async () => {
    const spotifySearch = { configured: true, search: vi.fn(), cover: vi.fn(), track: vi.fn(async () => ({ title: "Real Title", artist: "Real Artist", imageUrl: null })) };
    const { store, app } = setup({ spotifySearch: spotifySearch as unknown as SpotifySearchClient });
    await request(app).post("/api/sessions/demo/tracks").send({ title: "rude words", artist: "x", spotifyUri: URI });
    expect(store.getState().tracks.find((t) => t.id === "sp_4uLU6hMCjMI75M1A2tKUQC")).toMatchObject({ title: "Real Title", artist: "Real Artist" });
  });
});

describe("rate limiter", () => {
  it("forgets idle keys and caps how many it keeps", () => {
    let t = 0;
    const rl = new RateLimiter(5, 1_000, () => t, 100);
    for (let i = 0; i < 500; i++) rl.allow(`k${i}`);
    expect(rl.size).toBeLessThanOrEqual(100);
    t = 5_000;
    rl.allow("fresh");
    expect(rl.size).toBe(1);
  });
});

describe("signed attendee ids", () => {
  it("only ids the server handed out count; made-up ones must rejoin", async () => {
    const ids = new ParticipantIds("secret");
    const { app } = setup({ participantIds: ids });
    const got = await request(app).post("/api/participants").send({});
    const pid = got.body.participantId as string;
    expect(pid).toMatch(/^ps_[0-9a-f]{24}_[0-9a-f]{16}$/);
    expect(ids.valid(pid)).toBe(true);
    expect(ids.valid(pid.replace(/.$/, (c) => (c === "0" ? "1" : "0")))).toBe(false);
    expect(new ParticipantIds("other").valid(pid)).toBe(false);
    const sim = (await request(app).post("/api/participants").send({ simulated: true })).body.participantId as string;
    expect(sim).toMatch(/^sim_/);
    expect(ids.valid(sim)).toBe(true);

    const voteAs = (participantId: string) =>
      request(app).post("/api/sessions/demo/votes").send({ sessionId: "demo", trackId: "track_02", eventId: randomUUID(), participantId });
    const fake = await voteAs("participant_madeup1");
    expect(fake.status).toBe(401);
    expect(fake.body.reason).toMatch(/rejoin/i);
    expect((await voteAs(pid)).status).toBe(200);
  });

  it("one address can only get so many ids", async () => {
    const store = new SessionStore("demo", "Demo");
    const { app } = createApp({ sessions: new Map([["demo", store]]), hostKey: "k", participantIds: new ParticipantIds("s"), participantsPerIpHour: 3 });
    for (let i = 0; i < 3; i++) expect((await request(app).post("/api/participants")).status).toBe(200);
    expect((await request(app).post("/api/participants")).status).toBe(429);
  });
});

describe("validation", () => {
  it("a clip or highlight can't end before it starts", async () => {
    const { store, app, report } = setup();
    await store.advance("track_01");
    expect((await report({ event: "started", trackId: "track_01", round: 1, clipStartMs: 50_000, clipEndMs: 40_000 })).status).toBe(400);
    expect((await request(app).put("/api/host/sessions/demo/highlight/track_01").set(HOST).send({ part: "auto", startMs: 50_000, endMs: 40_000 })).status).toBe(400);
  });
});
