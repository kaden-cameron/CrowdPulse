import { startGeneratedTrack, type GeneratedTrack } from "./synth";
import type { PlayableTrack, PlayerAdapter, StartedInfo } from "./types";

// Plays on the device this page runs on (the DJ laptop plugged into the PA). For each track it uses
// an audio file listed in /audio/manifest.json, or else the generated demo version. Songs crossfade.

const CROSSFADE_S = 1.5;
const FILE_LOAD_TIMEOUT_MS = 8000;

interface Current {
  token: number;
  stop(fadeS: number): void;
  position(): number;
}

export class LocalPlayer implements PlayerAdapter {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private manifest: Record<string, string> = {};
  private current: Current | null = null;
  private token = 0;
  private endedCb: () => void = () => {};
  private endTimer: number | undefined;
  private generatedDurationS: number;

  constructor({ generatedDurationS = 60 }: { generatedDurationS?: number } = {}) {
    this.generatedDurationS = generatedDurationS;
  }

  async unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      // Master: volume → gentle limiter, so nothing clips the PA.
      this.master = this.ctx.createGain();
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.ratio.value = 12;
      this.master.connect(limiter).connect(this.ctx.destination);
      try {
        const res = await fetch("/audio/manifest.json", { cache: "no-store" });
        if (res.ok && res.headers.get("content-type")?.includes("json")) this.manifest = await res.json();
      } catch {
        /* no manifest → generated tracks only */
      }
    }
    if (this.ctx.state !== "running") await this.ctx.resume();
  }

  onEnded(cb: () => void) {
    this.endedCb = cb;
  }

  setVolume(v: number) {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.05);
  }

  positionMs() {
    return Math.round((this.current?.position() ?? 0) * 1000);
  }

  stop() {
    window.clearTimeout(this.endTimer);
    this.current?.stop(CROSSFADE_S);
    this.current = null;
    this.token++;
  }

  async play(track: PlayableTrack, { startAtMs = 0 }: { startAtMs?: number } = {}): Promise<StartedInfo> {
    if (!this.ctx || !this.master) throw new Error("Audio is locked — press Start audio first");
    window.clearTimeout(this.endTimer);
    this.current?.stop(CROSSFADE_S); // crossfade: old fades out while the new one fades in
    const token = ++this.token;
    const ended = () => {
      if (token === this.token) {
        this.current = null;
        this.endedCb();
      }
    };

    const file = this.manifest[track.id];
    if (file) {
      try {
        return await this.playFile(`/audio/${encodeURIComponent(file)}`, token, startAtMs, ended);
      } catch (err) {
        if (token !== this.token) throw err; // replaced while loading
        const info = this.playGenerated(track, token, startAtMs, ended);
        return { ...info, note: `Couldn't play ${file} (${(err as Error).message}); using the generated version` };
      }
    }
    return this.playGenerated(track, token, startAtMs, ended);
  }

  private playGenerated(track: PlayableTrack, token: number, startAtMs: number, ended: () => void): StartedInfo {
    const ctx = this.ctx!;
    const durationS = this.generatedDurationS;
    const startAtS = Math.min(startAtMs / 1000, durationS - 1);
    const t0 = ctx.currentTime - startAtS;
    const gen: GeneratedTrack = startGeneratedTrack(ctx, this.master!, track, { durationS, startAtS });
    this.current = { token, stop: (f) => gen.stop(f), position: () => ctx.currentTime - t0 };
    this.endTimer = window.setTimeout(() => {
      gen.stop(0.2);
      ended();
    }, (durationS - startAtS) * 1000);
    return { durationMs: durationS * 1000, source: "generated" };
  }

  private playFile(url: string, token: number, startAtMs: number, ended: () => void): Promise<StartedInfo> {
    const ctx = this.ctx!;
    const el = new Audio();
    el.crossOrigin = "anonymous";
    el.preload = "auto";
    el.src = url;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("timed out loading")), FILE_LOAD_TIMEOUT_MS);
      el.addEventListener(
        "error",
        () => {
          window.clearTimeout(timeout);
          reject(new Error("could not decode"));
        },
        { once: true },
      );
      el.addEventListener(
        "canplay",
        async () => {
          window.clearTimeout(timeout);
          if (token !== this.token) return reject(new Error("replaced"));
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0.0001, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(1, ctx.currentTime + CROSSFADE_S);
          ctx.createMediaElementSource(el).connect(gain).connect(this.master!);
          if (startAtMs) el.currentTime = startAtMs / 1000;
          try {
            await el.play();
          } catch (err) {
            return reject(err as Error);
          }
          el.addEventListener("ended", ended, { once: true });
          this.current = {
            token,
            position: () => el.currentTime,
            stop: (f) => {
              const now = ctx.currentTime;
              gain.gain.cancelScheduledValues(now);
              gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), now);
              gain.gain.exponentialRampToValueAtTime(0.0001, now + f);
              window.setTimeout(() => el.pause(), f * 1000 + 100);
            },
          };
          resolve({ durationMs: Math.round(el.duration * 1000), source: "file" });
        },
        { once: true },
      );
    });
  }
}
