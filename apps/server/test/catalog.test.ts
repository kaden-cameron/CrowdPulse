import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCatalog, toSpotifyUri } from "../src/catalog.js";
import { SessionStore } from "../src/session.js";

const track = (over: Record<string, unknown> = {}) => ({
  id: "song_1",
  title: "Real Song",
  artist: "Real Artist",
  genre: "house",
  bpm: 124,
  energy: 0.8,
  ...over,
});

describe("catalog file", () => {
  it("loads the example file", () => {
    const tracks = parseCatalog(JSON.parse(readFileSync(new URL("../catalog.example.json", import.meta.url), "utf8")));
    expect(tracks.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts Spotify URIs and share links, normalizing links to URIs", () => {
    const tracks = parseCatalog([
      track({ id: "a", spotifyUri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC" }),
      track({ id: "b", spotifyUri: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc123" }),
    ]);
    expect(tracks.map((t) => t.spotifyUri)).toEqual(["spotify:track:4uLU6hMCjMI75M1A2tKUQC", "spotify:track:4uLU6hMCjMI75M1A2tKUQC"]);
  });

  it("rejects bad input with a readable message", () => {
    expect(() => parseCatalog([track(), track()])).toThrow(/unique/);
    expect(() => parseCatalog([track({ id: "a" }), track({ id: "b", energy: 3 })])).toThrow(/track 1\.energy/);
    expect(() => parseCatalog([track({ id: "a" }), track({ id: "b", spotifyUri: "https://evil.example/track/x" })])).toThrow(/spotifyUri/);
    expect(() => parseCatalog([track({ id: "a" }), track({ id: "b", extra: 1 })])).toThrow();
  });

  it("toSpotifyUri handles regional links and rejects others", () => {
    expect(toSpotifyUri("https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC")).toBe("spotify:track:4uLU6hMCjMI75M1A2tKUQC");
    expect(toSpotifyUri("https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC")).toBeNull();
  });

  it("a session uses the catalog and includes Spotify URIs in state", async () => {
    const store = new SessionStore("demo", "Demo", {
      catalog: parseCatalog([track({ id: "a", spotifyUri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC" }), track({ id: "b", title: "Other" })]),
    });
    expect(store.getState().tracks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(store.getState().tracks[0].spotifyUri).toBe("spotify:track:4uLU6hMCjMI75M1A2tKUQC");
    expect((await store.submitVote({ trackId: "track_01", eventId: crypto.randomUUID(), participantId: "participant_c1" })).status).toBe("rejected");
  });
});
