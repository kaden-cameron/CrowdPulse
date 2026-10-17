// The player contract. CrowdPulse decides what plays (votes, boosts, Gemini, host); a player
// makes sound and reports back. LocalPlayer plays audio files or generated demo tracks on the
// DJ laptop; a Spotify Connect player can implement the same interface later.

export interface PlayableTrack {
  id: string;
  title: string;
  artist: string;
  genre: string;
  bpm: number;
  /** 0–1 */
  energy: number;
  /** Used by the Spotify player; when missing it searches by title + artist. */
  spotifyUri?: string;
  imageUrl?: string;
}

export type PlaybackSource = "file" | "generated" | "spotify";

export interface StartedInfo {
  durationMs: number;
  source: PlaybackSource;
  /** Set when a file couldn't be played and the generated version was used instead. */
  note?: string;
  /** Album cover of what's actually playing (Spotify reports it). */
  imageUrl?: string;
}

export interface PlayerAdapter {
  /** Must run inside a click/tap handler: browsers only allow audio after a user gesture. */
  unlock(): Promise<void>;
  /** Crossfades from whatever is playing into this track. */
  play(track: PlayableTrack, opts?: { startAtMs?: number }): Promise<StartedInfo>;
  stop(): void;
  /** Jump within the current song (the host moved the position). */
  seek(ms: number): Promise<void>;
  setVolume(v: number): void;
  positionMs(): number;
  /** Called once when the current track finishes on its own (not when stopped or replaced). */
  onEnded(cb: () => void): void;
}

/**
 * The player itself can't play anything right now (not connected, no Premium, login expired).
 * Not the song's fault, so it isn't reported to the server as a failed song — otherwise auto mode
 * would skip through the whole library.
 */
export class PlayerUnavailableError extends Error {
  readonly playerUnavailable = true;
}
