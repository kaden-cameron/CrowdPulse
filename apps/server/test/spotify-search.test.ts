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
