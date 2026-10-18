// Staged load test (Doc 07 §5, VU-06). Ramps 5 → 10 → 25 → 50 virtual attendees. Each holds a
// WebSocket subscription like a real phone and sends a mix of taps, votes and moods (~1 action/s).
// Records request rate, p50/p95 latency, HTTP error rate, WebSocket disconnects, and how long a
// vote takes to come back over the socket. Results are test measurements for the stated target
// and client machine — not claimed capacity.
//
// Usage: node scripts/load-plan.mjs [--url http://localhost:8787] [--stages 5,10,25,50]
//          [--seconds 20] [--session demo]
// Writes evidence/vultr/load-test-summary.txt and load-test-results.json.
// Load tests from one machine share one IP; the server's per-IP backstop (default 6000/min)
// is sized for that. Don't point this at a server you don't control.

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const BASE = (args.url ?? "http://localhost:8787").replace(/\/$/, "");
const WS_URL = `${BASE.replace(/^http/, "ws")}/ws`;
const SESSION = args.session ?? "demo";
const STAGES = (args.stages ?? "5,10,25,50").split(",").map(Number).filter((n) => n > 0 && n <= 200);
const SECONDS = Math.max(5, Math.min(300, Number(args.seconds ?? 20)));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOODS = ["chill", "hyped", "focused", "wild"];

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = await fetch(`${BASE}/api/sessions/${SESSION}/state`).then((r) => {
  if (!r.ok) throw new Error(`Session "${SESSION}" not reachable at ${BASE} (HTTP ${r.status})`);
  return r.json();
});
const tracks = state.tracks.map((t) => t.id);

async function runStage(users) {
  const m = { requests: 0, byStatus: {}, latencies: [], voteToSocket: [], wsOpened: 0, wsFailed: 0, wsDropped: 0, messages: 0 };
  const deadline = Date.now() + SECONDS * 1000;

  async function attendee(n) {
    // Signed ids from the server (start it with a high PARTICIPANTS_PER_IP_HOUR for big runs).
    const idRes = await fetch(`${BASE}/api/participants`, { method: "POST" });
    const participantId = idRes.ok ? (await idRes.json()).participantId : `load_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const voted = new Set();
    const waiting = new Map(); // version → request start
    const seen = []; // recent { version, at } from this socket (updates can beat the HTTP response)
    let closing = false;

    const ws = await new Promise((resolve) => {
      const s = new WebSocket(WS_URL);
      s.addEventListener("open", () => {
        m.wsOpened++;
        s.send(JSON.stringify({ type: "client.hello", role: "attendee", sessionId: SESSION }));
        resolve(s);
      });
      s.addEventListener("error", () => {
        m.wsFailed++;
        resolve(null);
      });
      s.addEventListener("close", () => {
        if (!closing) m.wsDropped++;
      });
      s.addEventListener("message", (ev) => {
        m.messages++;
        const msg = JSON.parse(ev.data);
        if (msg.type !== "session.state") return;
        const at = performance.now();
        seen.push({ version: msg.version, at });
        if (seen.length > 50) seen.shift();
        for (const [v, t0] of waiting) {
          if (msg.version >= v) {
            m.voteToSocket.push(at - t0);
            waiting.delete(v);
          }
        }
      });
    });

    const post = async (p, body) => {
      const t0 = performance.now();
      let status = 0;
      let json = null;
      try {
        const res = await fetch(`${BASE}${p}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: SESSION, eventId: randomUUID(), participantId, ...body }),
        });
        status = res.status;
        json = await res.json().catch(() => null);
      } catch {
        status = 0;
      }
      m.requests++;
      m.byStatus[status] = (m.byStatus[status] ?? 0) + 1;
      m.latencies.push(performance.now() - t0);
      return { status, json, t0 };
    };

    await post(`/api/sessions/${SESSION}/moods`, { mood: MOODS[n % MOODS.length] });
    await sleep(Math.random() * 1000); // spread start times
    while (Date.now() < deadline) {
      const r = Math.random();
      if (r < 0.3 && voted.size < tracks.length) {
        const trackId = tracks.find((t) => !voted.has(t) && Math.random() < 0.5) ?? tracks.find((t) => !voted.has(t));
        voted.add(trackId);
        const res = await post(`/api/sessions/${SESSION}/votes`, { trackId });
        const v = res.json?.state?.version;
        if (res.status === 200 && v && ws) {
          const early = seen.find((x) => x.version >= v && x.at >= res.t0);
          if (early) m.voteToSocket.push(early.at - res.t0);
          else waiting.set(v, res.t0);
        }
      } else if (r < 0.9) {
        await post(`/api/sessions/${SESSION}/taps`, { count: 1 + Math.floor(Math.random() * 5) });
      } else {
        await post(`/api/sessions/${SESSION}/moods`, { mood: MOODS[Math.floor(Math.random() * MOODS.length)] });
      }
      await sleep(700 + Math.random() * 600); // ~1 action per second per attendee
    }
    await sleep(300);
    closing = true;
    ws?.close();
  }

  const t0 = performance.now();
  await Promise.all(Array.from({ length: users }, (_, n) => attendee(n)));
  const wallS = (performance.now() - t0) / 1000;
  const errors = Object.entries(m.byStatus)
    .filter(([s]) => s === "0" || Number(s) >= 500)
    .reduce((a, [, n]) => a + n, 0);
  const limited = m.byStatus[429] ?? 0;
  return {
    users,
    seconds: SECONDS,
    requests: m.requests,
    rps: +(m.requests / wallS).toFixed(1),
    p50Ms: pct(m.latencies, 50),
    p95Ms: pct(m.latencies, 95),
    maxMs: pct(m.latencies, 100),
    errorRate: m.requests ? +(errors / m.requests).toFixed(4) : 0,
    rateLimited: limited,
    statusCounts: m.byStatus,
    wsOpened: m.wsOpened,
    wsFailed: m.wsFailed,
    wsDropped: m.wsDropped,
    wsMessages: m.messages,
    voteToSocketP50Ms: pct(m.voteToSocket, 50),
    voteToSocketP95Ms: pct(m.voteToSocket, 95),
    voteSamples: m.voteToSocket.length,
  };
}

