import type { TransitionPlan } from "@crowdpulse/shared";
import { localFile } from "../local/files";
import { PlayerUnavailableError, type PlayableTrack, type PlayerAdapter, type StartedInfo } from "./types";

// Plays local files on this laptop through two "decks", like a DJ mixer:
//   file → trim (loudness) → low EQ (bass) → high-pass filter → fader → master → limiter → speakers
//                                          └→ echo send → beat-synced delay ─┘
// A plain play() fades the old deck out and the new one in. For the AI DJ, arm() a transition: when
// the playing song reaches the plan's bar line, the next song starts on the other deck, stretched
// to the same tempo (pitch kept), and a phase-lock loop keeps the beats on top of each other while
// the faders / EQ / filter / echo do the transition. Afterwards the new song eases back to its own tempo.

const LOW_CUT_DB = -30;
const TICK_MS = 25;
/** Load the next song this long before the transition. */
const PRELOAD_MS = 20_000;
/** A transition missed by more than this (e.g. the host moved the position past it) is skipped. */
const LATE_MS = 1_500;
/** After a blend, the new song eases back to its own tempo over this long, in steps. */
const GLIDE_MS = 10_000;
const GLIDE_STEP_MS = 500;
/**
 * Beat sync: how often the playback rate may change. Chrome restarts its time-stretcher on every
 * rate change, so changing it constantly means no change takes hold; average, then nudge.
 */
const SYNC_EVERY_MS = 750;
/** A media element starts this much later than asked; the incoming song starts ahead to cover it. */
const START_LAG_MS = 45;
const LOAD_TIMEOUT_MS = 10_000;

const dbToGain = (db: number) => Math.pow(10, db / 20);

class Deck {
  readonly el: HTMLAudioElement;
  readonly trim: GainNode;
  readonly low: BiquadFilterNode;
  readonly hp: BiquadFilterNode;
  readonly fader: GainNode;
  readonly send: GainNode;
  private url: string | null = null;
  trackId: string | null = null;

  private ctx: AudioContext;

