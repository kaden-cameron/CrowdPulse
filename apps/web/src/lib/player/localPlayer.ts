import { localFile } from "../local/files";
import { PlaybackCancelledError, PlayerUnavailableError, type PlayableTrack, type PlayerAdapter, type StartedInfo } from "./types";

// Plays local files on this laptop (the audio never leaves it). Two audio elements take turns, so
// a new song fades in while the old one fades out:  file → fader → master → limiter → speakers.

const FADE_S = 0.25;
const LOAD_TIMEOUT_MS = 10_000;

class Slot {
  readonly el: HTMLAudioElement;
  readonly fader: GainNode;
  private url: string | null = null;
  private ctx: AudioContext;

  constructor(ctx: AudioContext, out: AudioNode) {
    this.ctx = ctx;
    this.el = new Audio();
    this.el.preload = "auto";
    this.fader = ctx.createGain();
    this.fader.gain.value = 0;
    ctx.createMediaElementSource(this.el).connect(this.fader).connect(out);
  }

  async load(file: File, atMs: number): Promise<number> {
    this.el.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(file);
    this.el.src = this.url;
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("timed out loading the file")), LOAD_TIMEOUT_MS);
      const done = (fn: () => void) => () => {
        window.clearTimeout(timer);
        this.el.removeEventListener("loadedmetadata", ok);
        this.el.removeEventListener("error", bad);
        fn();
      };
      const ok = done(resolve);
      const bad = done(() => reject(new Error("this browser can't play the file")));
      this.el.addEventListener("loadedmetadata", ok);
      this.el.addEventListener("error", bad);
    });
    if (atMs > 0) this.el.currentTime = atMs / 1000;
    return Math.round(this.el.duration * 1000);
  }

  fadeTo(v: number, seconds: number) {
    const t = this.ctx.currentTime;
    this.fader.gain.cancelScheduledValues(t);
    this.fader.gain.setValueAtTime(this.fader.gain.value, t);
    this.fader.gain.linearRampToValueAtTime(v, t + Math.max(0.01, seconds));
  }
}

export class LocalPlayer implements PlayerAdapter {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private slots: Slot[] = [];
  private active = 0;
  private token = 0;
  private endedCb: () => void = () => {};
  private problemCb: (message: string) => void = () => {};
  /** The song the active slot is playing (null once stopped), for problem reports. */
  private current: string | null = null;

  async unlock() {
    if (!this.ctx) {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain();
      // Gentle limiter so nothing clips the PA.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.ratio.value = 12;
      this.master.connect(limiter).connect(ctx.destination);
      this.slots = [new Slot(ctx, this.master), new Slot(ctx, this.master)];
      for (const s of this.slots) {
        s.el.addEventListener("ended", () => s === this.slots[this.active] && this.endedCb());
        // The file broke mid-song (moved, unreadable): report it, or the party would just go quiet.
        s.el.addEventListener("error", () => {
          if (s !== this.slots[this.active] || this.current == null) return;
          const title = this.current;
          this.current = null;
          this.problemCb(`“${title}” stopped playing: this browser couldn't read the file any more`);
        });
      }
    }
    if (this.ctx.state !== "running") await this.ctx.resume();
  }

  onEnded(cb: () => void) {
    this.endedCb = cb;
  }

  onProblem(cb: (message: string) => void) {
    this.problemCb = cb;
  }

  setVolume(v: number) {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.05);
  }

  positionMs() {
    return Math.round((this.slots[this.active]?.el.currentTime ?? 0) * 1000);
  }

  async play(track: PlayableTrack, { startAtMs = 0 }: { startAtMs?: number } = {}): Promise<StartedInfo> {
    if (!this.ctx) throw new PlayerUnavailableError("Audio is locked — press Start audio first");
    const file = localFile(track.id);
    // Not the song's fault (e.g. the page was reloaded): stop the speaker until the folder is back.
    if (!file) throw new PlayerUnavailableError(`“${track.title}” isn't linked on this device — re-link your music folder in Songs`);
    const token = ++this.token;
    const old = this.slots[this.active];
    if (!old.el.paused) {
      old.fadeTo(0, FADE_S);
      window.setTimeout(() => this.token === token && old !== this.slots[this.active] && old.el.pause(), FADE_S * 1000 + 50);
    }
    const next = this.slots[1 - this.active];
    next.fader.gain.value = 0;
    const durationMs = await next.load(file, startAtMs);
    if (token !== this.token) throw new PlaybackCancelledError();
    await next.el.play();
    if (token !== this.token) {
      next.el.pause();
      throw new PlaybackCancelledError();
    }
    next.fadeTo(1, 0.03);
    this.active = 1 - this.active;
    this.current = track.title;
    return { durationMs, source: "file" };
  }

  stop() {
    const token = ++this.token;
    this.current = null;
    for (const s of this.slots) {
      s.fadeTo(0, 0.2);
      // Unless something new started meanwhile.
      window.setTimeout(() => this.token === token && s.el.pause(), 250);
    }
  }

  async seek(ms: number) {
    const s = this.slots[this.active];
    if (s) s.el.currentTime = ms / 1000;
  }

  async hold() {
    this.slots[this.active]?.el.pause();
  }

  async unhold() {
    await this.slots[this.active]?.el.play();
  }

  dispose() {
    this.stop();
    for (const s of this.slots) s.el.removeAttribute("src");
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.master = null;
    this.slots = [];
    this.active = 0;
  }
}
