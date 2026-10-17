// Doc 09 test matrix generator. Runs every suite, maps results to the playbook test IDs
// (FE/BE/TD/GM/SOL/AU/VU/E2E), and writes docs/09_TEST_MATRIX.md.
// A test is only marked PASS if an automated test tagged with its ID actually ran and passed —
// never from code review. Everything else is SKIPPED (with reason) or MANUAL (with steps).
//
// Usage: node scripts/test-matrix.mjs [--skip-browser]

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skipBrowser = process.argv.includes("--skip-browser");
const tmp = mkdtempSync(path.join(tmpdir(), "crowdpulse-matrix-"));

// ---------------- Catalog (Docs 01–08) ----------------
// P0 = core flow or trust/security boundary (must pass before judging)
// P1 = resilience/quality (must pass if the feature is in the demo)
// P2 = stretch/optimization
const AREAS = {
  FE: { doc: "01 Attendee Frontend & Stage", owner: "Frontend" },
  BE: { doc: "02 Backend & Realtime Pipeline", owner: "Backend" },
  TD: { doc: "03 TigerData Analytics", owner: "Data/analytics" },
  GM: { doc: "04 Gemini AI DJ", owner: "AI/analytics" },
  SOL: { doc: "05 Solana Devnet", owner: "Blockchain/backend" },
  AU: { doc: "06 Auth0 Security", owner: "Security/backend" },
  VU: { doc: "07 Vultr Deployment", owner: "Infrastructure" },
  E2E: { doc: "08 Integration & Judge Demo", owner: "Whole team" },
};

