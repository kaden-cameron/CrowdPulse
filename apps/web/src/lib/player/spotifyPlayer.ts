import { pickCover } from "@crowdpulse/shared";
import { PlayerUnavailableError, type PlayableTrack, type PlayerAdapter, type StartedInfo } from "./types";

// Spotify player: this browser tab becomes a Spotify Connect device ("CrowdPulse") via the Web
// Playback SDK, and the Web API starts tracks on it. Needs Spotify Premium on the signed-in account.
// Per Spotify's rules we don't crossfade or mix — tracks just change.

const SDK_URL = "https://sdk.scdn.co/spotify-player.js";
const API = "https://api.spotify.com/v1";
const READY_TIMEOUT_MS = 12_000;
const START_TIMEOUT_MS = 10_000;

/* Minimal typings for the parts of the Web Playback SDK we use. */
interface SdkTrack {
  uri: string;
  duration_ms?: number;
  linked_from?: { uri: string | null };
  album?: { images?: { url: string; width?: number | null }[] };
}
export interface SdkState {
  paused: boolean;
  position: number;
  duration: number;
  track_window: { current_track: SdkTrack | null; previous_tracks: SdkTrack[] };
}
interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: string, cb: (arg: never) => void): void;
  pause(): Promise<void>;
  setVolume(v: number): Promise<void>;
  activateElement?(): Promise<void>;
}
export interface SpotifySdk {
  Player: new (opts: { name: string; getOAuthToken: (cb: (token: string) => void) => void; volume: number }) => SdkPlayer;
}

declare global {
  interface Window {
    Spotify?: SpotifySdk;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

let sdkPromise: Promise<SpotifySdk> | null = null;
export function loadSpotifySdk(): Promise<SpotifySdk> {
  if (window.Spotify) return Promise.resolve(window.Spotify);
  sdkPromise ??= new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve(window.Spotify!);
    const s = document.createElement("script");
    s.src = SDK_URL;
    s.async = true;
    s.onerror = () => {
      sdkPromise = null;
      reject(new Error("Couldn't load the Spotify player (network or blocker)"));
    };
    document.head.appendChild(s);
  });
  return sdkPromise;
}

const ERROR_TEXT: Record<string, string> = {
  initialization_error: "This browser can't run the Spotify player (try Chrome, Edge or Firefox on a laptop)",
  authentication_error: "Spotify login expired or is missing permissions — connect Spotify again",
  account_error: "Spotify Premium is required to play through CrowdPulse",
  playback_error: "Spotify couldn't play this track",
};

const sameTrack = (t: SdkTrack | null | undefined, uri: string) => !!t && (t.uri === uri || t.linked_from?.uri === uri);

export class SpotifyPlayer implements PlayerAdapter {
  private player: SdkPlayer | null = null;
  private deviceId: string | null = null;
  private volume = 0.8;
  private endedCb: () => void = () => {};
  private current: { uri: string; confirmed: boolean } | null = null;
  private last: { position: number; paused: boolean; at: number } | null = null;
  private uriCache = new Map<string, string>();
  private stateWaiters: ((s: SdkState) => void)[] = [];
  private deviceWaiters: { resolve: (id: string) => void; reject: (err: Error) => void }[] = [];
  private lastError: string | null = null;
  private getToken: () => Promise<string>;
  private loadSdk: () => Promise<SpotifySdk>;
  private api: typeof fetch;

  constructor(opts: { getToken: () => Promise<string>; loadSdk?: () => Promise<SpotifySdk>; api?: typeof fetch }) {
    this.getToken = opts.getToken;
    this.loadSdk = opts.loadSdk ?? loadSpotifySdk;
    this.api = opts.api ?? ((input, init) => fetch(input, init));
  }

  async unlock() {
    if (this.player) {
      // Must run inside the click that called unlock(), or browsers block audio.
      await this.player.activateElement?.();
      if (this.deviceId) return;
      // Spotify dropped the device (idle, network blip): give it a moment to come back, else start
      // a fresh connection instead of waiting on a dead one.
      if (await this.waitForDevice(4_000).then(() => true, () => false)) return;
      this.player.disconnect();
      this.player = null;
    }
    const sdk = await this.loadSdk();
    const player = new sdk.Player({
      name: "CrowdPulse",
      volume: this.volume,
      getOAuthToken: (cb) => {
        this.getToken().then(cb, (err: Error) => (this.lastError = err.message));
      },
    });
    this.player = player;
    this.lastError = null;
    // Every "ready" (first connect and each reconnect) updates the device id.
    player.addListener("ready", ({ device_id }: { device_id: string }) => {
      this.deviceId = device_id;
      const waiters = this.deviceWaiters;
      this.deviceWaiters = [];
      for (const w of waiters) w.resolve(device_id);
    });
    player.addListener("not_ready", () => {
      this.deviceId = null;
    });
    for (const kind of Object.keys(ERROR_TEXT)) {
      player.addListener(kind, ({ message }: { message: string }) => {
        this.lastError = `${ERROR_TEXT[kind]} (${message})`;
        if (kind !== "playback_error") {
          this.deviceId = null;
          const waiters = this.deviceWaiters;
          this.deviceWaiters = [];
          for (const w of waiters) w.reject(new PlayerUnavailableError(this.lastError));
        }
      });
    }
    player.addListener("player_state_changed", (state: SdkState | null) => this.onState(state));
    await player.activateElement?.();
    const ready = this.waitForDevice(READY_TIMEOUT_MS);
    if (!(await player.connect())) {
      this.player = null;
      throw new PlayerUnavailableError("Couldn't connect to Spotify");
    }
    try {
      await ready;
    } catch (err) {
      player.disconnect();
      this.player = null;
      throw err;
    }
  }

