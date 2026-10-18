import { randomUUID } from "node:crypto";
import request from "supertest";
const requestApp = request;
import { describe, expect, it } from "vitest";
import { MAX_VOTES_PER_PERSON } from "@crowdpulse/shared";
import { createApp, type Sessions } from "../src/app.js";
import type { EventRecord } from "../src/db.js";
import { SessionStore } from "../src/session.js";

function setup() {
  const saved: Required<EventRecord>[] = [];
  let n = Date.now();
  const store = new SessionStore("demo", "Demo", {
    persist: async (r) => (saved.push({ ...r, time: new Date((n += 10)) } as Required<EventRecord>), "stored"),
  });
  const sessions: Sessions = new Map([["demo", store]]);
  const { app } = createApp({ sessions, hostKey: "k" });
  const P = "participant_att1";
  const vote = (trackId: string, participantId = P) =>
    request(app).post("/api/sessions/demo/votes").send({ sessionId: "demo", trackId, eventId: randomUUID(), participantId });
  const unvote = (trackId: string, participantId = P) =>
    request(app).post("/api/sessions/demo/votes/retract").send({ sessionId: "demo", trackId, eventId: randomUUID(), participantId });
  const me = (participantId = P) => request(app).get(`/api/sessions/demo/participants/${participantId}`);
  return { store, app, saved, vote, unvote, me, P };
}

describe("attendee votes", () => {
  it("an attendee can take a vote back", async () => {
    const { store, vote, unvote } = setup();
    expect((await vote("track_02")).status).toBe(200);
    expect(store.getState().tracks.find((t) => t.id === "track_02")?.votes).toBe(1);
    expect((await unvote("track_02")).status).toBe(200);
    expect(store.getState().tracks.find((t) => t.id === "track_02")?.votes).toBe(0);
    expect((await unvote("track_02")).body.reason).toBe("No vote to take back");
  });

  it(`each attendee has at most ${MAX_VOTES_PER_PERSON} votes at once; taking one back frees it`, async () => {
    const { vote, unvote, store } = setup();
    for (const id of ["track_01", "track_02", "track_03"]) expect((await vote(id)).status).toBe(200);
    const fourth = await vote("track_04");
    expect(fourth.status).toBe(409);
    expect(fourth.body.reason).toMatch(/used all 3 votes/);
    expect((await vote("track_04", "participant_other")).status).toBe(200); // someone else is fine
    await unvote("track_01");
    expect((await vote("track_04")).status).toBe(200);
    expect(store.getState().maxVotesPerPerson).toBe(MAX_VOTES_PER_PERSON);
  });

  it("a song that plays uses its votes up, freeing them", async () => {
    const { vote, store } = setup();
    for (const id of ["track_01", "track_02", "track_03"]) await vote(id);
    await store.advance("track_01");
    expect((await vote("track_04")).status).toBe(200);
  });

  it("votes and take-backs survive a restart", async () => {
    const { vote, unvote, saved } = setup();
    await vote("track_02");
    await vote("track_03");
    await unvote("track_02");
    const restored = new SessionStore("demo", "Demo");
    restored.replay(saved);
    expect(restored.participantState("participant_att1").votes).toEqual(["track_03"]);
    expect(restored.getState().tracks.find((t) => t.id === "track_02")?.votes).toBe(0);
  });
});