const C = (id, p, title, manual, extra = {}) => ({ id, p, title, manual, ...extra });
const CATALOG = [
  C("FE-01", "P0", "QR / short URL opens the right session", "Scan the stage QR with a real phone on the deployed URL; the join screen shows the session name.", { scope: "Automated in a mobile-emulated browser; still scan a real QR on the deployed URL." }),
  C("FE-02", "P0", "Vote gives pending → accepted feedback; queue updates", "Tap Vote on a phone; the button goes Sending… → Voted ✓ and the queue moves."),
  C("FE-03", "P0", "Second browser sees the vote without refresh", "Open /stage on a second device and vote from a phone."),
  C("FE-04", "P1", "Disconnect/reconnect shows status, no duplicate votes", "Toggle Wi-Fi on a phone mid-vote; the badge shows Reconnecting, then Live, with one vote counted."),
  C("FE-05", "P0", "Unknown track ID rejected by the server", "From DevTools, POST a vote with trackId \"nope\"; expect 400 and no queue change."),
  C("FE-06", "P1", "Host page usable by keyboard", "Tab through /host/demo; every control can be focused and activated.", { scope: "Unit-tested for the vote button; tab through the whole host page by hand." }),
  C("FE-07", "P1", "Mobile and projector layouts legible", "Check a phone (390 px) and a 1920×1080 projector; nothing clipped. Screenshots are in evidence/frontend/."),
  C("FE-08", "P0", "Validated visual state changes the stage", "Apply a theme on /host; the projector changes theme and intensity."),
  C("BE-01", "P0", "Vote missing sessionId → 400, not persisted", "curl a vote without sessionId; expect 400."),
  C("BE-02", "P0", "Unknown track rejected; queue unchanged", "Same as FE-05."),
  C("BE-03", "P0", "Same eventId twice counts once", "Resend an identical vote body; the second response is \"duplicate\"."),
  C("BE-04", "P1", "Burst from one client → 429; service stays up", "Send 40 taps quickly from one participant; expect 429s and /api/health still ok."),
  C("BE-05", "P0", "Two clients receive the same authoritative state", "Two browsers on /stage; vote; both update identically."),
  C("BE-06", "P0", "Gemini disabled → votes still work", "Remove GEMINI_API_KEY and restart; voting and the stage still work, and the AI card says unavailable."),
  C("BE-07", "P1", "Database outage → clear error, no false \"saved\"", "Point DATABASE_URL at a bad host in staging; votes are rejected with a retry message, not counted."),
  C("BE-08", "P1", "One eventId traceable through logs", "Vote once; grep the server logs for its eventId (validation → persist → broadcast)."),
  C("TD-01", "P0", "Backend insert visible via SQL", "Run 'Latest events' from apps/server/sql/demo-queries.sql after a vote.", { needs: "DATABASE_URL" }),
  C("TD-02", "P0", "Row has correct timestamp, session, type, eventId", "Inspect the inserted row in the SQL editor.", { needs: "DATABASE_URL" }),
  C("TD-03", "P0", "Duplicate event key ignored", "Retry an event; only one row exists for its event_id.", { needs: "DATABASE_URL" }),
  C("TD-04", "P1", "Continuous aggregate matches known events", "Insert known events and refresh; crowd_metrics_5s counts match.", { needs: "DATABASE_URL" }),
  C("TD-05", "P1", "Dashboard freshness advances", "Watch Live analytics while voting; the latest event time and aggregate lag update."),
  C("TD-06", "P0", "Session isolation in metrics", "Query two sessions; their counts don't mix.", { needs: "DATABASE_URL" }),
  C("TD-07", "P1", "DB blocked → honest failure", "Block the DB in staging; the dashboard shows an error and votes aren't claimed as saved."),
  C("TD-08", "P2", "Controlled burst: insert rate and query latency recorded", "The integration test logs the insert rate; copy it into evidence/tigerdata/.", { needs: "DATABASE_URL" }),
  C("GM-01", "P0", "Real Gemini call logged with response ID", "Host → Get recommendation on the deployed app; the card shows the model, response ID and latency.", { needs: "GEMINI_API_KEY" }),
  C("GM-02", "P1", "Input summary changes with crowd context", "Change moods or votes and ask again; compare the 'what was sent' panels."),
  C("GM-03", "P0", "Malformed AI output rejected, no stage change", "Covered by validator tests."),
  C("GM-04", "P0", "Unknown track from AI rejected", "Covered by validator tests."),
  C("GM-05", "P0", "Intensity outside 0–1 rejected (documented policy)", "Covered by validator tests."),
  C("GM-06", "P0", "Prompt injection in track data can't escalate", "Covered by tests that use an injected catalog."),
  C("GM-07", "P0", "Timeout / bad key → voting works, AI shows unavailable", "Set a bad key; voting continues and the card shows the error."),
  C("GM-08", "P0", "Host reject leaves stage unchanged, decision recorded", "Reject a recommendation; the stage is unchanged and an ai_decision row exists."),
  C("GM-09", "P1", "Latency: median and p95 over real calls", "npm run eval --workspace=@crowdpulse/server -- 4 (24 calls), then attach evidence/gemini/evaluation-summary.txt.", { needs: "GEMINI_API_KEY" }),
  C("SOL-01", "P1", "Real devnet tx verified; explorer resolves", "npm run boost:devnet --workspace=@crowdpulse/server -- <funded-keypair.json>.", { needs: "BOOST_RECIPIENT + a funded devnet wallet", note: "P0 if Solana is in the demo" }),
  C("SOL-02", "P1", "Unconfirmed → pending, no boost", "Covered by tests."),
  C("SOL-03", "P1", "Wrong cluster / not on devnet → rejected", "Covered by tests (fake RPC and genesis check)."),
  C("SOL-04", "P1", "Wrong destination, amount or memo → rejected", "Covered by tests; real devnet transactions were also checked to be rejected."),
  C("SOL-05", "P1", "Replay of a signature → no second boost", "Covered by tests; the devnet-boost script also attempts a replay."),
  C("SOL-06", "P1", "Fake / malformed signature → rejected", "Covered by tests."),
  C("SOL-07", "P1", "RPC timeout → pending/unknown, never success", "Covered by tests."),
  C("SOL-08", "P0", "Everything works without a wallet", "Vote on a phone with no wallet installed."),
  C("SOL-09", "P1", "Verified boost shows in queue with effect", "After SOL-01, the ⚡ count appears in the stage queue."),
  C("AU-01", "P0", "Host signs in; dashboard shows authenticated state", "Sign in on /host/demo with an account that has the Host role.", { needs: "Auth0 tenant (AUTH0_DOMAIN/AUDIENCE/CLIENT_ID)" }),
  C("AU-02", "P0", "No token → 401, no side effect", "curl a host endpoint with no Authorization header."),
  C("AU-03", "P0", "Attendee identity → 403, stage unchanged", "Sign in as a user without the Host role and call a host endpoint."),
  C("AU-04", "P0", "Valid host action succeeds, audit logged", "Approve a recommendation as the host."),
  C("AU-05", "P0", "Expired / malformed token rejected", "Covered by tests (expired, forged, wrong issuer/audience, alg:none)."),
  C("AU-06", "P1", "Host of session A can't control session B", "Covered by tests (host:other → 403 on demo)."),
  C("AU-07", "P0", "No secrets in the built frontend", "npm run build && npm run scan:secrets"),
  C("AU-08", "P0", "Hidden UI bypass: API still rejects", "Call host APIs directly without credentials."),
  C("VU-01", "P0", "Public URL loads on cellular data", "Open the deployed URL on a phone with Wi-Fi off; screenshot it into evidence/vultr/.", { needs: "Vultr deployment (Doc 07)" }),
  C("VU-02", "P0", "/api/health healthy, no config leaked", "curl https://<domain>/api/health", { autoBy: "npm run e2e:check -- --url https://<domain>", needs: "Vultr deployment (Doc 07)" }),
  C("VU-03", "P0", "WebSocket upgrade works through the proxy", "Two devices on the deployed URL receive the same event.", { needs: "Vultr deployment (Doc 07)" }),
  C("VU-04", "P1", "Backend restart → clients reconnect and reload state", "Restart the service; clients show Reconnecting → Live with the same state.", { needs: "Vultr deployment (Doc 07)" }),
  C("VU-05", "P0", "No secrets in the repo or bundle", "npm run build && npm run scan:secrets"),
  C("VU-06", "P1", "Load test 25–50 clients recorded", "npm run load-test against the deployed URL; save the summary to evidence/vultr/.", { needs: "Vultr deployment (Doc 07)" }),
  C("VU-07", "P1", "Gemini key removed → vote loop still works", "Unset GEMINI_API_KEY in staging and restart.", { needs: "Vultr deployment (Doc 07)" }),
  C("VU-08", "P1", "TLS + CORS: allowed origin works, others rejected", "Set CORS_ORIGINS; a fetch from another origin is blocked.", { needs: "Vultr deployment (Doc 07)" }),
  C("E2E-01", "P0", "Phone joins via QR/short URL", "Part of the 3-minute rehearsal."),
  C("E2E-02", "P0", "Phone submits valid vote", "Part of the rehearsal."),
  C("E2E-03", "P0", "Second browser updates without refresh", "Part of the rehearsal."),
  C("E2E-04", "P0", "Event persists in TigerData", "npm run e2e:check against a server with DATABASE_URL.", { autoBy: "npm run e2e:check", needs: "DATABASE_URL" }),
  C("E2E-05", "P0", "Metrics/freshness advance", "npm run e2e:check against a server with DATABASE_URL.", { autoBy: "npm run e2e:check", needs: "DATABASE_URL" }),
  C("E2E-06", "P0", "Real Gemini recommendation + card", "npm run e2e:check with host credentials and Gemini configured.", { autoBy: "npm run e2e:check", needs: "GEMINI_API_KEY + host credentials" }),
  C("E2E-07", "P0", "Host rejects; stage unchanged", "npm run e2e:check with Gemini configured.", { autoBy: "npm run e2e:check", needs: "GEMINI_API_KEY + host credentials" }),
  C("E2E-08", "P0", "Host approves; stage changes to proposal", "npm run e2e:check with Gemini configured.", { autoBy: "npm run e2e:check", needs: "GEMINI_API_KEY + host credentials" }),
  C("E2E-09", "P0", "Attendee host action → 401/403", "Part of the rehearsal (security beat)."),
  C("E2E-10", "P1", "Solana tx verified end to end", "npm run e2e:check -- --boost-signature … --boost-intent … after npm run boost:devnet.", { autoBy: "npm run e2e:check", needs: "BOOST_RECIPIENT + funded devnet wallet", note: "P0 if Solana is in the demo" }),
  C("E2E-11", "P0", "Gemini unavailable → votes continue", "npm run e2e:check against a server without GEMINI_API_KEY.", { autoBy: "npm run e2e:check" }),
  C("E2E-12", "P0", "Reconnect restores authoritative state", "Toggle network on a phone during the rehearsal."),
];