  /** Resolves with the device id once the Web Playback SDK reports ready. */
  private waitForDevice(timeoutMs: number): Promise<string> {
    if (this.deviceId) return Promise.resolve(this.deviceId);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (id: string) => {
          window.clearTimeout(timer);
          resolve(id);
        },
        reject: (err: Error) => {
          window.clearTimeout(timer);
          reject(err);
        },
      };
      const timer = window.setTimeout(() => {
        this.deviceWaiters = this.deviceWaiters.filter((w) => w !== waiter);
        reject(new PlayerUnavailableError(this.lastError ?? "Spotify player didn't start — check the Spotify login and try again"));
      }, timeoutMs);
      this.deviceWaiters.push(waiter);
    });
  }

  async seek(ms: number) {
    if (!this.player || !this.deviceId || !this.current) return;
    const pos = Math.max(0, Math.round(ms));
    await this.call(`/me/player/seek?position_ms=${pos}&device_id=${encodeURIComponent(this.deviceId)}`, { method: "PUT" });
    this.last = { position: pos, paused: false, at: Date.now() };
  }

  onEnded(cb: () => void) {
    this.endedCb = cb;
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    void this.player?.setVolume(this.volume);
  }

  positionMs() {
    if (!this.last) return 0;
    return this.last.paused ? this.last.position : this.last.position + (Date.now() - this.last.at);
  }

  stop() {
    this.current = null;
    void this.player?.pause().catch(() => {});
  }

  async play(track: PlayableTrack, { startAtMs = 0 }: { startAtMs?: number } = {}): Promise<StartedInfo> {
    if (!this.player) throw new PlayerUnavailableError(this.lastError ?? "Spotify isn't connected — press Start audio");
    // The device may be reconnecting after an idle drop; wait a little rather than failing the song.
    const deviceId = this.deviceId ?? (await this.waitForDevice(6_000));
    const uri = await this.resolveUri(track);
    this.current = { uri, confirmed: false };
    const started = this.waitForState((s) => sameTrack(s.track_window.current_track, uri) && !s.paused);
    const res = await this.call(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
      method: "PUT",
      body: JSON.stringify({ uris: [uri], position_ms: Math.max(0, Math.round(startAtMs)) }),
    });
    if (!res.ok && res.status !== 202 && res.status !== 204) {
      const data = await res.json().catch(() => ({}));
      this.current = null;
      // 401/403/404 are about the account or device, not this song.
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        throw new PlayerUnavailableError(
          res.status === 403
            ? "Spotify refused playback (Premium required, or this account isn't on the app's user list)"
            : res.status === 401
              ? "Spotify login expired — connect Spotify again"
              : "Spotify lost this device — press Start audio again",
        );
      }
      throw new Error(`Spotify play failed (${res.status}${data.error?.message ? `: ${data.error.message}` : ""})`);
    }
    const state = await started;
    const cover = pickCover(state.track_window.current_track?.album?.images) ?? track.imageUrl;
    return {
      durationMs: state.duration || state.track_window.current_track?.duration_ms || 0,
      source: "spotify",
      ...(cover ? { imageUrl: cover } : {}),
    };
  }

  /** The catalog's URI, or the top search hit for title + artist (cached). */
  private async resolveUri(track: PlayableTrack): Promise<string> {
    if (track.spotifyUri) return track.spotifyUri;
    const cached = this.uriCache.get(track.id);
    if (cached) return cached;
    const q = `track:"${track.title.replace(/"/g, "")}" artist:"${track.artist.replace(/"/g, "")}"`;
    const res = await this.call(`/search?type=track&limit=1&q=${encodeURIComponent(q)}`);
    const data = await res.json().catch(() => ({}));
    const uri: string | undefined = data?.tracks?.items?.[0]?.uri;
    if (!res.ok || !uri) throw new Error(`"${track.title}" by ${track.artist} wasn't found on Spotify — add its spotifyUri to the catalog`);
    this.uriCache.set(track.id, uri);
    return uri;
  }

  private async call(path: string, init: RequestInit = {}) {
    const token = await this.getToken();
    return this.api(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    });
  }

  private waitForState(pred: (s: SdkState) => boolean): Promise<SdkState> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.stateWaiters = this.stateWaiters.filter((w) => w !== check);
        reject(new Error(this.lastError ?? "Spotify didn't start the track"));
      }, START_TIMEOUT_MS);
      const check = (s: SdkState) => {
        if (!pred(s)) return;
        window.clearTimeout(timer);
        this.stateWaiters = this.stateWaiters.filter((w) => w !== check);
        resolve(s);
      };
      this.stateWaiters.push(check);
    });
  }

  /** Exposed for tests: feeds a Web Playback SDK state change through the player. */
  onState(state: SdkState | null) {
    if (!state) return;
    this.last = { position: state.position, paused: state.paused, at: Date.now() };
    for (const w of [...this.stateWaiters]) w(state);
    const cur = this.current;
    if (!cur) return;
    const now = state.track_window.current_track;
    if (sameTrack(now, cur.uri) && !state.paused) {
      cur.confirmed = true;
      return;
    }
    if (!cur.confirmed) return;
    // Our track finished: Spotify parks at position 0 with it in "previous", or has already moved
    // on to something else (autoplay/radio). Either way it's over — pause so nothing else plays.
    const finished =
      (state.paused && state.position === 0 && (sameTrack(now, cur.uri) || state.track_window.previous_tracks.some((t) => sameTrack(t, cur.uri)))) ||
      !sameTrack(now, cur.uri);
    if (finished) {
      this.current = null;
      void this.player?.pause().catch(() => {});
      this.endedCb();
    }
  }
}