  constructor(ctx: AudioContext, out: AudioNode, echo: AudioNode) {
    this.ctx = ctx;
    this.el = new Audio();
    this.el.preload = "auto";
    (this.el as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    const src = ctx.createMediaElementSource(this.el);
    this.trim = ctx.createGain();
    this.low = ctx.createBiquadFilter();
    this.low.type = "lowshelf";
    this.low.frequency.value = 200;
    this.hp = ctx.createBiquadFilter();
    this.hp.type = "highpass";
    this.hp.frequency.value = 10;
    this.hp.Q.value = 0.7;
    this.fader = ctx.createGain();
    this.fader.gain.value = 0;
    this.send = ctx.createGain();
    this.send.gain.value = 0;
    src.connect(this.trim).connect(this.low).connect(this.hp).connect(this.fader).connect(out);
    this.hp.connect(this.send).connect(echo);
  }

  /** Back to neutral: silent, flat EQ, no filter or echo, normal speed. */
  reset(gainDb = 0) {
    const t = this.ctx.currentTime;
    for (const p of [this.fader.gain, this.low.gain, this.hp.frequency, this.send.gain, this.trim.gain]) p.cancelScheduledValues(t);
    this.fader.gain.setValueAtTime(0, t);
    this.low.gain.setValueAtTime(0, t);
    this.hp.frequency.setValueAtTime(10, t);
    this.send.gain.setValueAtTime(0, t);
    this.trim.gain.setValueAtTime(dbToGain(gainDb), t);
    this.el.playbackRate = 1;
  }

  async load(file: File, trackId: string, atMs: number): Promise<number> {
    this.el.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(file);
    this.trackId = trackId;
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

  pos(): number {
    return this.el.currentTime * 1000;
  }

  fadeTo(v: number, seconds: number) {
    const t = this.ctx.currentTime;
    this.fader.gain.cancelScheduledValues(t);
    this.fader.gain.setValueAtTime(this.fader.gain.value, t);
    this.fader.gain.linearRampToValueAtTime(v, t + Math.max(0.01, seconds));
  }

  unload() {
    this.el.pause();
    this.trackId = null;
  }
}

interface Armed {
  next: PlayableTrack;
  plan: TransitionPlan;
  onBegin: (next: PlayableTrack, durationMs: number) => void;
  loading: Promise<number> | null;
  durationMs: number | null;
}

interface Running {
  from: Deck;
  to: Deck;
  plan: TransitionPlan;
  /** performance.now() when the transition ideally started. */
  t0: number;
  fromRate: number;
  beatmatched: boolean;
  echoStart?: number;
  /** Beat-sync errors (ms) since the last rate change, and when that was. */
  errs: number[];
  lastSync: number;
}

export class LocalMixer implements PlayerAdapter {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private delay: DelayNode | null = null;
  private decks: Deck[] = [];
  private active = 0;
  private token = 0;
  private endedCb: () => void = () => {};
  private armed: Armed | null = null;
  private running: Running | null = null;
  private glide: { deck: Deck; from: number; t0: number; last: number } | null = null;
  private timer: number | undefined;

  get unlocked() {
    return !!this.ctx;
  }

  async unlock() {
    if (!this.ctx) {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain();
      // Gentle limiter so two songs on top of each other never clip the PA.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      this.master.connect(limiter).connect(ctx.destination);
      // Echo: a delay feeding back into itself, out to the master.
      this.delay = ctx.createDelay(4);
      const feedback = ctx.createGain();
      feedback.gain.value = 0.55;
      const wet = ctx.createGain();
      wet.gain.value = 0.8;
      this.delay.connect(feedback).connect(this.delay);
      this.delay.connect(wet).connect(this.master);
      this.decks = [new Deck(ctx, this.master, this.delay), new Deck(ctx, this.master, this.delay)];
      for (const d of this.decks) d.el.addEventListener("ended", () => this.deckEnded(d));
      this.timer = window.setInterval(() => this.tick(), TICK_MS);
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
    return Math.round(this.decks[this.active]?.pos() ?? 0);
  }

  private get current(): Deck | undefined {
    return this.decks[this.active];
  }

  async play(track: PlayableTrack, { startAtMs = 0 }: { startAtMs?: number } = {}): Promise<StartedInfo> {
    if (!this.ctx) throw new PlayerUnavailableError("Audio is locked — press Start audio first");
    const file = localFile(track.id);
    if (!file) throw new Error(`“${track.title}” isn't linked on this device — add its folder again in Songs`);
    this.finishTransitionNow();
    this.armed = null;
    const token = ++this.token;
    const old = this.current;
    if (old && !old.el.paused) {
      old.fadeTo(0, 0.25);
      window.setTimeout(() => this.token === token && old !== this.current && old.el.pause(), 300);
    }
    const deck = this.decks[1 - this.active];
    deck.reset(track.analysis?.gainDb ?? 0);
    const durationMs = await deck.load(file, track.id, startAtMs);
    if (token !== this.token) throw new Error("replaced");
    await deck.el.play();
    deck.fadeTo(1, 0.03);
    this.active = 1 - this.active;
    return { durationMs, source: "file" };
  }

  stop() {
    const token = ++this.token;
    this.armed = null;
    this.finishTransitionNow();
    for (const d of this.decks) {
      d.fadeTo(0, 0.2);
      // Unless something new started meanwhile.
      window.setTimeout(() => this.token === token && d.el.pause(), 250);
    }
  }

  async seek(ms: number) {
    this.finishTransitionNow();
    const d = this.current;
    if (d) d.el.currentTime = ms / 1000;
  }

  async hold() {
    this.finishTransitionNow();
    this.current?.el.pause();
  }

  async unhold() {
    await this.current?.el.play();
  }

  /** AI DJ: mix into `next` when the playing song reaches `plan.outAtMs`. Replaces any armed one. */
  arm(next: PlayableTrack, plan: TransitionPlan, onBegin: Armed["onBegin"]) {
    if (this.running) return;
    this.armed = { next, plan, onBegin, loading: null, durationMs: null };
  }

  disarm() {
    this.armed = null;
  }

  get mixing(): boolean {
    return !!this.running;
  }

  /** During a beat-matched transition: how far the new song's beats are from the old one's (ms). */
  syncErrorMs(): number | null {
    const r = this.running;
    if (!r?.beatmatched || r.to.el.paused) return null;
    return r.to.pos() - (r.plan.inFromMs + (r.plan.rate * (r.from.pos() - r.plan.outAtMs)) / r.fromRate);
  }

  private deckEnded(d: Deck) {
    // The outgoing deck of a transition running out is fine; only the playing song ending counts.
    if (d === this.current && !this.running) this.endedCb();
  }

  private tick() {
    const now = performance.now();
    if (this.glide && now - this.glide.last >= GLIDE_STEP_MS) {
      const k = Math.min(1, (now - this.glide.t0) / GLIDE_MS);
      this.glide.deck.el.playbackRate = this.glide.from + (1 - this.glide.from) * k;
      this.glide.last = now;
      if (k >= 1) this.glide = null;
    }
    if (this.running) return this.follow(now);
    const a = this.armed;
    const cur = this.current;
    if (!a || !cur || cur.el.paused) return;
    const p = cur.pos();
    if (!a.loading && p >= a.plan.outAtMs - PRELOAD_MS) {
      const file = localFile(a.next.id);
      if (!file) {
        this.armed = null;
        return;
      }
      const deck = this.decks[1 - this.active];
      deck.reset(a.next.analysis?.gainDb ?? 0);
      a.loading = deck.load(file, a.next.id, a.plan.inFromMs);
      a.loading.then(
        (ms) => (a.durationMs = ms),
        () => this.armed === a && (this.armed = null),
      );
    }
    if (p >= a.plan.outAtMs) {
      if (p > a.plan.outAtMs + LATE_MS) this.armed = null;
      else if (a.durationMs != null) this.begin(a, now);
    }
  }

  private begin(a: Armed, now: number) {
    const ctx = this.ctx!;
    const from = this.current!;
    const to = this.decks[1 - this.active];
    const { plan } = a;
    const fromRate = from.el.playbackRate;
    const lateMs = Math.max(0, (from.pos() - plan.outAtMs) / fromRate);
    const t = ctx.currentTime;
    const L = plan.lengthMs / 1000;
    // One beat of the outgoing song, in real seconds.
    const beatS = plan.bars ? plan.lengthMs / plan.bars / 4 / 1000 / fromRate : 0.5;
    this.armed = null;
    this.glide = null;
    this.running = { from, to, plan, t0: now - lateMs, fromRate, beatmatched: plan.style === "blend" || plan.style === "filter", errs: [], lastSync: now };

    if (this.running.beatmatched) {
      to.el.playbackRate = plan.rate;
      to.el.currentTime = (plan.inFromMs + plan.rate * (lateMs + START_LAG_MS)) / 1000;
      to.fader.gain.setValueAtTime(0, t);
      void to.el.play().catch(() => {});
      if (plan.style === "blend") {
        // Bring the new song in without its bass, swap the basslines halfway, then fade the old one out.
        const swap = t + L / 2;
        const beat = Math.min(beatS, L / 8);
        to.low.gain.setValueAtTime(LOW_CUT_DB, t);
        to.low.gain.setValueAtTime(LOW_CUT_DB, swap - beat);
        to.low.gain.linearRampToValueAtTime(0, swap);
        from.low.gain.setValueAtTime(0, swap - beat);
        from.low.gain.linearRampToValueAtTime(LOW_CUT_DB, swap);
        to.fader.gain.linearRampToValueAtTime(1, swap);
        from.fader.gain.setValueAtTime(1, swap);
        from.fader.gain.linearRampToValueAtTime(0, t + L);
      } else {
        // Filter: sweep the old song away with a rising high-pass while the new one comes up.
        from.hp.frequency.setValueAtTime(10, t);
        from.hp.frequency.exponentialRampToValueAtTime(1_800, t + L);
        from.fader.gain.setValueAtTime(1, t + 0.7 * L);
        from.fader.gain.linearRampToValueAtTime(0, t + L);
        to.low.gain.setValueAtTime(LOW_CUT_DB, t);
        to.low.gain.setValueAtTime(LOW_CUT_DB, t + 0.5 * L);
        to.low.gain.linearRampToValueAtTime(0, t + 0.6 * L);
        to.fader.gain.linearRampToValueAtTime(1, t + 0.6 * L);
      }
    } else if (plan.style === "echo") {
      // Echo out: the old song's next beat goes into a beat-long echo and the dry sound drops; the
      // new song starts on the next bar.
      const beat = plan.lengthMs / 4 / 1000 / fromRate;
      this.delay!.delayTime.setValueAtTime(Math.min(3.9, beat), t);
      from.send.gain.setValueAtTime(1, t);
      from.send.gain.setValueAtTime(0, t + beat);
      from.fader.gain.setValueAtTime(1, t + beat);
      from.fader.gain.linearRampToValueAtTime(0, t + beat + 0.04);
      const startIn = Math.max(0, plan.lengthMs / fromRate - lateMs);
      this.running.echoStart = window.setTimeout(() => {
        to.fader.gain.setValueAtTime(1, ctx.currentTime);
        void to.el.play().catch(() => {});
      }, startIn);
    } else {
      // Cut: on the bar line, straight into the new song.
      from.fader.gain.setValueAtTime(from.fader.gain.value, t);
      from.fader.gain.linearRampToValueAtTime(0, t + 0.02);
      to.fader.gain.setValueAtTime(1, t);
      void to.el.play().catch(() => {});
    }
    this.active = 1 - this.active;
    a.onBegin(a.next, a.durationMs ?? 0);
  }

  /** During a beat-matched transition: keep the new song's beats on the old song's. */
  private follow(now: number) {
    const r = this.running!;
    const elapsed = now - r.t0;
    const realLength = r.plan.style === "echo" ? r.plan.lengthMs / r.fromRate + 2_000 : r.plan.lengthMs;
    if (elapsed >= realLength) return this.endTransition();
    if (!r.beatmatched || r.from.el.paused || r.to.el.paused) return;
    const err = this.syncErrorMs();
    if (err === null) return;
    r.errs.push(err); // ms; > 0 = the new song is ahead
    if (now - r.lastSync < SYNC_EVERY_MS || r.errs.length < 8) return;
    // currentTime jitters by a few ms: decide on the median of the last ~0.75 s.
    const sorted = [...r.errs].sort((a, b) => a - b);
    const avg = sorted[Math.floor(sorted.length / 2)];
    r.errs = [];
    r.lastSync = now;
    if (Math.abs(avg) > 120 && elapsed < r.plan.lengthMs * 0.3) {
      // Way off while the new song is still quiet: jump (a jump also takes a moment to land).
      r.to.el.currentTime = (r.to.pos() - avg + START_LAG_MS) / 1000;
      return;
    }
    // Catch up (or fall back) over about a second and a half, then back to the matched tempo.
    const rate = Math.abs(avg) < 6 ? r.plan.rate : r.plan.rate * (1 - Math.max(-0.025, Math.min(0.025, avg / 1_500)));
    if (Math.abs(rate - r.to.el.playbackRate) > 0.0005) r.to.el.playbackRate = rate;
  }

  private endTransition() {
    const r = this.running!;
    this.running = null;
    r.from.unload();
    r.from.reset();
    if (r.beatmatched && Math.abs(r.plan.rate - 1) > 0.001) this.glide = { deck: r.to, from: r.plan.rate, t0: performance.now(), last: 0 };
    else r.to.el.playbackRate = 1;
  }

  /** Cut a running transition short (pause, seek, stop, a new song): the new song carries on alone. */
  private finishTransitionNow() {
    const r = this.running;
    this.glide = null;
    if (!r || !this.ctx) return;
    window.clearTimeout(r.echoStart);
    this.running = null;
    r.from.unload();
    r.from.reset();
    const t = this.ctx.currentTime;
    for (const p of [r.to.fader.gain, r.to.low.gain, r.to.hp.frequency, r.to.send.gain]) p.cancelScheduledValues(t);
    r.to.fader.gain.setValueAtTime(1, t);
    r.to.low.gain.setValueAtTime(0, t);
    r.to.hp.frequency.setValueAtTime(10, t);
    r.to.send.gain.setValueAtTime(0, t);
    r.to.el.playbackRate = 1;
    if (r.to.el.paused && r.plan.style === "echo") void r.to.el.play().catch(() => {});
  }

  dispose() {
    window.clearInterval(this.timer);
    this.stop();
  }
}
