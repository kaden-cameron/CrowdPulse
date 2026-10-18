import { describe, expect, it } from "vitest";
import { camelotDistance, mixCompatibility, planTransition, ruleStyle, tempoMatch, toCamelot, type TrackAnalysis } from "@crowdpulse/shared";

const song = (bpm: number, key: string | null, extra: Partial<TrackAnalysis> = {}): TrackAnalysis => ({
  bpm,
  beatMs: 300,
  key,
  gainDb: 0,
  mixInMs: 300,
  mixOutMs: 180_000,
  durationMs: 210_000,
  ...extra,
});

describe("AI DJ transition planning", () => {
  it("Camelot keys and distances", () => {
    expect(toCamelot(9, true)).toBe("8A"); // A minor
    expect(toCamelot(0, false)).toBe("8B"); // C major
    expect(camelotDistance("8A", "8A")).toBe(0);
    expect(camelotDistance("8A", "9A")).toBe(1);
    expect(camelotDistance("8A", "8B")).toBe(1);
    expect(camelotDistance("12A", "1A")).toBe(1);
    expect(camelotDistance("8A", "2A")).toBe(6);
  });

  it("matches tempos, counting half / double time", () => {
    expect(tempoMatch(124, 126).rate).toBeCloseTo(124 / 126, 4);
    expect(tempoMatch(140, 70)).toEqual({ rate: 2, stretch: 0 });
    expect(tempoMatch(128, 174).stretch).toBeGreaterThan(0.08);
  });

  it("a blend starts on a bar line before the outro and finishes before the song ends", () => {
    const from = song(124, "8A", { mixOutMs: 190_000 }); // outro too late for 16 bars
    const plan = planTransition(from, song(126, "9A"), { style: "blend", bars: 16 });
    const bar = (4 * 60_000) / 124;
    expect(plan.style).toBe("blend");
    expect(plan.lengthMs).toBeCloseTo(16 * bar, -1);
    expect(plan.outAtMs + plan.lengthMs).toBeLessThanOrEqual(from.durationMs - 1_000);
    const bars = (plan.outAtMs - from.beatMs) / bar;
    expect(Math.abs(bars - Math.round(bars))).toBeLessThan(0.001); // on a bar line
    expect(plan.inFromMs).toBe(300);
    expect(plan.rate).toBeCloseTo(124 / 126, 3);
  });

  it("styles that need matching tempos fall back to echo out; echo and cut don't stretch", () => {
    const plan = planTransition(song(124, "8A"), song(174, "8A"), { style: "blend", bars: 16 });
    expect(plan.style).toBe("echo");
    expect(plan.rate).toBe(1);
    expect(plan.reason).toMatch(/too far apart/);
    expect(planTransition(song(124, "8A"), song(126, "8A"), { style: "cut", bars: 16 })).toMatchObject({ style: "cut", lengthMs: 0, rate: 1 });
  });

  it("rules: blend when tempo and key fit, filter when only tempo does", () => {
    expect(ruleStyle(song(124, "8A"), song(125, "9A"))).toBe("blend");
    expect(ruleStyle(song(124, "8A"), song(125, "2B"))).toBe("filter");
    expect(ruleStyle(song(124, "8A"), song(90, "8A"))).toBe("echo");
    expect(mixCompatibility(song(124, "8A"), song(125, "9A"))).toBeGreaterThan(mixCompatibility(song(124, "8A"), song(90, "2B")));
  });
});
