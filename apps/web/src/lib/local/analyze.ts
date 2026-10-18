import { toCamelot, type TrackAnalysis } from "@crowdpulse/shared";

// Measures a local song for the AI DJ, on the host's laptop (nothing is uploaded):
// - tempo + beat grid: spectral-flux onsets → autocorrelation for a rough tempo → a fine search that
//   folds the onsets at each candidate beat length and keeps the sharpest fold (also gives the phase);
// - downbeat: which of the 4 beats has the strongest kick and the biggest energy jumps;
// - key: a chromagram matched against Krumhansl–Schmuckler key profiles (→ Camelot);
// - loudness: gain to a common level; mix points: where the music starts, and where the outro is.
// Audio is decoded mono at 11 kHz: plenty for rhythm and key, and small (≈26 MB for 5 minutes).

export const ANALYSIS_RATE = 11_025;
const HOP = 128;
const WIN = 512;
const KEY_WIN = 4096;
/** Loudness everything is brought to (dBFS RMS of the louder half of the song). */
const TARGET_DB = -12;

/** In-place radix-2 FFT (re/im of length 2^k). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

const hann = (n: number) => Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));

interface Frames {
  /** Onset strength per frame (all frequencies), detrended. */
  onset: Float64Array;
  /** Onset strength of the bass (kick drum) per frame. */
  low: Float64Array;
  /** RMS per frame. */
  rms: Float64Array;
  fps: number;
}

function frames(x: Float32Array, rate: number): Frames {
  const n = Math.max(0, Math.floor((x.length - WIN) / HOP));
  const w = hann(WIN);
  const re = new Float64Array(WIN);
  const im = new Float64Array(WIN);
  const half = WIN / 2;
  const lowBins = Math.max(2, Math.round((150 * WIN) / rate));
  let prev = new Float64Array(half);
  let cur = new Float64Array(half);
  const flux = new Float64Array(n);
  const low = new Float64Array(n);
  const rms = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const off = f * HOP;
    let e = 0;
    for (let i = 0; i < WIN; i++) {
      const v = x[off + i];
      e += v * v;
      re[i] = v * w[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(e / WIN);
    fft(re, im);
    let fl = 0;
    let lo = 0;
    for (let k = 1; k < half; k++) {
      const m = Math.log1p(100 * Math.hypot(re[k], im[k]));
      cur[k] = m;
      const d = m - prev[k];
      if (d > 0) {
        fl += d;
        if (k <= lowBins) lo += d;
      }
    }
    flux[f] = f ? fl : 0;
    low[f] = f ? lo : 0;
    [prev, cur] = [cur, prev];
  }
  // Detrend: subtract the local average so loud sections don't count as "more beats".
  const onset = new Float64Array(n);
  const R = 16;
  let sum = 0;
  for (let i = 0; i < Math.min(n, R); i++) sum += flux[i];
  for (let f = 0; f < n; f++) {
    if (f + R < n) sum += flux[f + R];
    if (f - R - 1 >= 0) sum -= flux[f - R - 1];
    const count = Math.min(n - 1, f + R) - Math.max(0, f - R) + 1;
    onset[f] = Math.max(0, flux[f] - sum / count);
  }
  return { onset, low, rms, fps: rate / HOP };
}

/** Linear-interpolated autocorrelation lookup. */
const at = (r: Float64Array, l: number) => {
  const i = Math.floor(l);
  if (i + 1 >= r.length) return 0;
  return r[i] + (r[i + 1] - r[i]) * (l - i);
};

/** Rough tempo (BPM) from the onset autocorrelation, leaning towards common dance tempos. */
function roughTempo(onset: Float64Array, fps: number): number {
  const maxLag = Math.ceil(2 * fps) + 2; // up to two beats at 60 BPM
  const r = new Float64Array(maxLag + 1);
  for (let l = 1; l <= maxLag; l++) {
    let s = 0;
    for (let i = 0; i + l < onset.length; i++) s += onset[i] * onset[i + l];
    r[l] = s;
  }
  let best = 120;
  let bestScore = -Infinity;
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const L = (60 * fps) / bpm;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 122) / 0.7) ** 2);
    const score = prior * (at(r, L) + 0.5 * at(r, 2 * L));
    if (score > bestScore) {
      bestScore = score;
      best = bpm;
    }
  }
  return best;
}

/**
 * Exact tempo and beat phase: fold the onsets at each candidate beat length; the right tempo gives
 * the sharpest peak. Returns BPM and the first beat's frame (fractional).
 */
