import type { SessionState } from "@crowdpulse/shared";

// What the player page should do, given the server's state and what it's playing right now.
// Pure, so it's easy to test: the server decides what plays; the player only follows.

export type Playing = { trackId: string; round: number } | null;

export type PlayerAction =
  | { type: "none" }
  | { type: "stop" }
  | { type: "play"; trackId: string; round: number; startAtMs: number }
  /** Already playing the right track, but the server doesn't know (e.g. it restarted). */
  | { type: "reannounce" };

export function decide(state: SessionState | null, playing: Playing, now = Date.now()): PlayerAction {
  if (!state) return { type: "none" };
  const np = state.nowPlaying;
  const pb = state.playback;
  if (!np) return playing ? { type: "stop" } : { type: "none" };

  const round = pb.trackId === np.trackId ? pb.round : (state.tracks.find((t) => t.id === np.trackId)?.round ?? 0);
  if (playing && playing.trackId === np.trackId && playing.round === round) {
    return pb.status === "loading" || pb.status === "idle" ? { type: "reannounce" } : { type: "none" };
  }
  // DJ mode: this song already finished (or failed) — wait for the host to pick the next one.
  if (pb.trackId === np.trackId && pb.round === round && (pb.status === "ended" || pb.status === "error")) {
    return playing ? { type: "stop" } : { type: "none" };
  }
  // Join mid-song (e.g. the player page was reloaded): pick up where the server says it is.
  const startAtMs =
    pb.status === "playing" && pb.trackId === np.trackId && pb.round === round && pb.startedAt
      ? Math.max(0, now - Date.parse(pb.startedAt))
      : 0;
  return { type: "play", trackId: np.trackId, round, startAtMs };
}
