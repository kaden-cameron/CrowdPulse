import { LOCAL_TRACK_ID, type SessionState } from "@crowdpulse/shared";
import type { PlayableTrack } from "./types";

// What the player page should do, given the server's state and what it's playing right now.
// Pure, so it's easy to test: the server decides what plays; the player only follows.

export type Playing = { trackId: string; round: number } | null;

export type PlayerAction =
  | { type: "none" }
  | { type: "stop" }
  | { type: "play"; trackId: string; round: number; startAtMs: number }
  /** Already playing the right track, but the server doesn't know (e.g. it restarted). */
  | { type: "reannounce" };

/**
 * `ended`: the song (and round) this tab last finished. Until the server hears "ended" it still says
 * that song is playing, so don't start it again — unless it's loading it anew (🔁 Repeat, same round).
 */
export function decide(state: SessionState | null, playing: Playing, now = Date.now(), ended: Playing = null): PlayerAction {
  if (!state) return { type: "none" };
  const np = state.nowPlaying;
  const pb = state.playback;
  if (!np) return playing ? { type: "stop" } : { type: "none" };
  // Paused by the host: keep what's loaded, and don't start anything new until ▶.
  if (pb.status === "paused" && (!playing || playing.trackId !== np.trackId)) return playing ? { type: "stop" } : { type: "none" };

  const round = pb.trackId === np.trackId ? pb.round : (state.tracks.find((t) => t.id === np.trackId)?.round ?? 0);
  if (playing && playing.trackId === np.trackId && playing.round === round) {
    return pb.status === "loading" || pb.status === "idle" ? { type: "reannounce" } : { type: "none" };
  }
  if (ended && ended.trackId === np.trackId && ended.round === round && pb.status !== "loading") {
    return playing ? { type: "stop" } : { type: "none" };
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

/**
 * The track to play: normally from the library; a song cleared from the library while playing is
 * still known from nowPlaying (e.g. Repeat brings it back). Local-file ids are always local.
 */
export function playableTrack(state: SessionState, trackId: string): PlayableTrack | undefined {
  const np = state.nowPlaying;
  const track: PlayableTrack | undefined =
    state.tracks.find((t) => t.id === trackId) ??
    (np && np.trackId === trackId
      ? { id: np.trackId, title: np.title, artist: np.artist, genre: "", bpm: 0, energy: 0, spotifyUri: np.spotifyUri, imageUrl: np.imageUrl }
      : undefined);
  if (track && !track.source && LOCAL_TRACK_ID.test(track.id)) return { ...track, source: "local" };
  return track;
}
