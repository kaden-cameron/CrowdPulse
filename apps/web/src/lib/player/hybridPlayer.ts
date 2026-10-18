import type { LocalMixer } from "./localMixer";
import type { PlayableTrack, PlayerAdapter, StartedInfo } from "./types";

// The speaker output: local songs play through the mixer on this laptop, Spotify songs through
// Spotify. Only one of them makes sound at a time (Spotify songs can't be mixed — Spotify forbids it).
// Spotify is optional: with local files only, Start audio works without connecting Spotify.

export class HybridPlayer implements PlayerAdapter {
  private active: "spotify" | "local" | null = null;
  private spotifyOn = false;
  /** Why Spotify couldn't start on this device (local files still play). */
  spotifyProblem: string | null = null;

  private spotify: PlayerAdapter;
  readonly local: LocalMixer;
  private spotifyConnected: () => boolean;

  constructor(spotify: PlayerAdapter, local: LocalMixer, spotifyConnected: () => boolean) {
    this.spotify = spotify;
    this.local = local;
    this.spotifyConnected = spotifyConnected;
  }

  async unlock() {
    await this.local.unlock();
    this.spotifyProblem = null;
    if (!this.spotifyConnected()) return;
    try {
      await this.spotify.unlock();
      this.spotifyOn = true;
    } catch (err) {
      this.spotifyOn = false;
      this.spotifyProblem = (err as Error).message;
    }
  }

  async play(track: PlayableTrack, opts?: { startAtMs?: number }): Promise<StartedInfo> {
    if (track.source === "local") {
      if (this.active === "spotify") this.spotify.stop();
      this.active = "local";
      return this.local.play(track, opts);
    }
    if (this.active === "local") this.local.stop();
    if (!this.spotifyOn) {
      throw new Error(this.spotifyProblem ? `Spotify couldn't start here: ${this.spotifyProblem}` : "Spotify isn't connected on this speaker — connect it to play Spotify songs");
    }
    this.active = "spotify";
    return this.spotify.play(track, opts);
  }

  stop() {
    this.local.stop();
    if (this.spotifyOn) this.spotify.stop();
    this.active = null;
  }

  private get now(): PlayerAdapter {
    return this.active === "spotify" ? this.spotify : this.local;
  }

  seek(ms: number) {
    return this.now.seek(ms);
  }
  hold() {
    return this.now.hold();
  }
  unhold() {
    return this.now.unhold();
  }
  setVolume(v: number) {
    this.local.setVolume(v);
    this.spotify.setVolume(v);
  }
  positionMs() {
    return this.now.positionMs();
  }
  onEnded(cb: () => void) {
    this.local.onEnded(cb);
    this.spotify.onEnded(cb);
  }
  onProblem(cb: (message: string) => void) {
    this.spotify.onProblem?.(cb);
  }
}
