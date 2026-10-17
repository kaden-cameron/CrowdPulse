/**
 * Lightweight load test for CrowdPulse vote API (PDF 02 targets).
 * Usage: node scripts/load-test.mjs [baseUrl] [concurrency] [votesPerClient]
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const CONCURRENCY = Number(process.argv[3] ?? 25);
const VOTES_PER_CLIENT = Number(process.argv[4] ?? 4);
const TRACKS = [
  "track_01",
  "track_02",
  "track_03",
  "track_04",
  "track_05",
  "track_06",
  "track_07",
];

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[idx];
}

async function oneVote(clientId, i) {
  const started = performance.now();
  try {
    const res = await fetch(`${BASE}/api/sessions/demo/votes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "demo",
        trackId: TRACKS[i % TRACKS.length],
        eventId: randomUUID(),
        participantId: `load_${clientId}_${i}`,
      }),
    });
    const latencyMs = performance.now() - started;
    const intentional =
      res.status === 429 || res.status === 400 || res.status === 409;
    return {
      ok: res.status === 200,
      latencyMs,
      intentionalError: intentional,
    };
  } catch {
    return {
      ok: false,
      latencyMs: performance.now() - started,
      intentionalError: false,
    };
  }
}

const startedAt = new Date().toISOString();
const wallStart = performance.now();
const results = [];

await Promise.all(
  Array.from({ length: CONCURRENCY }, async (_, clientId) => {
    for (let i = 0; i < VOTES_PER_CLIENT; i++) {
      results.push(await oneVote(clientId, i));
      await new Promise((r) => setTimeout(r, 15 + (clientId % 5)));
    }
  }),
);

const wallMs = performance.now() - wallStart;
const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
const ok = results.filter((r) => r.ok).length;
const errors = results.filter((r) => !r.ok && !r.intentionalError).length;
const intentional = results.filter((r) => r.intentionalError).length;
const total = results.length;
const errorRate =
  total - intentional === 0 ? 0 : errors / (total - intentional);

const summary = {
  startedAt,
  finishedAt: new Date().toISOString(),
  baseUrl: BASE,
  concurrency: CONCURRENCY,
  votesPerClient: VOTES_PER_CLIENT,
  totalRequests: total,
  acceptedOrDuplicateOk: ok,
  unintentionalErrors: errors,
  intentionalClientErrors: intentional,
  requestRateRps: Number(((total / wallMs) * 1000).toFixed(2)),
  latencyMs: {
    p50: latencies.length ? Number(percentile(latencies, 50).toFixed(2)) : null,
    p95: latencies.length ? Number(percentile(latencies, 95).toFixed(2)) : null,
    max: latencies.length ? Number(latencies.at(-1).toFixed(2)) : null,
  },
  errorRateExcludingIntentional: Number(errorRate.toFixed(4)),
  targets: { voteApiP95Ms: 500, voteErrorsMax: 0.01 },
  notes:
    "Measured against local/demo server. Intentional 4xx excluded from error rate.",
};

const outDir = join(ROOT, "docs");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "02_LOAD_TEST_RESULTS.json");
writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`\nWrote ${outPath}`);
