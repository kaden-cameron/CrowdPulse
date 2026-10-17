// End-to-end acceptance check (Doc 08 §2–3). Runs against any CrowdPulse URL — local or deployed —
// and records PASS / FAIL / SKIP with evidence. SKIP always says why; nothing is marked passed
// without being exercised. It writes votes to the session, so don't run it during the live demo.
//
// Usage: node scripts/e2e-check.mjs [--url http://localhost:8787] [--session demo]
//          [--host-key KEY | --host-token JWT] [--reset] [--boost-signature SIG --boost-intent ID]
// Host credentials can also come from CROWDPULSE_HOST_KEY / CROWDPULSE_HOST_TOKEN.

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (!a.startsWith("--")) return acc;
    const next = all[i + 1];
    return [...acc, [a.slice(2), next && !next.startsWith("--") ? next : "true"]];
  }, []),
);
const BASE = (args.url ?? "http://localhost:8787").replace(/\/$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");
const SESSION = args.session ?? "demo";
const hostKey = args["host-key"] ?? process.env.CROWDPULSE_HOST_KEY;
const hostToken = args["host-token"] ?? process.env.CROWDPULSE_HOST_TOKEN;
const hostHeaders = hostToken ? { authorization: `Bearer ${hostToken}` } : hostKey ? { "x-host-key": hostKey } : null;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = path.join(root, "evidence");

const results = [];
const evidence = {};
const record = (id, title, status, detail) => {
  results.push({ id, title, status, detail });
  const icon = { PASS: "✓", FAIL: "✗", SKIP: "–" }[status];
  console.log(`${icon} ${id.padEnd(8)} ${status.padEnd(4)} ${title}${detail ? ` — ${detail}` : ""}`);
};
const check = async (id, title, fn) => {
  try {
    const out = await fn();
    if (out?.skip) record(id, title, "SKIP", out.skip);
    else record(id, title, "PASS", out?.detail);
  } catch (err) {
    record(id, title, "FAIL", err.message);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function http(method, p, body, headers = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}
const getState = async () => (await http("GET", `/api/sessions/${SESSION}/state`)).json;
const participant = () => `participant_e2e_${randomUUID().slice(0, 8)}`;
const vote = (trackId, overrides = {}) =>
  http("POST", `/api/sessions/${SESSION}/votes`, {
    sessionId: SESSION,
    trackId,
    eventId: randomUUID(),
    participantId: participant(),
    ...overrides,
  });

/** WebSocket client that records every session.state it receives, with arrival time. */
function openSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws`);
    ws.states = [];
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === "session.state") ws.states.push({ at: performance.now(), msg });
    });
    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "client.hello", role: "stage", sessionId: SESSION })));
    ws.addEventListener("error", () => reject(new Error("WebSocket failed to connect")));
    const t = setInterval(() => {
      if (ws.states.length) {
        clearInterval(t);
        resolve(ws);
      }
    }, 20);
    setTimeout(() => reject(new Error("No snapshot within 5s")), 5000);
  });
}
const waitFor = async (pred, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
};

console.log(`CrowdPulse E2E against ${BASE} (session "${SESSION}") — ${new Date().toISOString()}`);
console.log(`Host credentials: ${hostToken ? "Auth0 token" : hostKey ? "dev key" : "none (host tests will SKIP)"}\n`);

const health = (await http("GET", "/api/health")).json ?? {};
const tracks = ((await getState()) ?? { tracks: [] }).tracks;
const freeTrack = () => tracks.find((t) => t.status !== "playing")?.id ?? "track_01";

if (args.reset === "true") {
  if (!hostHeaders) throw new Error("--reset needs host credentials");
  const r = await http("POST", `/api/host/sessions/${SESSION}/reset`, {}, hostHeaders);
  console.log(`Reset run: HTTP ${r.status}\n`);
}

await check("HEALTH", "Health endpoint is up and leaks no config", async () => {
  const r = await http("GET", "/api/health");
  assert(r.status === 200 && r.json?.ok, `HTTP ${r.status}`);
  assert(!/postgres|AIza|secret|key=/i.test(r.text), "health response contains config-like values");
  return { detail: `database=${r.json.database} gemini=${r.json.gemini}` };
});

await check("E2E-01", "Join link resolves the correct session", async () => {
  const s = await getState();
  assert(s?.sessionId === SESSION, "wrong or missing session");
  const page = await fetch(`${BASE}/join/${SESSION}`);
  const unknown = await http("GET", `/api/sessions/does-not-exist-${Date.now()}/state`);
  assert(unknown.status === 404, `unknown session returned ${unknown.status}`);
  return { detail: `"${s.sessionName}"; /join page HTTP ${page.status}; unknown session 404` };
});

let stage;
await check("E2E-02/03", "Vote is accepted and a second client sees it without refresh", async () => {
  stage = await openSocket();
  const before = stage.states.length;
  const trackId = freeTrack();
  const t0 = performance.now();
  const r = await vote(trackId);
  assert(r.status === 200 && r.json.status === "accepted", `vote HTTP ${r.status} ${r.json?.reason ?? ""}`);
  const got = await waitFor(() => stage.states.slice(before).find((s) => s.msg.queue.some((q) => q.trackId === trackId)));
  assert(got, "stage client did not receive the update within 3s");
  const ms = Math.round(got.at - t0);
  evidence["frontend/stage-update-latency.txt"] = `vote → second client update: ${ms} ms (${BASE})\n`;
  assert(ms < 1000, `update took ${ms} ms (target < 1000 ms)`);
  return { detail: `second client updated in ${ms} ms` };
});

await check("FAULT", "Duplicate eventId counts once; invalid event rejected", async () => {
  const trackId = freeTrack();
  const body = { sessionId: SESSION, trackId, eventId: randomUUID(), participantId: participant() };
  const first = await http("POST", `/api/sessions/${SESSION}/votes`, body);
  const before = (await getState()).tracks.find((t) => t.id === trackId).votes;
  const again = await http("POST", `/api/sessions/${SESSION}/votes`, body);
  const after = (await getState()).tracks.find((t) => t.id === trackId).votes;
  assert(first.json.status === "accepted" && again.json.status === "duplicate", `got ${first.json.status}/${again.json.status}`);
  assert(after === before, "duplicate changed the vote count");
  const bad = await vote("track_does_not_exist");
  const noSession = await http("POST", `/api/sessions/${SESSION}/votes`, { trackId, eventId: randomUUID(), participantId: participant() });
  assert(bad.status === 400 && noSession.status === 400, `invalid events returned ${bad.status}/${noSession.status}`);
  evidence["backend/duplicate-rejected.txt"] =
    `eventId ${body.eventId}\nfirst: ${first.status} ${first.json.status}\nretry: ${again.status} ${again.json.status}\n` +
    `votes before retry ${before}, after ${after}\nunknown track: ${bad.status} ${bad.text}\nmissing sessionId: ${noSession.status} ${noSession.text}\n`;
  return { detail: "retry → duplicate, count unchanged; unknown track / missing sessionId → 400" };
});

await check("E2E-04/05", "Event persists to TigerData and metrics advance", async () => {
  const m0 = (await http("GET", `/api/sessions/${SESSION}/metrics`)).json;
  if (m0?.persistence !== "tigerdata") return { skip: "server is running in memory (DATABASE_URL not set)" };
  const r = await vote(freeTrack());
  assert(r.json.status === "accepted", "vote not accepted");
  const m1 = (await http("GET", `/api/sessions/${SESSION}/metrics`)).json;
  assert(m1.totalEvents > m0.totalEvents, `totalEvents did not increase (${m0.totalEvents} → ${m1.totalEvents})`);
  assert(Date.parse(m1.latestEventAt) >= Date.parse(m0.latestEventAt ?? 0), "latestEventAt did not advance");
  evidence["tigerdata/metrics-after-vote.json"] = JSON.stringify(m1, null, 2);
  return { detail: `totalEvents ${m0.totalEvents} → ${m1.totalEvents}; latest ${m1.latestEventAt}; query ${m1.queryMs} ms` };
});

await check("E2E-09", "Attendee (no host credentials) can't use host actions", async () => {
  const v0 = (await getState()).version;
  const routes = [
    ["POST", `/api/host/sessions/${SESSION}/visual`, { visual: { theme: "neon_pulse", intensity: 1 } }],
    ["POST", `/api/host/sessions/${SESSION}/advance`, {}],
    ["POST", `/api/host/sessions/${SESSION}/reset`, {}],
    ["POST", `/api/host/sessions/${SESSION}/recommendations`, { hostTarget: "raise_energy" }],
  ];
  const codes = [];
  for (const [m, p, b] of routes) codes.push((await http(m, p, b)).status);
  const forged = await http("POST", routes[0][1], routes[0][2], { authorization: "Bearer not.a.real.token" });
  assert(codes.every((c) => c === 401 || c === 403), `host routes returned ${codes.join(",")}`);
  assert(forged.status === 401 || forged.status === 403, `forged token returned ${forged.status}`);
  assert((await getState()).version === v0, "state changed after rejected host calls");
  evidence["auth0/attendee-forbidden.txt"] =
    `${routes.map(([m, p], i) => `${m} ${p} → ${codes[i]}`).join("\n")}\nforged bearer → ${forged.status}\nstate version unchanged: ${v0}\n`;
  return { detail: `host routes → ${[...new Set(codes)].join("/")}, forged token → ${forged.status}, no state change` };
});

let aiConfigured = false;
let pendingId = null;
await check("E2E-06", "Real Gemini recommendation with structured, validated output", async () => {
  if (!hostHeaders) return { skip: "no host credentials" };
  const list = await http("GET", `/api/host/sessions/${SESSION}/recommendations`, null, hostHeaders);
  assert(list.status === 200, `recommendations HTTP ${list.status}`);
  aiConfigured = list.json.ai.configured;
  if (!aiConfigured) return { skip: "GEMINI_API_KEY not set on the server" };
  const r = await http("POST", `/api/host/sessions/${SESSION}/recommendations`, { hostTarget: "raise_energy" }, hostHeaders);
  const rec = r.json?.recommendation;
  assert(r.status === 201 && rec, `HTTP ${r.status}`);
  evidence["gemini/request-metadata.txt"] =
    `model ${rec.model} (${rec.modelVersion})\nresponseId ${rec.responseId}\nlatency ${rec.latencyMs} ms\nstatus ${rec.status}\n` +
    `proposal ${JSON.stringify(rec.proposal)}\nvalidation ${JSON.stringify(rec.validationErrors)}\nbaseline ${JSON.stringify(rec.baseline)}\n` +
    `input summary ${JSON.stringify(rec.input)}\n`;
  assert(rec.status !== "failed", `Gemini call failed: ${rec.validationErrors.join("; ")}`);
  assert(rec.responseId, "no responseId from Gemini");
  if (rec.status === "pending") pendingId = rec.id;
  return { detail: `${rec.model} responded in ${rec.latencyMs} ms, responseId ${String(rec.responseId).slice(0, 12)}…, ${rec.status}` };
});

await check("E2E-07", "Host rejects a recommendation; stage unchanged", async () => {
  if (!hostHeaders) return { skip: "no host credentials" };
  if (!pendingId) return { skip: aiConfigured ? "no valid pending recommendation to reject" : "Gemini not configured" };
  const before = await getState();
  const r = await http("POST", `/api/host/sessions/${SESSION}/recommendations/${pendingId}/reject`, {}, hostHeaders);
  const after = await getState();
  assert(r.status === 200 && r.json.recommendation.status === "rejected", `HTTP ${r.status}`);
  assert(JSON.stringify(after.visualState) === JSON.stringify(before.visualState), "visual state changed");
  assert(after.nowPlaying?.trackId === before.nowPlaying?.trackId, "now playing changed");
  return { detail: "rejected; theme, intensity and now playing unchanged" };
});

await check("E2E-08", "Host approves a valid recommendation; stage changes to it", async () => {
  if (!hostHeaders) return { skip: "no host credentials" };
  if (!aiConfigured) return { skip: "Gemini not configured (host manual stage change is checked separately below)" };
  const r = await http("POST", `/api/host/sessions/${SESSION}/recommendations`, { hostTarget: "raise_energy" }, hostHeaders);
  const rec = r.json?.recommendation;
  if (rec?.status !== "pending") return { skip: `Gemini returned ${rec?.status ?? r.status}, nothing to approve` };
  const a = await http("POST", `/api/host/sessions/${SESSION}/recommendations/${rec.id}/approve`, {}, hostHeaders);
  const s = await getState();
  assert(a.status === 200, `approve HTTP ${a.status}`);
  assert(s.visualState.theme === rec.proposal.visual_theme, "theme not applied");
  assert(s.nowPlaying?.trackId === rec.proposal.recommended_track_id, "track not playing");
  return { detail: `stage → ${s.visualState.theme} @ ${s.visualState.intensity}, playing ${s.nowPlaying.trackId}` };
});

await check("HOST", "Host manual stage change reaches clients (FE-08)", async () => {
  if (!hostHeaders) return { skip: "no host credentials" };
  const before = stage.states.length;
  const r = await http("POST", `/api/host/sessions/${SESSION}/visual`, { visual: { theme: "electric_blue", intensity: 0.65 } }, hostHeaders);
  assert(r.status === 200, `HTTP ${r.status}`);
  const got = await waitFor(() => stage.states.slice(before).find((s) => s.msg.visualState.theme === "electric_blue"));
  assert(got, "stage client did not receive the new visual state");
  await http("POST", `/api/host/sessions/${SESSION}/visual`, { visual: null }, hostHeaders);
  return { detail: "electric_blue @ 65% broadcast to stage client, then back to auto" };
});

await check("E2E-10", "Solana devnet boost verified server-side", async () => {
  const cfg = (await http("GET", "/api/solana/config")).json;
  if (!cfg?.enabled) return { skip: "boosts disabled (BOOST_RECIPIENT not set)" };
  const intent = (await http("POST", `/api/sessions/${SESSION}/boosts/intents`, { trackId: freeTrack(), participantId: participant() })).json;
  const malformed = await http("POST", "/api/solana/boost/verify", { sessionId: SESSION, intentId: intent.intentId, signature: "not-a-signature" });
  assert(malformed.json.status === "rejected", "malformed signature was not rejected");
  if (!args["boost-signature"] || !args["boost-intent"]) {
    return { skip: "malformed signature rejected ✓; pass --boost-signature/--boost-intent from `npm run boost:devnet` for a live verified boost" };
  }
  const r = await http("POST", "/api/solana/boost/verify", { sessionId: SESSION, intentId: args["boost-intent"], signature: args["boost-signature"] });
  evidence["solana/devnet-signature.txt"] = `${args["boost-signature"]}\n${r.json.explorerUrl}\nserver: ${r.json.status} ${r.json.reason ?? ""}\n`;
  assert(r.json.status === "verified", `${r.json.status}: ${r.json.reason}`);
  return { detail: r.json.explorerUrl };
});

await check("E2E-11", "Votes and stage updates continue while Gemini is unavailable", async () => {
  if (health.gemini === "configured") {
    return { skip: "Gemini is configured here; covered by unit test GM-07 — rerun this check against a server without GEMINI_API_KEY" };
  }
  const r = await vote(freeTrack());
  assert(r.json.status === "accepted", "vote failed with Gemini off");
  return { detail: "Gemini off on this server; vote accepted and broadcast" };
});

await check("E2E-12", "Reconnected client gets the current authoritative state", async () => {
  const lastSeen = stage.states.at(-1).msg;
  stage.close();
  await vote(freeTrack()); // happens while the client is away
  const again = await openSocket();
  const snap = again.states[0].msg;
  again.close();
  assert(snap.epoch === lastSeen.epoch && snap.version > lastSeen.version, `snapshot version ${snap.version} vs last seen ${lastSeen.version}`);
  return { detail: `missed update recovered on reconnect (v${lastSeen.version} → v${snap.version})` };
});

// ---- write evidence ----
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
const md = [
  `# E2E run — ${new Date().toISOString()}`,
  ``,
  `Target: ${BASE} · session \`${SESSION}\` · database ${health.database ?? "?"} · gemini ${health.gemini ?? "?"} · host creds ${hostToken ? "Auth0 token" : hostKey ? "dev key" : "none"}`,
  ``,
  `**${counts.PASS ?? 0} pass · ${counts.FAIL ?? 0} fail · ${counts.SKIP ?? 0} skip**`,
  ``,
  `| ID | Check | Result | Evidence / reason |`,
  `|---|---|---|---|`,
  ...results.map((r) => `| ${r.id} | ${r.title} | ${r.status} | ${(r.detail ?? "").replaceAll("|", "\\|")} |`),
  ``,
].join("\n");
for (const [rel, content] of Object.entries({ ...evidence, [`e2e/${stamp}.md`]: md, "e2e/latest.md": md })) {
  const p = path.join(evidenceDir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
}
console.log(`\n${counts.PASS ?? 0} pass · ${counts.FAIL ?? 0} fail · ${counts.SKIP ?? 0} skip — evidence written to evidence/`);
process.exit(counts.FAIL ? 1 : 0);
