import type { PlayableTrack } from "./types";

// Generated demo tracks: a short groove built live with the Web Audio API from each track's
// BPM, energy and genre, so the demo plays real, matching music with no audio files or licensing.
// Higher energy → four-on-the-floor kick, busier hats, brighter bass, an arpeggio on top.

const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;

/** Deterministic PRNG so each track always sounds the same. */
function seeded(id: string) {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);
const MINOR_PENTA = [0, 3, 5, 7, 10];

let noiseBuffer: AudioBuffer | null = null;
function noise(ctx: BaseAudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer;
  noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuffer.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}

export interface GeneratedTrack {
  /** Fade out over `fadeS` seconds, then release everything. */
  stop(fadeS?: number): void;
}

/**
 * Starts a generated track on `out`. `startAtS` skips into the track (resume after a reload).
 * The caller decides when it ends (duration); the groove itself loops until stopped.
 */
export function startGeneratedTrack(
  ctx: AudioContext,
  out: AudioNode,
  track: PlayableTrack,
  { durationS, startAtS = 0 }: { durationS: number; startAtS?: number },
): GeneratedTrack {
  const rand = seeded(track.id);
  const energy = Math.max(0, Math.min(1, track.energy));
  const bpm = Math.max(60, Math.min(180, track.bpm));
  // Very fast genres (drum & bass) read better with drums at half time.
  const drumHalfTime = bpm > 150;
  const sixteenth = 60 / bpm / 4;
  const root = 33 + Math.floor(rand() * 7); // A1–D#2
  const bassPattern = Array.from({ length: 16 }, (_, i) =>
    i % 4 === 0 || rand() < 0.25 + energy * 0.35 ? MINOR_PENTA[Math.floor(rand() * MINOR_PENTA.length)] : null,
  );
  const arpPattern = Array.from({ length: 16 }, () => MINOR_PENTA[Math.floor(rand() * 5)] + 12 * (1 + Math.floor(rand() * 2)));
  const chordShift = [-2, -4, 3, 5][Math.floor(rand() * 4)]; // second chord of a two-bar loop

  const bus = ctx.createGain();
  bus.gain.value = 0;
  bus.connect(out);
  const fadeIn = startAtS > 0 ? 0.5 : 1.5;
  bus.gain.setValueAtTime(0, ctx.currentTime);
  bus.gain.linearRampToValueAtTime(0.9, ctx.currentTime + fadeIn);

  const fadeOutAt = ctx.currentTime + Math.max(0, durationS - startAtS - 2);
  bus.gain.setValueAtTime(0.9, fadeOutAt);
  bus.gain.linearRampToValueAtTime(0.0001, fadeOutAt + 2);

  let step = Math.floor(startAtS / sixteenth);
  let nextTime = ctx.currentTime + 0.05;
  let stopped = false;

  const env = (g: GainNode, t: number, peak: number, decay: number, attack = 0.002) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  };

  const kick = (t: number) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    env(g, t, 0.9, 0.35);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + 0.4);
  };
  const noiseHit = (t: number, type: BiquadFilterType, freq: number, peak: number, decay: number) => {
    const s = ctx.createBufferSource();
    s.buffer = noise(ctx);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    env(g, t, peak, decay, 0.001);
    s.connect(f).connect(g).connect(bus);
    s.start(t, rand() * 0.5);
    s.stop(t + decay + 0.05);
  };
  const tone = (t: number, hz: number, type: OscillatorType, peak: number, decay: number, cutoff?: number) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(hz, t);
    const g = ctx.createGain();
    env(g, t, peak, decay, 0.01);
    if (cutoff) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = cutoff;
      o.connect(f).connect(g).connect(bus);
    } else {
      o.connect(g).connect(bus);
    }
    o.start(t);
    o.stop(t + decay + 0.05);
  };

  function scheduleStep(i: number, t: number) {
    const s = i % 16;
    const bar = Math.floor(i / 16);
    const drumsIn = bar >= 1 || startAtS > 0; // short intro without drums
    const drumStep = drumHalfTime ? s % 8 : s % 4;

    if (drumsIn) {
      // Kick: four on the floor for energetic tracks, a laid-back pattern for chill ones.
      if (energy >= 0.45 ? drumStep === 0 : s === 0 || s === 10) kick(t);
      // Clap/snare on 2 and 4 (or 3 in half time).
      if (energy >= 0.25 && (drumHalfTime ? s === 8 : s === 4 || s === 12)) noiseHit(t, "bandpass", 1800, 0.45, 0.18);
      // Hats: 8ths, then 16ths when the energy is high; open hats on the offbeat.
      if (s % 2 === 0 || energy >= 0.7) noiseHit(t, "highpass", 7500, s % 2 === 0 ? 0.16 : 0.09, 0.04);
      if (energy >= 0.55 && s % 4 === 2) noiseHit(t, "highpass", 6000, 0.12, 0.22);
    }
    // Bass line, brighter with energy.
    const b = bassPattern[s];
    if (b !== null) tone(t, midiHz(root + b), "sawtooth", 0.28, sixteenth * 1.8, 250 + energy * 1400);
    // Pad chord once per bar — carries the chill tracks.
    if (s === 0) {
      const shift = bar % 2 === 1 ? chordShift : 0;
      for (const n of [12, 15, 19]) tone(t, midiHz(root + 12 + n + shift), "triangle", 0.05 + (1 - energy) * 0.05, sixteenth * 15);
    }
    // Arpeggio on top for high-energy tracks after the intro.
    if (energy >= 0.7 && bar >= 2 && s % 2 === 0) tone(t, midiHz(root + 24 + arpPattern[s]), "square", 0.035, sixteenth * 1.5, 3000);
  }

  const timer = window.setInterval(() => {
    if (stopped) return;
    while (nextTime < ctx.currentTime + LOOKAHEAD_S) {
      scheduleStep(step, nextTime);
      step++;
      nextTime += sixteenth;
    }
  }, TICK_MS);

  return {
    stop(fadeS = 1.5) {
      if (stopped) return;
      stopped = true;
      window.clearInterval(timer);
      const now = ctx.currentTime;
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(Math.max(0.0001, bus.gain.value), now);
      bus.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.05, fadeS));
      window.setTimeout(() => bus.disconnect(), (fadeS + 0.3) * 1000);
    },
  };
}