describe("joining: genre and one identity per device", () => {
  it("the genre picked at join is tallied for the host and Gemini", async () => {
    const { app, store } = setup();
    const join = (participantId: string, genre?: string) =>
      request(app)
        .post("/api/sessions/demo/moods")
        .send({ sessionId: "demo", eventId: randomUUID(), participantId, mood: "hyped", ...(genre ? { genre } : {}) });
    expect((await join("participant_g1", "house")).status).toBe(200);
    expect((await join("participant_g2", "house")).status).toBe(200);
    expect((await join("participant_g3")).status).toBe(200); // "Anything"
    expect(store.getState().genres).toEqual({ house: 2 });
    expect((await join("participant_g4", "<b>rock</b>")).status).toBe(400);
  });

  it("a device's own state (joined, genre, votes) comes back on reload, per run", async () => {
    const { app, vote, me, store } = setup();
    expect((await me()).body).toEqual({ run: 1, joined: false, mood: null, genre: null, votes: [] });
    await request(app)
      .post("/api/sessions/demo/moods")
      .send({ sessionId: "demo", eventId: randomUUID(), participantId: "participant_att1", mood: "chill", genre: "lofi" });
    await vote("track_05");
    expect((await me()).body).toEqual({ run: 1, joined: true, mood: "chill", genre: "lofi", votes: ["track_05"] });
    await store.reset();
    expect((await me()).body).toMatchObject({ run: 2, joined: false, votes: [] });
    expect((await request(app).get("/api/sessions/demo/participants/bad!id")).status).toBe(400);
  });
});