const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => ({}));
const startedAt = new Date().toISOString();
console.log(`Load plan against ${BASE} — stages ${STAGES.join(" → ")} users × ${SECONDS}s (database ${health.database ?? "?"})\n`);
const results = [];
for (const users of STAGES) {
  process.stdout.write(`  ${String(users).padStart(3)} users… `);
  const r = await runStage(users);
  results.push(r);
  console.log(
    `${r.rps} req/s · p50 ${r.p50Ms} ms · p95 ${r.p95Ms} ms · errors ${(r.errorRate * 100).toFixed(2)}% · 429s ${r.rateLimited} · ` +
      `WS ${r.wsOpened} open / ${r.wsFailed} failed / ${r.wsDropped} dropped · vote→socket p95 ${r.voteToSocketP95Ms ?? "—"} ms`,
  );
  await sleep(2000);
}

const pass = (r) => r.p95Ms != null && r.p95Ms < 500 && r.errorRate < 0.01 && r.wsDropped === 0 && r.wsFailed === 0;
const local = /localhost|127\.0\.0\.1/.test(BASE);
const lines = [
  `CrowdPulse load test (Doc 07 §5 / VU-06)`,
  `Target:   ${BASE}${local ? "  (LOCAL — rerun against the deployed URL for VU-06)" : ""}`,
  `Server:   database=${health.database ?? "?"} gemini=${health.gemini ?? "?"}`,
  `Client:   ${os.platform()} ${os.release()} · ${os.cpus().length} CPU · Node ${process.version}`,
  `Started:  ${startedAt}`,
  `Mix:      per attendee ~1 action/s — 60% hype taps, 30% votes, 10% mood changes; each holds a WebSocket`,
  `Targets:  vote API p95 < 500 ms, errors < 1% (5xx + network), no WebSocket drops (Doc 02 §6)`,
  ``,
  `Users | Req/s | p50 ms | p95 ms | max ms | Errors | 429s | WS open/failed/dropped | Vote→socket p50/p95 ms | Meets targets`,
  `------|-------|--------|--------|--------|--------|------|------------------------|------------------------|--------------`,
  ...results.map(
    (r) =>
      `${String(r.users).padStart(5)} | ${String(r.rps).padStart(5)} | ${String(r.p50Ms).padStart(6)} | ${String(r.p95Ms).padStart(6)} | ${String(r.maxMs).padStart(6)} | ${(r.errorRate * 100).toFixed(2).padStart(5)}% | ${String(r.rateLimited).padStart(4)} | ${`${r.wsOpened}/${r.wsFailed}/${r.wsDropped}`.padStart(22)} | ${`${r.voteToSocketP50Ms ?? "—"}/${r.voteToSocketP95Ms ?? "—"}`.padStart(22)} | ${pass(r) ? "yes" : "NO"}`,
  ),
  ``,
  `These are measurements for this target, client and mix only — not a capacity claim.`,
];
const outDir = path.join(root, "evidence/vultr");
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "load-test-summary.txt"), lines.join("\n") + "\n");
writeFileSync(
  path.join(outDir, "load-test-results.json"),
  JSON.stringify({ target: BASE, startedAt, client: { node: process.version, platform: os.platform() }, server: health, stages: results }, null, 2),
);
console.log(`\n${lines.slice(8).join("\n")}\n\nWrote evidence/vultr/load-test-summary.txt`);
process.exit(results.every(pass) ? 0 : 1);
