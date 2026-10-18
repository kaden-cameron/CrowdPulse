// Baseline-vs-Gemini evaluation (Doc 04 §6, GM-09).
// Usage: npm run eval --workspace=@crowdpulse/server -- [runsPerScenario=3]
// Needs GEMINI_API_KEY. Writes evidence/gemini/baseline-results.csv and prints a summary.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DEMO_TRACKS, type HostTarget } from "@crowdpulse/shared";
import { DEFAULT_GEMINI_MODEL, GeminiClient } from "../src/gemini.js";
import { baselinePick, RecommendationService } from "../src/recommendation.js";
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
  /** Crowd energy levels (0–100) seeded as one attendee each. */
  energies: number[];
  votes: Partial<Record<string, number>>;
}

// Fixed, repeatable scenarios. Some deliberately put votes and crowd energy in tension.
const SCENARIOS: Scenario[] = [
  { name: "high energy crowd, votes for a lofi track", hostTarget: "raise_energy", energies: [95, 90, 100, 85, 90, 100, 80, 85], votes: { track_02: 4, track_07: 2 } },
  { name: "low energy crowd, votes for techno", hostTarget: "hold_steady", energies: [15, 20, 10, 25, 20, 15, 20, 30], votes: { track_03: 3, track_04: 1 } },
  { name: "hyped crowd, clear matching leader", hostTarget: "raise_energy", energies: [75, 80, 70, 85, 75], votes: { track_05: 5, track_06: 1 } },
  { name: "focused mid energy, no votes yet", hostTarget: "hold_steady", energies: [45, 50, 40, 55, 45], votes: {} },
  { name: "mixed energy, tied votes", hostTarget: "hold_steady", energies: [20, 25, 75, 80, 90], votes: { track_01: 2, track_06: 2 } },
  { name: "high energy crowd, host wants to cool down", hostTarget: "cool_down", energies: [90, 95, 100, 85, 90], votes: { track_07: 4, track_04: 1 } },
];

const energyOf = new Map(DEMO_TRACKS.map((t) => [t.id, t.energy]));

function averageEnergy(energies: number[]): number {
  return energies.reduce((s, n) => s + n, 0) / energies.length;
}

/** Proxy metric: track energy within 0.2 of the crowd's average energy (0–1). */
function preferenceFit(trackId: string | null, energies: number[]): boolean | null {
  if (!trackId || !energies.length) return null;
  return Math.abs((energyOf.get(trackId) ?? 0) - averageEnergy(energies) / 100) <= 0.2;
}

async function seed(s: Scenario): Promise<SessionStore> {
  const store = new SessionStore("eval", "Evaluation");
  let n = 0;
  for (const energy of s.energies) {
    await store.recordEnergy({ energy, eventId: randomUUID(), participantId: `participant_${String(n++).padStart(4, "0")}` });
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
  "scenario,run,host_target,crowd_energy_avg,method,track_id,track_energy,preference_fit,valid,available,latency_ms,model_version,theme,intensity,reason",
];

let prefHits = { baseline: 0, gemini: 0, n: 0 };
const latencies: number[] = [];

for (const s of SCENARIOS) {
  const avg = Math.round(averageEnergy(s.energies));
  for (let run = 1; run <= runs; run++) {
    const store = await seed(s);
    const base = baselinePick(store.getState());
    const bFit = preferenceFit(base.trackId, s.energies);
    rows.push(
      [
        s.name, run, s.hostTarget, avg, "baseline", base.trackId, energyOf.get(base.trackId ?? ""), bFit, true, true, 0, "", "", "", base.reason,
      ]
        .map((x) => JSON.stringify(x ?? ""))
        .join(","),
    );

    const svc = new RecommendationService(store, model);
    const t0 = performance.now();
    const rec = await svc.recommend(s.hostTarget);
    const latency = Math.round(performance.now() - t0);
    latencies.push(latency);
    const valid = !!rec.proposal;
    const available = rec.status === "ok" || rec.status === "rejected_by_validator";
    const trackId = rec.proposal?.recommended_track_id ?? null;
    const gFit = valid ? preferenceFit(trackId, s.energies) : null;
    if (bFit != null && gFit != null) {
      prefHits.n++;
      if (bFit) prefHits.baseline++;
      if (gFit) prefHits.gemini++;
    }
    rows.push(
      [
        s.name, run, s.hostTarget, avg, "gemini", trackId, energyOf.get(trackId ?? ""), gFit, valid, available,
        latency, rec.modelVersion ?? "", rec.proposal?.visual_theme ?? "", rec.proposal?.intensity ?? "", rec.proposal?.reason ?? rec.error ?? "",
      ]
        .map((x) => JSON.stringify(x ?? ""))
        .join(","),
    );
  }
}

const outDir = path.join(root, "evidence/gemini");
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "baseline-results.csv"), rows.join("\n") + "\n");
const summary = [
  `Preference fit (track energy within 0.2 of crowd-energy average; proxy metric):`,
  `  baseline ${prefHits.baseline}/${prefHits.n}  gemini ${prefHits.gemini}/${prefHits.n}`,
  `Gemini latency ms: median ${percentile(latencies, 50)}  p95 ${latencies.length >= 20 ? percentile(latencies, 95) : "n/a (<20)"}`,
  ``,
  `so scenarios where votes or the host target conflict with crowd energy can favor either method. Report wins and losses.`,
].join("\n");
writeFileSync(path.join(outDir, "evaluation-summary.txt"), summary + "\n");
console.log(summary);