describe("Gemini song request (genre + popularity)", () => {
  it("validates the request: genre words, stream range", async () => {
    const { app } = setup();
    const post = (body: object) =>
      requestApp(app).post("/api/host/sessions/demo/recommendations").set("x-host-key", "k").send({ hostTarget: "cool_down", request: body });
    const ok = { prompt: "slow jam", genres: ["r&b"], minStreams: 1_000_000, maxStreams: 500_000_000 };
    expect((await post({ ...ok, genres: ["<b>rock</b>"] })).status).toBe(400);
    expect((await post({ ...ok, minStreams: 10, maxStreams: 5 })).status).toBe(400);
    expect((await post({ ...ok, prompt: "see https://x.y" })).status).toBe(400);
    expect((await post({ ...ok, energy: 50 })).status).toBe(400); // old sliders are gone
  });

  it("limits Gemini's choices to the genre and passes the popularity range", async () => {
    const { buildSummary } = await import("../src/recommendation.js");
    const { store, app } = setup();
    await requestApp(app).post("/api/sessions/demo/moods").send({ sessionId: "demo", eventId: randomUUID(), participantId: "participant_g1", mood: "hyped", genre: "techno" });
    const s = buildSummary(store.getState(), 0, "hold_steady", [], [], { prompt: "", genres: ["house", "techno"], minStreams: 1_000_000, maxStreams: null });
    expect(s.eligible_tracks.map((t) => t.track_id)).toEqual(["track_01", "track_03"]); // the house and techno songs
    expect(s.host_request).toEqual({ description: null, genres: ["house", "techno"], min_streams: 1_000_000, max_streams: null });
    expect(s.crowd_genres).toEqual({ techno: 1 });
  });

  it("doesn't call Gemini when no library song is in the genre", async () => {
    const { RecommendationService } = await import("../src/recommendation.js");
    const { store } = setup();
    let called = false;
    const svc = new RecommendationService(store, { model: "fake", generate: async () => ((called = true), { text: "{}" }) } as never);
    const r = await svc.recommend("hold_steady", { prompt: "", genres: ["polka"], minStreams: null, maxStreams: null });
    expect(called).toBe(false);
    expect("recommendation" in r && r.recommendation.validationErrors[0]).toMatch(/No songs in the library match “polka”/);
  });
});
describe("Find a song from lyrics, and Surprise me", () => {
  const COVER = "https://i.scdn.co/image/ab67616d00001e02e2a0a166493a2bde5480a420";
  const model = (rows: unknown, seen: unknown[] = []) =>
    ({
      model: "fake",
      generate: async (input: { user: string; system: string }) => (
        seen.push({ input: JSON.parse(input.user), surprise: input.system.includes("surprise") }),
        { text: JSON.stringify(rows), responseId: "r", modelVersion: "v", latencyMs: 5, usage: null }
      ),
    }) as never;
  const hit = (title: string) => ({ id: "7tFiyTwD0nx5a1eklYtX2J", title, artist: "A", album: "", spotifyUri: "spotify:track:7tFiyTwD0nx5a1eklYtX2J", durationMs: 1, popularity: 90, imageUrl: null, coverUrl: COVER });
  const spotify = {
    configured: true,
    search: async (q: string) => (q.includes("Made Up") ? [] : [hit(q.match(/track:"([^"]+)"/)?.[1] ?? q)]),
    cover: async () => null,
  };
  const row = (title: string, streams: number) => ({ title, artist: "A", why: "fits", streams, confidence: 0.9 });

  it("Gemini names the song from lyrics; Spotify confirms it; estimates outside the range are dropped", async () => {
    const { findSongs } = await import("../src/songFinder.js");
    const r = await findSongs(
      model([row("Bohemian Rhapsody", 2_500_000_000), row("Made Up Song", 5_000_000), row("Too Small", 1_000), { title: "<script>", artist: "x", why: "bad", streams: 1, confidence: 1 }]),
      spotify,
      { text: "is this the real life, is this just fantasy", minStreams: 1_000_000, maxStreams: null },
    );
    expect(r.songs.map((s) => [s.title, s.streams, s.spotify ? "on spotify" : null])).toEqual([
      ["Bohemian Rhapsody", 2_500_000_000, "on spotify"],
      ["Made Up Song", 5_000_000, null],
    ]);
  });

  it("Find returns as many songs as asked for, Spotify-confirmed first", async () => {
    const { findSongs } = await import("../src/songFinder.js");
    const seen: { input: { count: number } }[] = [];
    const rows = Array.from({ length: 30 }, (_, i) => row(i === 2 ? "Made Up 2" : `Song ${i}`, 10_000_000 + i));
    const r = await findSongs(model(rows, seen), spotify, { text: "2000s pop punk", count: 20 });
    expect(seen[0].input.count).toBe(25); // asks for a few extra
    const found = r.songs.filter((x) => x.spotify);
    expect(found).toHaveLength(20);
    expect(r.songs.at(-1)?.title).toBe("Made Up 2"); // not on Spotify: listed last
  });

  it("Surprise me picks one song at random, favoring more-streamed songs, in the genre", async () => {
    const { findSongs, weightedPick } = await import("../src/songFinder.js");
    const seen: { input: { genres: string[]; exclude: string[] }; surprise: boolean }[] = [];
    const r = await findSongs(model([row("Big Hit", 1_000_000_000), row("Small", 100)], seen), spotify, {
      surprise: true,
      genres: ["house"],
      exclude: ["Old — A"],
      random: () => 0.5,
    });
    expect(r.songs).toHaveLength(1);
    expect(r.songs[0].title).toBe("Big Hit");
    expect(seen[0]).toMatchObject({ surprise: true, input: { genres: ["house"], exclude: ["Old — A"] } });
    // Weighting: over many draws the popular song wins far more often, but not always.
    const items = [{ streams: 1_000_000_000 }, { streams: 1_000_000 }];
    let big = 0;
    for (let i = 0; i < 1000; i++) if (weightedPick(items, () => i / 1000) === items[0]) big++;
    expect(big).toBeGreaterThan(900);
    expect(big).toBeLessThan(1000);
  });

  it("the endpoint is host-only and needs text unless it's a surprise", async () => {
    const { app } = setup();
    expect((await requestApp(app).post("/api/host/sessions/demo/find-songs").send({ text: "hello there", genres: [], minStreams: null, maxStreams: null })).status).toBe(401);
    const post = (body: object) => requestApp(app).post("/api/host/sessions/demo/find-songs").set("x-host-key", "k").send({ genres: [], minStreams: null, maxStreams: null, ...body });
    expect((await post({ text: "x" })).status).toBe(400);
    const surprise = await post({ surprise: true, genres: ["house"] });
    expect(surprise.status).toBe(200);
    expect(surprise.body.note).toMatch(/Gemini isn't configured/);
  });
});