function fineTempo(onset: Float64Array, beatSignal: Float64Array, fps: number, rough: number): { bpm: number; phase: number } {
  const B = 64;
  const h = new Float64Array(B);
  let best = { bpm: rough, phase: 0, score: -Infinity };
  for (let bpm = rough - 2; bpm <= rough + 2; bpm += 0.02) {
    const P = (60 * fps) / bpm;
    h.fill(0);
    for (let i = 0; i < onset.length; i++) {
      if (!onset[i]) continue;
      const ph = i / P;
      h[Math.floor((ph - Math.floor(ph)) * B) % B] += onset[i];
    }
    let mean = 0;
    for (let b = 0; b < B; b++) mean += h[b];
    mean /= B;
    for (let b = 0; b < B; b++) {
      const s = h[b] + 0.5 * (h[(b + 1) % B] + h[(b + B - 1) % B]) - 2 * mean;
      if (s > best.score) best = { bpm, phase: ((b + 0.5) / B) * P, score: s };
    }
  }
  // The phase follows the kick drum: off-beat hi-hats (house, disco) would otherwise pull it half a beat.
  const P = (60 * fps) / best.bpm;
  h.fill(0);
  for (let i = 0; i < beatSignal.length; i++) {
    const ph = i / P;
    h[Math.floor((ph - Math.floor(ph)) * B) % B] += beatSignal[i];
  }
  let peak = 0;
  let peakScore = -Infinity;
  for (let b = 0; b < B; b++) {
    const s = h[b] + 0.5 * (h[(b + 1) % B] + h[(b + B - 1) % B]);
    if (s > peakScore) {
      peakScore = s;
      peak = b;
    }
  }
  return { bpm: Math.round(best.bpm * 100) / 100, phase: ((peak + 0.5) / B) * P };
}

