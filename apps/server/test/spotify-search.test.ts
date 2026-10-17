import { describe, expect, it } from "vitest";
import { catalogTrackFromSpotify, createSpotifySearch } from "../src/spotify.js";
import { SessionStore } from "../src/session.js";

describe("Spotify search helpers", () => {
  it("builds a catalog track with a stable id and URI", () => {
    const track = catalogTrackFromSpotify({
      id: "4uLU6hMCjMI75M1A2tKUQC",
      title: "Never Gonna Give You Up",
      artist: "Rick Astley",
      spotifyUri: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc",
      popularity: 80,
    });
    expect(track.id).toBe("sp_4uLU6hMCjMI75M1A2tKUQC");
    expect(track.spotifyUri).toBe("spotify:track:4uLU6hMCjMI75M1A2tKUQC");
    expect(track.genre).toBe("spotify");
    expect(track.energy).toBeGreaterThan(0.3);
    expect(track.energy).toBeLessThanOrEqual(1);
  });

  it("reports unconfigured when the client secret is missing", () => {
    const client = createSpotifySearch("some-client-id", undefined);
    expect(client.configured).toBe(false);
  });

  it("adds a searched track to a live session and lets people vote on it", async () => {
    const store = new SessionStore("demo", "Demo", { catalog: [] });
    expect(store.getState().tracks).toHaveLength(0);

    const track = catalogTrackFromSpotify({
      id: "4uLU6hMCjMI75M1A2tKUQC",
      title: "Never Gonna Give You Up",
      artist: "Rick Astley",
      spotifyUri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
      popularity: 90,
    });
    const added = await store.addTrack(track);
    expect(added.status).toBe("accepted");
    expect(store.getState().tracks.map((t) => t.id)).toEqual([track.id]);

    const again = await store.addTrack(track);
    expect(again.status).toBe("accepted");
    expect(store.getState().tracks).toHaveLength(1);

    const vote = await store.submitVote({
      trackId: track.id,
      eventId: crypto.randomUUID(),
      participantId: "participant_01",
    });
    expect(vote.status).toBe("accepted");
    expect(store.getState().queue[0]?.trackId).toBe(track.id);
  });
});

describe("album covers", () => {
  const COVER = "https://i.scdn.co/image/ab67616d00001e02e2a0a166493a2bde5480a420";

  it("picks the ~300px image and only accepts Spotify's image CDN", async () => {
    const { pickCover } = await import("@crowdpulse/shared");
    expect(
      pickCover([
        { url: "https://i.scdn.co/image/big", width: 640 },
        { url: COVER, width: 300 },
        { url: "https://i.scdn.co/image/small", width: 64 },
      ]),
    ).toBe(COVER);
    expect(pickCover([{ url: "https://evil.example/x.png", width: 300 }])).toBeNull();
    expect(pickCover(undefined)).toBeNull();
  });

  it("stores a valid cover with an added song and drops a bad one", () => {
    const base = { id: "4uLU6hMCjMI75M1A2tKUQC", title: "T", artist: "A", spotifyUri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC" };
    expect(catalogTrackFromSpotify({ ...base, imageUrl: COVER }).imageUrl).toBe(COVER);
    expect(catalogTrackFromSpotify({ ...base, imageUrl: "javascript:alert(1)" }).imageUrl).toBeUndefined();
  });

  it("cover lookup only answers for songs in a session's library", async () => {
    const { default: request } = await import("supertest");
    const { createApp } = await import("../src/app.js");
    const store = new SessionStore("demo", "Demo", { catalog: [] });
    await store.addTrack(catalogTrackFromSpotify({ id: "4uLU6hMCjMI75M1A2tKUQC", title: "T", artist: "A", spotifyUri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC" }));
    const lookups: string[] = [];
    const spotifySearch = {
      configured: true,
      search: async () => [],
      cover: async (id: string) => (lookups.push(id), COVER),
    };
    const { app } = createApp({ sessions: new Map([["demo", store]]), hostKey: "k", spotifySearch });
    const ok = await request(app).get("/api/spotify/cover/4uLU6hMCjMI75M1A2tKUQC");
    expect(ok.body).toEqual({ imageUrl: COVER });
    expect((await request(app).get("/api/spotify/cover/0nj9Bq5sHDiTxSHunhgkFb")).status).toBe(404);
    expect((await request(app).get("/api/spotify/cover/bad")).status).toBe(404);
    expect(lookups).toEqual(["4uLU6hMCjMI75M1A2tKUQC"]);
  });
});
