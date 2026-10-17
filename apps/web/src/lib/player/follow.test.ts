import { describe, expect, it } from "vitest";
import type { SessionState } from "@crowdpulse/shared";
import { decide } from "./follow";

const NOW = Date.parse("2026-10-17T20:00:00Z");
const base = (over: Partial<SessionState["playback"]> = {}, nowPlaying: string | null = "track_03", round = 1): SessionState =>
  ({
    nowPlaying: nowPlaying ? { trackId: nowPlaying, title: "x", artist: "y", votes: 0, boosts: 0 } : null,
    tracks: [{ id: "track_03", round }, { id: "track_05", round: 0 }],
    playback: { mode: "dj", status: "loading", trackId: nowPlaying, round, startedAt: null, durationMs: null, source: null, playerOnline: true, message: null, ...over },
  }) as unknown as SessionState;

describe("player follow logic", () => {
  it("starts the chosen track from the beginning", () => {
    expect(decide(base(), null, NOW)).toEqual({ type: "play", trackId: "track_03", round: 1, startAtMs: 0 });
  });

  it("does nothing while it is already playing the right track", () => {
    expect(decide(base({ status: "playing", startedAt: new Date(NOW - 5000).toISOString() }), { trackId: "track_03", round: 1 }, NOW)).toEqual({ type: "none" });
  });

  it("re-announces when the server lost track of it (e.g. restarted)", () => {
    expect(decide(base({ status: "loading" }), { trackId: "track_03", round: 1 }, NOW)).toEqual({ type: "reannounce" });
  });

  it("switches when the host picks another track", () => {
    expect(decide(base({}, "track_05", 1), { trackId: "track_03", round: 1 }, NOW)).toMatchObject({ type: "play", trackId: "track_05" });
  });

  it("plays the same track again when it comes round again (new round)", () => {
    expect(decide(base({}, "track_03", 2), { trackId: "track_03", round: 1 }, NOW)).toMatchObject({ type: "play", trackId: "track_03", round: 2 });
  });

  it("picks up mid-song after the player page reloads", () => {
    const s = base({ status: "playing", startedAt: new Date(NOW - 42_000).toISOString(), durationMs: 60_000 });
    expect(decide(s, null, NOW)).toEqual({ type: "play", trackId: "track_03", round: 1, startAtMs: 42_000 });
  });

  it("in DJ mode, doesn't replay a song that already finished", () => {
    expect(decide(base({ status: "ended" }), null, NOW)).toEqual({ type: "none" });
  });

  it("stops when nothing should be playing (new run)", () => {
    expect(decide(base({ status: "idle" }, null), { trackId: "track_03", round: 1 }, NOW)).toEqual({ type: "stop" });
  });
});
