import { describe, expect, it } from "vitest";
import { analyzeSamples, detectKey } from "./analyze";
import { guessFromName, localIdFor } from "./files";

// A synthetic song: kick on every beat (louder on beat 1), hi-hats on the off-beats, an A minor pad.
function song({ bpm, firstMs, seconds, rate = 11_025, pad = [220, 261.63, 329.63], outroFromS }: { bpm: number; firstMs: number; seconds: number; rate?: number; pad?: number[]; outroFromS?: number }) {
  const x = new Float32Array(Math.round(seconds * rate));
  const beat = 60 / bpm;
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let k = 0; firstMs / 1000 + k * beat < seconds; k++) {
    const t0 = firstMs / 1000 + k * beat;
    const quiet = outroFromS != null && t0 >= outroFromS ? 0.25 : 1;
    const amp = (k % 4 === 0 ? 1 : 0.55) * quiet;
    for (let i = 0; i < 0.15 * rate; i++) {
      const n = Math.round(t0 * rate) + i;
      if (n >= x.length) break;
      x[n] += amp * Math.sin(2 * Math.PI * 55 * (i / rate)) * Math.exp(-i / (0.04 * rate));
    }
    const off = Math.round((t0 + beat / 2) * rate);
    for (let i = 0; i < 0.03 * rate && off + i < x.length; i++) x[off + i] += 0.15 * quiet * noise() * Math.exp(-i / (0.008 * rate));
  }
  for (let n = 0; n < x.length; n++) {
    const t = n / rate;
    const quiet = outroFromS != null && t >= outroFromS ? 0.25 : 1;
    for (const f of pad) x[n] += 0.06 * quiet * Math.sin(2 * Math.PI * f * t);
  }
  return x;
}

describe("local song analysis (AI DJ)", () => {
  it("finds the tempo, the first downbeat and the key", () => {
    const a = analyzeSamples(song({ bpm: 124, firstMs: 350, seconds: 60 }), 11_025);
    expect(a.bpm).toBeGreaterThan(123.8);
    expect(a.bpm).toBeLessThan(124.2);
    // The first downbeat (bars of 4 from there), within a few ms.
    expect(Math.abs(a.beatMs - 350)).toBeLessThan(40);
    expect(a.key).toBe("8A");
    expect(a.durationMs).toBe(60_000);
    expect(a.mixOutMs).toBeGreaterThan(a.mixInMs);
  });

  it("works at other tempos", () => {
    for (const bpm of [95, 128, 140]) {
      const a = analyzeSamples(song({ bpm, firstMs: 120, seconds: 45 }), 11_025);
      expect(Math.abs(a.bpm - bpm)).toBeLessThan(0.3);
    }
  });

  it("puts the mix-out point at the start of a quiet outro", () => {
    const bpm = 120; // 2 s per bar; outro from bar 48 (96 s + the 0.5 s lead)
    const a = analyzeSamples(song({ bpm, firstMs: 500, seconds: 120, outroFromS: 96.5 }), 11_025);
    expect(Math.abs(a.mixOutMs - 96_500)).toBeLessThan(2_100);
  });

  it("C major chord → 8B; no tones → no key", () => {
    const rate = 11_025;
    const x = new Float32Array(rate * 10);
    for (let n = 0; n < x.length; n++) for (const f of [261.63, 329.63, 392, 130.81]) x[n] += 0.1 * Math.sin((2 * Math.PI * f * n) / rate);
    expect(detectKey(x, rate)).toBe("8B");
    expect(detectKey(new Float32Array(rate * 2), rate)).toBeNull();
  });
});

describe("local files", () => {
  it("the same file always gets the same id", () => {
    const a = localIdFor({ name: "One More Time.mp3", size: 1234 });
    expect(a).toMatch(/^lf_[0-9a-f]{16}$/);
    expect(localIdFor({ name: "One More Time.mp3", size: 1234 })).toBe(a);
    expect(localIdFor({ name: "One More Time.mp3", size: 1235 })).not.toBe(a);
  });

  it("guesses artist and title from the file name", () => {
    expect(guessFromName("03 - Daft Punk - One More Time.mp3")).toEqual({ artist: "Daft Punk", title: "One More Time" });
    expect(guessFromName("Kaytranada – Glowed Up.flac")).toEqual({ artist: "Kaytranada", title: "Glowed Up" });
    expect(guessFromName("07 Untitled.wav")).toEqual({ artist: "Unknown artist", title: "Untitled" });
  });
});
