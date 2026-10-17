// Baseline-vs-Gemini evaluation (Doc 04 §6, GM-09).
// Usage: npm run eval --workspace=@crowdpulse/server -- [runsPerScenario=3]
// Needs GEMINI_API_KEY. Writes evidence/gemini/baseline-results.csv and prints a summary.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DEMO_TRACKS, type HostTarget, type Mood } from "@crowdpulse/shared";
import { DEFAULT_GEMINI_MODEL, GeminiClient } from "../src/gemini.js";
import { baselinePick, MOOD_TARGET_ENERGY, RecommendationService } from "../src/recommendation.js";
import { SessionStore } from "../src/session.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
  /* no .env */
}
if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is not set (add it to the repo-root .env).");
  process.exit(1);
}

interface Scenario {
  name: string;
  hostTarget: HostTarget;
  moods: Partial<Record<Mood, number>>;
  votes: Partial<Record<string, number>>;
}

// Fixed, repeatable scenarios. Some deliberately put votes and mood in tension.
const SCENARIOS: Scenario[] = [
  { name: "wild crowd, votes for a lofi track", hostTarget: "raise_energy", moods: { wild: 6, hyped: 2 }, votes: { track_02: 4, track_07: 2 } },
  { name: "chill crowd, votes for techno", hostTarget: "hold_steady", moods: { chill: 7, focused: 1 }, votes: { track_03: 3, track_04: 1 } },
  { name: "hyped crowd, clear matching leader", hostTarget: "raise_energy", moods: { hyped: 5 }, votes: { track_05: 5, track_06: 1 } },
  { name: "focused crowd, no votes yet", hostTarget: "hold_steady", moods: { focused: 4, chill: 1 }, votes: {} },
  { name: "mixed moods, tied votes", hostTarget: "hold_steady", moods: { chill: 2, hyped: 2, wild: 1 }, votes: { track_01: 2, track_06: 2 } },
  { name: "wild crowd, host wants to cool down", hostTarget: "cool_down", moods: { wild: 5 }, votes: { track_07: 4, track_04: 1 } },
];

const energyOf = new Map(DEMO_TRACKS.map((t) => [t.id, t.energy]));

function dominantMood(moods: Scenario["moods"]): Mood | null {
  const top = (Object.entries(moods) as [Mood, number][]).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

/** Proxy metric: track energy within 0.2 of the energy that fits the dominant mood. */
function preferenceFit(trackId: string | null, moods: Scenario["moods"]): boolean | null {
  const mood = dominantMood(moods);
  if (!trackId || !mood) return null;
  return Math.abs((energyOf.get(trackId) ?? 0) - MOOD_TARGET_ENERGY[mood]) <= 0.2;
}

async function seed(s: Scenario): Promise<SessionStore> {
  const store = new SessionStore("eval", "Evaluation");
  let n = 0;
  for (const [mood, count] of Object.entries(s.moods) as [Mood, number][]) {
    for (let i = 0; i < count; i++) {
      await store.recordMood({ mood, eventId: randomUUID(), participantId: `participant_${String(n++).padStart(4, "0")}` });
    }
  }
  for (const [trackId, count] of Object.entries(s.votes) as [string, number][]) {
    for (let i = 0; i < count; i++) {
      await store.submitVote({ trackId, eventId: randomUUID(), participantId: `participant_v${String(i).padStart(4, "0")}` });
    }
  }
  return store;
}

const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

const runs = Math.max(1, Number(process.argv[2] ?? 3));
const model = new GeminiClient(process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, 20_000);
const rows: string[] = [
  "scenario,run,host_target,dominant_mood,method,track_id,track_energy,preference_fit,valid,available,latency_ms,model_version,theme,intensity,reason",
];
const latencies: number[] = [];
const tally = { gemini: { fit: 0, scored: 0, valid: 0, available: 0, n: 0 }, baseline: { fit: 0, scored: 0, n: 0 } };
const csv = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;

console.log(`Evaluating ${SCENARIOS.length} scenarios × ${runs} runs with ${model.model}…`);
for (const s of SCENARIOS) {
  const mood = dominantMood(s.moods);
  for (let run = 1; run <= runs; run++) {
    const store = await seed(s);
    const base = baselinePick(store.getState());
    const bFit = preferenceFit(base.trackId, s.moods);
    tally.baseline.n++;
    if (bFit != null) {
      tally.baseline.scored++;
      if (bFit) tally.baseline.fit++;
    }
    rows.push(
      [s.name, run, s.hostTarget, mood, "baseline", base.trackId, energyOf.get(base.trackId ?? ""), bFit, true, true, 0, "", "", "", base.reason]
        .map(csv)
        .join(","),
    );

    const svc = new RecommendationService(store, model);
    const { recommendation: r } = (await svc.recommend(s.hostTarget)) as { recommendation: import("@crowdpulse/shared").Recommendation };
    const available = r.status !== "failed";
    const valid = r.status === "pending";
    const trackId = r.proposal?.recommended_track_id ?? null;
    const gFit = valid ? preferenceFit(trackId, s.moods) : null;
    tally.gemini.n++;
    if (available) tally.gemini.available++;
    if (valid) tally.gemini.valid++;
    if (gFit != null) {
      tally.gemini.scored++;
      if (gFit) tally.gemini.fit++;
    }
    if (r.latencyMs != null && available) latencies.push(r.latencyMs);
    rows.push(
      [
        s.name, run, s.hostTarget, mood, "gemini", trackId, energyOf.get(trackId ?? ""), gFit, valid, available,
        r.latencyMs, r.modelVersion, r.proposal?.visual_theme, r.proposal?.intensity,
        r.proposal?.reason ?? r.validationErrors.join("; "),
      ]
        .map(csv)
        .join(","),
    );
    process.stdout.write(valid ? "." : available ? "x" : "!");
  }
}

const outDir = path.join(root, "evidence/gemini");
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "baseline-results.csv"), rows.join("\n") + "\n");

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}% (${a}/${b})` : "n/a");
const summary = [
  `CrowdPulse AI DJ evaluation — ${new Date().toISOString()}`,
  `Model: ${model.model}; ${SCENARIOS.length} fixed scenarios × ${runs} runs = ${tally.gemini.n} Gemini calls`,
  ``,
  `Preference fit (track energy within 0.2 of dominant-mood target; proxy metric):`,
  `  Baseline (majority vote): ${pct(tally.baseline.fit, tally.baseline.scored)}`,
  `  Gemini:                   ${pct(tally.gemini.fit, tally.gemini.scored)}`,
  `Action validity (accepted by server validator): ${pct(tally.gemini.valid, tally.gemini.n)}`,
  `Availability (call completed, no fallback):     ${pct(tally.gemini.available, tally.gemini.n)}`,
  latencies.length
    ? `Latency: median ${percentile(latencies, 50)} ms` +
      (latencies.length >= 20 ? `, p95 ${percentile(latencies, 95)} ms` : `, max ${Math.max(...latencies)} ms (n=${latencies.length}; too few for p95)`)
    : `Latency: no successful calls`,
  ``,
  `Not measured: engagement change after a transition (needs a live crowd).`,
  `Limitations: small fixed scenario set; preference fit is a proxy that ignores votes and host target,`,
  `so scenarios where votes or the host target conflict with mood can favor either method. Report wins and losses.`,
].join("\n");
writeFileSync(path.join(outDir, "evaluation-summary.txt"), summary + "\n");
console.log(`\n\n${summary}\n\nWrote evidence/gemini/baseline-results.csv and evaluation-summary.txt`);