const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(a: number[], b: number[]): number {
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** The song's key as Camelot ("8A"), or null when no key stands out (e.g. drums only). */
export function detectKey(x: Float32Array, rate: number): string | null {
  const chroma = new Array(12).fill(0);
  const w = hann(KEY_WIN);
  const re = new Float64Array(KEY_WIN);
  const im = new Float64Array(KEY_WIN);
  const lo = Math.ceil((100 * KEY_WIN) / rate);
  const hi = Math.floor((2000 * KEY_WIN) / rate);
  const pc = new Int8Array(hi + 1);
  for (let k = lo; k <= hi; k++) pc[k] = ((Math.round(12 * Math.log2((k * rate) / KEY_WIN / 440)) % 12) + 12 + 9) % 12; // 0 = C
  for (let off = 0; off + KEY_WIN <= x.length; off += KEY_WIN) {
    for (let i = 0; i < KEY_WIN; i++) {
      re[i] = x[off + i] * w[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = lo; k <= hi; k++) chroma[pc[k]] += Math.sqrt(Math.hypot(re[k], im[k]));
  }
  if (!chroma.some((v) => v > 0)) return null;
  let best = { score: -Infinity, pc: 0, minor: false };
  let second = -Infinity;
  for (let t = 0; t < 12; t++) {
    for (const minor of [false, true]) {
      const profile = minor ? KK_MINOR : KK_MAJOR;
      const rotated = chroma.map((_, i) => profile[(i - t + 12) % 12]);
      const s = correlate(chroma, rotated);
      if (s > best.score) {
        second = best.score;
        best = { score: s, pc: t, minor };
      } else if (s > second) second = s;
    }
  }
  return best.score < 0.3 ? null : toCamelot(best.pc, best.minor);
}

const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Analyzes mono samples (any rate; 11 kHz is plenty). */
export function analyzeSamples(x: Float32Array, rate: number): TrackAnalysis {
  const durationMs = Math.round((x.length / rate) * 1000);
  const { onset, low, rms, fps } = frames(x, rate);
  const mean = (v: Float64Array) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length) || 1;
  const om = mean(onset);
  const lm = mean(low);
  const beatSignal = onset.map((v, i) => v / om + (3 * low[i]) / lm);
  const { bpm, phase } = fineTempo(onset, beatSignal, fps, roughTempo(onset, fps));
  const P = (60 * fps) / bpm;
  // Frame index → ms (a frame's onset sits about mid-window).
  const toMs = (frame: number) => ((frame * HOP + WIN / 2) / rate) * 1000;

  // Downbeat: of the 4 beat positions, the one with the strongest kicks and biggest energy jumps.
  const beats: number[] = [];
  for (let b = phase; b < onset.length; b += P) beats.push(b);
  const peak = (arr: Float64Array, f: number) => Math.max(arr[Math.round(f) - 1] ?? 0, arr[Math.round(f)] ?? 0, arr[Math.round(f) + 1] ?? 0);
  const beatRms = beats.map((b) => {
    let s = 0;
    let c = 0;
    for (let f = Math.round(b); f < Math.round(b + P) && f < rms.length; f++, c++) s += rms[f];
    return c ? s / c : 0;
  });
  const lowMean = beats.reduce((s, b) => s + peak(low, b), 0) / Math.max(1, beats.length) || 1;
  const jumpMean = beatRms.reduce((s, v, i) => s + Math.max(0, v - (beatRms[i - 1] ?? v)), 0) / Math.max(1, beats.length) || 1;
  let down = 0;
  let downScore = -Infinity;
  for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = j; k < beats.length; k += 4) {
      s += peak(low, beats[k]) / lowMean + (0.5 * Math.max(0, beatRms[k] - (beatRms[k - 1] ?? beatRms[k]))) / jumpMean;
    }
    if (s > downScore) {
      downScore = s;
      down = j;
    }
  }
  const firstDown = beats[down] ?? phase;
  const beatMs = Math.max(0, toMs(firstDown));

  // Energy per bar (4 beats from the first downbeat).
  const barLen = 4 * P;
  const bars: { start: number; e: number }[] = [];
  for (let b = firstDown; b + barLen <= rms.length; b += barLen) {
    let s = 0;
    for (let f = Math.round(b); f < Math.round(b + barLen); f++) s += rms[f];
    bars.push({ start: b, e: s / barLen });
  }
  const med = median(bars.map((b) => b.e));
  const firstLoud = bars.findIndex((b) => b.e >= 0.15 * med);
  let lastLoud = bars.length - 1;
  while (lastLoud > 0 && bars[lastLoud].e < 0.15 * med) lastLoud--;
  const mixInMs = Math.round(firstLoud > 0 ? toMs(bars[firstLoud].start) : beatMs);
  // Outro: the first 8-bar phrase after halfway from which the music stays quieter.
  let outBar = -1;
  for (let p = 8; p <= lastLoud - 4; p += 8) {
    if (p < bars.length / 2) continue;
    const tail = bars.slice(p, lastLoud + 1);
    const phrase = bars.slice(p, p + 8);
    const avg = (v: { e: number }[]) => v.reduce((s, b) => s + b.e, 0) / v.length;
    if (avg(tail) < 0.7 * med && avg(phrase) < 0.8 * med) {
      outBar = p;
      break;
    }
  }
  // No outro: 16 bars before the music ends, on a phrase line.
  // (Never before halfway: a short song still plays its first half alone.)
  if (outBar < 0) outBar = Math.max(Math.ceil(bars.length / 2 / 8) * 8, Math.floor((lastLoud + 1 - 16) / 8) * 8);
  const mixOutMs = Math.round(bars.length ? toMs(bars[Math.min(outBar, bars.length - 1)].start) : durationMs * 0.8);

  // Loudness: RMS of the louder half of the song.
  const sorted = Array.from(rms).sort((a, b) => b - a);
  const loudHalf = sorted.slice(0, Math.max(1, Math.floor(sorted.length / 2)));
  const loud = Math.sqrt(loudHalf.reduce((s, v) => s + v * v, 0) / loudHalf.length);
  const db = loud > 0 ? 20 * Math.log10(loud) : TARGET_DB;
  const gainDb = Math.round(Math.max(-12, Math.min(6, TARGET_DB - db)) * 10) / 10;

  return {
    bpm,
    beatMs: Math.round(beatMs),
    key: detectKey(x, rate),
    gainDb,
    mixInMs: Math.min(mixInMs, durationMs),
    mixOutMs: Math.min(Math.max(mixOutMs, mixInMs), durationMs),
    durationMs,
  };
}

/** Decodes a file to mono at the analysis rate. */
export async function decodeMono(file: Blob, rate = ANALYSIS_RATE): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, rate);
  const audio = await ctx.decodeAudioData(await file.arrayBuffer());
  const out = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < ch.length; i++) out[i] += ch[i] / audio.numberOfChannels;
  }
  return out;
}

export async function analyzeFile(file: Blob): Promise<TrackAnalysis> {
  const x = await decodeMono(file);
  await new Promise((r) => setTimeout(r, 0)); // let the page breathe between decoding and measuring
  return analyzeSamples(x, ANALYSIS_RATE);
}