// ---------------- Run suites ----------------
const sources = []; // { source, title, status, ids }
const ID_RE = /\b(FE|BE|TD|GM|SOL|AU|VU|E2E)-(\d{2})((?:\/\d{2})*)/g;
function idsIn(title) {
  const ids = new Set();
  for (const m of title.matchAll(ID_RE)) {
    ids.add(`${m[1]}-${m[2]}`);
    for (const n of (m[3] ?? "").split("/").filter(Boolean)) ids.add(`${m[1]}-${n}`);
  }
  return [...ids];
}
const add = (source, title, status) => sources.push({ source, title, status, ids: idsIn(title) });
const run = (label, cmd, cwd, env = {}) => {
  process.stdout.write(`Running ${label}… `);
  const r = spawnSync(cmd, { cwd, shell: true, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  console.log(r.status === 0 ? "done" : `exit ${r.status}`);
  return r;
};

function readVitest(file, source) {
  if (!existsSync(file)) return console.warn(`  (no results from ${source})`);
  const json = JSON.parse(readFileSync(file, "utf8"));
  for (const suite of json.testResults ?? []) {
    for (const t of suite.assertionResults ?? []) {
      const status = t.status === "passed" ? "passed" : t.status === "failed" ? "failed" : "skipped";
      add(source, [...(t.ancestorTitles ?? []), t.title].join(" › "), status);
    }
  }
}
run("server tests", `npx vitest run --reporter=json --outputFile=${tmp}/server.json`, path.join(root, "apps/server"));
readVitest(`${tmp}/server.json`, "server unit/integration (vitest)");
run("web tests", `npx vitest run --reporter=json --outputFile=${tmp}/web.json`, path.join(root, "apps/web"));
readVitest(`${tmp}/web.json`, "web components (vitest)");

if (!skipBrowser) {
  run("browser tests", "npx playwright test --reporter=json", path.join(root, "apps/web"), {
    PLAYWRIGHT_JSON_OUTPUT_NAME: `${tmp}/browser.json`,
  });
  if (existsSync(`${tmp}/browser.json`)) {
    const walk = (suite) => {
      for (const spec of suite.specs ?? []) {
        const last = spec.tests?.[0]?.results?.at(-1)?.status ?? "skipped";
        add("browser E2E (Playwright, local stack)", spec.title, last === "passed" ? "passed" : last === "skipped" ? "skipped" : "failed");
      }
      for (const s of suite.suites ?? []) walk(s);
    };
    for (const s of JSON.parse(readFileSync(`${tmp}/browser.json`, "utf8")).suites ?? []) walk(s);
  }
}

run("web build", "npm run -s build", root);
const scan = run("secret scan", "node scripts/scan-secrets.mjs", root);
const scanLine = (scan.stdout ?? "").trim().split("\n").at(-1) ?? "";
for (const id of ["AU-07", "VU-05"]) add("secret scan (scan:secrets)", `${id}: ${scanLine}`, scan.status === 0 ? "passed" : "failed");

// API-level E2E results from the last `npm run e2e:check` (target recorded in the file).
let e2eTarget = null;
const e2eFile = path.join(root, "evidence/e2e/latest.md");
if (existsSync(e2eFile)) {
  const md = readFileSync(e2eFile, "utf8");
  e2eTarget = md.match(/^Target: (\S+)/m)?.[1] ?? "unknown";
  const when = md.match(/^# E2E run — (\S+)/m)?.[1] ?? "";
  const local = /localhost|127\.0\.0\.1/.test(e2eTarget);
  for (const row of md.matchAll(/^\| (\S+) \| (.+?) \| (PASS|FAIL|SKIP) \| (.*) \|$/gm)) {
    const [, id, title, result] = row;
    const ids = idsIn(id);
    if (row[1] === "HEALTH" && !local) ids.push("VU-02");
    sources.push({
      source: `e2e:check vs ${e2eTarget}${when ? ` (${when.slice(0, 16)})` : ""}`,
      title: `${id} ${title}`,
      status: result === "PASS" ? "passed" : result === "FAIL" ? "failed" : "skipped",
      ids,
    });
  }
}

// ---------------- Aggregate ----------------
const envHas = (k) => {
  if (process.env[k]) return true;
  try {
    return new RegExp(`^${k}=.+`, "m").test(readFileSync(path.join(root, ".env"), "utf8"));
  } catch {
    return false;
  }
};
const env = Object.fromEntries(
  ["DATABASE_URL", "GEMINI_API_KEY", "AUTH0_DOMAIN", "BOOST_RECIPIENT"].map((k) => [k, envHas(k)]),
);

const rows = CATALOG.map((c) => {
  const hits = sources.filter((s) => s.ids.includes(c.id));
  const passed = hits.filter((h) => h.status === "passed");
  const failed = hits.filter((h) => h.status === "failed");
  const status = failed.length ? "FAIL" : passed.length ? "PASS" : hits.length ? "SKIPPED" : c.autoBy ? "NOT RUN" : "MANUAL";
  const via = [...new Set((failed.length ? failed : passed.length ? passed : hits).map((h) => h.source))];
  return { ...c, status, hits, via };
});

const count = (list, s) => list.filter((r) => r.status === s).length;
const icon = { PASS: "✅ PASS", FAIL: "❌ FAIL", SKIPPED: "⏭ SKIPPED", "NOT RUN": "⏳ NOT RUN", MANUAL: "📝 MANUAL" };
const esc = (s) => String(s).replaceAll("|", "\\|");
const now = new Date().toISOString();

let commit = "";
try {
  commit = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim();
  if (execSync("git status --porcelain", { cwd: root }).toString().trim()) commit += " + uncommitted changes";
} catch {
  /* not a repo */
}

const lines = [];
lines.push(
  `# CrowdPulse — Test matrix (Doc 09)`,
  ``,
  `Generated by \`npm run test:matrix\` on ${now} at \`${commit}\`. **Statuses come only from tests that actually ran in this generation** (or from the last \`e2e:check\` run, which is labelled with its target). Nothing is marked PASS from code review.`,
  ``,
  `Integrations configured for this run: ${Object.entries(env).map(([k, v]) => `\`${k}\` ${v ? "✓" : "✗"}`).join(" · ")}${e2eTarget ? ` · last e2e:check target \`${e2eTarget}\`` : " · no e2e:check run found"}`,
  ``,
  `**Legend:** ✅ PASS = automated test(s) ran and passed · ❌ FAIL = an automated test failed · ⏭ SKIPPED = automated test exists but didn't run (missing key/service) · ⏳ NOT RUN = automated by \`e2e:check\`, which hasn't been run against a suitable server · 📝 MANUAL = verify by hand (steps given) and record evidence in [evidence/README.md](../evidence/README.md).`,
  ``,
  `## 1. Guide index`,
  ``,
  `| PDF | Focus | Suggested owner | Repo doc |`,
  `|---|---|---|---|`,
  `| 00 Master Roadmap & Acceptance | Scope, sequencing, definition of done | Whole team / lead | [00_ACCEPTANCE.md](00_ACCEPTANCE.md) |`,
  `| 01 Attendee Frontend & Stage | QR, voting, stage visualizer, UX tests | Frontend | README § Doc 01 |`,
  `| 02 Backend & Realtime Pipeline | Validation, WebSockets, persistence boundaries | Backend | [02_BACKEND_ACCEPTANCE.md](02_BACKEND_ACCEPTANCE.md) |`,
  `| 03 TigerData Analytics | Schema, SQL, aggregates, freshness | Data/analytics | README § TigerData · [demo-queries.sql](../apps/server/sql/demo-queries.sql) |`,
  `| 04 Gemini AI DJ | Context, structured output, safety, baseline | AI/analytics | README § Gemini |`,
  `| 05 Solana Devnet | Boost flow, verification, replay protection | Blockchain/backend | README § Solana |`,
  `| 06 Auth0 Security | Login, roles, protected endpoints | Security/backend | README § Auth0 |`,
  `| 07 Vultr Deployment | Public deployment, resilience, load tests | Infrastructure | *not started* |`,
  `| 08 Integration & Judge Demo | End-to-end tests, evidence, rehearsal | Whole team | [08_JUDGE_DEMO.md](08_JUDGE_DEMO.md) |`,
  ``,
  `## 2. Summary`,
  ``,
  `| Area | P0 pass | P1 pass | P2 pass | Fail | Skipped | Not run | Manual |`,
  `|---|---|---|---|---|---|---|---|`,
);
for (const prefix of Object.keys(AREAS)) {
  const a = rows.filter((r) => r.id.startsWith(`${prefix}-`));
  const pp = (p) => {
    const inP = a.filter((r) => r.p === p);
    return inP.length ? `${count(inP, "PASS")}/${inP.length}` : "—";
  };
  lines.push(`| ${prefix} · ${AREAS[prefix].doc} | ${pp("P0")} | ${pp("P1")} | ${pp("P2")} | ${count(a, "FAIL")} | ${count(a, "SKIPPED")} | ${count(a, "NOT RUN")} | ${count(a, "MANUAL")} |`);
}
const p0 = rows.filter((r) => r.p === "P0");
lines.push(
  `| **All** | **${count(p0, "PASS")}/${p0.length}** | **${count(rows.filter((r) => r.p === "P1"), "PASS")}/${rows.filter((r) => r.p === "P1").length}** | **${count(rows.filter((r) => r.p === "P2"), "PASS")}/${rows.filter((r) => r.p === "P2").length}** | **${count(rows, "FAIL")}** | **${count(rows, "SKIPPED")}** | **${count(rows, "NOT RUN")}** | **${count(rows, "MANUAL")}** |`,
  ``,
);

const blockers = p0.filter((r) => r.status !== "PASS");
lines.push(`## 3. P0 not yet passing (go/no-go blockers)`, ``);
if (!blockers.length) lines.push(`None — every P0 has a passing automated test. Still do the manual rehearsal in [08_JUDGE_DEMO.md](08_JUDGE_DEMO.md).`, ``);
else {
  lines.push(`Every P0 must pass before judging (Doc 09 §2). These still need work, a key, or a manual check:`, ``, `| ID | Test | Status | What's needed |`, `|---|---|---|---|`);
  for (const r of blockers) lines.push(`| ${r.id} | ${esc(r.title)} | ${icon[r.status]} | ${esc(r.needs ? `Needs ${r.needs}. ` : "")}${esc(r.manual)} |`);
  lines.push(``);
}

lines.push(`## 4. Full matrix`, ``);
for (const [prefix, area] of Object.entries(AREAS)) {
  lines.push(`### ${prefix} — Doc ${area.doc} (owner: ${area.owner})`, ``, `| ID | Pri | Test | Status | Automated by / evidence | Manual check |`, `|---|---|---|---|---|---|`);
  for (const r of rows.filter((x) => x.id.startsWith(`${prefix}-`))) {
    const auto = r.hits.length
      ? `${r.hits.length} test(s) via ${r.via.join("; ")}${r.scope ? `. *Scope: ${r.scope}*` : ""}`
      : r.autoBy
        ? `Automated by \`${r.autoBy}\` — not run yet${r.needs ? ` (needs ${r.needs})` : ""}`
        : r.needs
          ? `Needs ${r.needs}`
          : "—";
    lines.push(`| ${r.id} | ${r.p}${r.note ? `*` : ""} | ${esc(r.title)} | ${icon[r.status]} | ${esc(auto)} | ${esc(r.manual)} |`);
  }
  if (rows.some((x) => x.id.startsWith(`${prefix}-`) && x.note)) lines.push(``, `\\* ${rows.find((x) => x.id.startsWith(`${prefix}-`) && x.note).note}.`);
  lines.push(``);
}

const evidenceFiles = [
  ["Attendee vote + stage update (image)", ["evidence/frontend/join-and-vote.png", "evidence/frontend/stage-updated.png"]],
  ["SQL result matching a UI event", ["evidence/tigerdata/metrics-after-vote.json"]],
  ["Real Gemini request + validated response", ["evidence/gemini/request-metadata.txt"]],
  ["Attendee access-control failure", ["evidence/auth0/attendee-forbidden.txt"]],
  ["Public health check + load-test summary", ["evidence/vultr/load-test-summary.txt"]],
  ["Verified Solana devnet signature (if in demo)", ["evidence/solana/devnet-signature.txt"]],
  ["Baseline-vs-Gemini results with scenario count", ["evidence/gemini/baseline-results.csv"]],
];
lines.push(`## 5. Minimum evidence package (Doc 09 §4)`, ``, `| Item | File(s) | Present |`, `|---|---|---|`);
for (const [item, files] of evidenceFiles) {
  const ok = files.every((f) => existsSync(path.join(root, f)));
  lines.push(`| ${item} | ${files.map((f) => `\`${f}\``).join(", ")} | ${ok ? "✓" : "—"} |`);
}
lines.push(
  ``,
  `Files from a local run (e.g. Playwright screenshots) prove the code works, not the deployment. Regenerate evidence against the deployed URL before judging.`,
  ``,
  `## 6. Every automated test that ran`,
  ``,
  `<details><summary>${sources.length} results (click to expand)</summary>`,
  ``,
  `| Source | Test | Result | IDs |`,
  `|---|---|---|---|`,
  ...sources.map((s) => `| ${esc(s.source)} | ${esc(s.title)} | ${s.status} | ${s.ids.join(", ") || "—"} |`),
  ``,
  `</details>`,
  ``,
);

writeFileSync(path.join(root, "docs/09_TEST_MATRIX.md"), lines.join("\n"));
console.log(
  `\nP0 ${count(p0, "PASS")}/${p0.length} passing · ${count(rows, "FAIL")} fail · ${count(rows, "SKIPPED")} skipped · ${count(rows, "NOT RUN")} not run · ${count(rows, "MANUAL")} manual — wrote docs/09_TEST_MATRIX.md`,
);
process.exit(count(rows, "FAIL") ? 1 : 0);
