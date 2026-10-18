# CrowdPulse

Live crowd energy for the stage — SwampHacks build following the CrowdPulse playbook.

**Stage 00–06 status:** attendee/stage/host UI, hardened realtime loop (Docs 01–02), TigerData persistence (Doc 03), Gemini AI DJ with host-approved recommendations (Doc 04), verified Solana devnet boosts (Doc 05), and Auth0-protected host controls (Doc 06). See `docs/02_BACKEND_ACCEPTANCE.md` for the PDF 02 BE map.

## Quick start

```bash
npm install
npm run dev        # server + web together (or dev:server / dev:web separately)
npm test           # server + web tests
```

- App: http://localhost:5173  
- API / WS: http://localhost:8787 (or `PORT` from `.env`; the Vite proxy follows it)  
- Demo session: `demo`

### Demo paths

| Role | URL |
|------|-----|
| Attendee | http://localhost:5173/join/demo |
| Stage (projector) | http://localhost:5173/stage/demo |
| Host | http://localhost:5173/host/demo (dev host key: `HOST_DEV_KEY` from `.env`, or the random key printed when the server starts) |
| Player (speakers) | http://localhost:5173/player/demo |

QR/onboarding: the stage shows a QR for its own origin, so open the stage at `http://<LAN-IP>:5173/stage/demo` when phones need to scan it. Vite listens on all interfaces.

## Acceptance checks (FE-01 … FE-08)

1. Open `/join/demo` on a phone — join screen shows **SwampHacks Main Stage**.
2. Pick a mood, vote a track — button shows pending → accepted; vote count rises.
3. Open `/stage/demo` in a second browser — queue/energy update without refresh.
4. Toggle airplane mode briefly — badge shows disconnected/reconnecting, then recovers.
5. From DevTools, submit `vote.submit` with `trackId: "nope"` — rejected; queue unchanged.
6. On `/host/demo`, Tab through Approve/Reject and links.
7. Resize to phone and wide projector — controls and stage stay usable.
8. Keep voting/tapping — in **auto** mode theme/intensity follow energy (`calm_waves` → `electric_blue` → `sunset` → `neon_pulse`). On `/host/demo`, **Apply to stage** pins a theme/intensity; **Back to auto** releases it.

## TigerData persistence (Doc 03)

Put your TigerData connection string in a repo-root `.env` (see `.env.example`):

```
DATABASE_URL=postgres://tsdbadmin:…@….tsdb.cloud.timescale.com:…/tsdb?sslmode=require
```

On startup the server creates the schema if it's missing: the `crowd_events` hypertable, an `event_ids` dedup table, and the `crowd_metrics_5s` continuous aggregate (refreshed every 10s). Then it **replays the session's events**, so a restart keeps votes, moods, the queue and host settings.

- **Persist, then apply.** An event changes state and is broadcast only after TigerData confirms the write. If the write fails, the client gets a retryable rejection, the UI says so, and the same `eventId` is resent. No vote is ever reported as saved when it wasn't.
- **Dedup in the database.** `event_ids` makes a retried event a no-op, even across restarts.
- **Host dashboard** (`/host/demo` → *Live analytics*): events in the last 10s, total persisted, latest persisted event time, how far the aggregate lags behind, events per 5s (aggregate buckets are solid, buckets still computed from raw rows are hatched), the engagement trend, votes by track from SQL, and a data table.
- **Judge evidence:** `apps/server/sql/demo-queries.sql` has the latest-events, votes-by-track, aggregate and freshness queries. Run them in the TigerData SQL editor next to the dashboard.
- **Tests:** `npm test` runs the TigerData integration suite (TD-01 to 06, TD-08, restart replay) against `DATABASE_URL` using throwaway sessions. It is skipped when no database is configured.
- Without `DATABASE_URL` the server runs in memory, `/api/health` reports `"database":"off"`, and the dashboard shows **Persistence off**.

## Gemini AI DJ (Doc 04)

Add `GEMINI_API_KEY` to the repo-root `.env`. The model defaults to `gemini-3.5-flash-lite`; set `GEMINI_MODEL` to change it. The key is used only on the server.

How it works: **Gemini proposes, the server validates, the host decides.**

- On `/host/demo` → **Gemini AI DJ**, the host picks a target (raise energy, hold steady or cool down) and asks for a recommendation.
- The server sends a compact summary with no participant IDs: energy and its trend, mood counts, votes, eligible tracks with genre/BPM/energy, the current visuals, and recent recommendations.
- The request uses `generateContent` with a JSON response schema. Track IDs and themes are limited to enums.
- The server checks the response again with strict zod validation. Unknown fields are rejected. The track must be eligible right now and the theme must be allowlisted. Out-of-range numbers are **rejected, not clamped**. The reason must be plain text with no links or markup.
- **Approve** applies the theme and intensity and plays the track. **Reject** changes nothing. Both decisions are recorded.
- Every call is logged (`kind: "ai.call"`) with the model, `responseId`, `modelVersion`, latency and token counts. When TigerData is on, the input, raw response, validation result and decision are also stored as `ai_recommendation` / `ai_decision` rows.
- The card shows the majority-vote **baseline** next to Gemini's pick.
- If Gemini fails, times out or isn't configured, the card says so, and voting and the stage keep working.

**Evaluation:** `npm run eval --workspace=@crowdpulse/server -- 3` runs 6 fixed scenarios × 3 through both the baseline and Gemini. It writes `evidence/gemini/baseline-results.csv` and `evaluation-summary.txt`: preference fit (a proxy), action validity, availability, and median latency (p95 once n ≥ 20). It doesn't measure the change in engagement, which needs a live crowd.

## Solana devnet boosts (Doc 05)

Boosts are optional. To turn them on, set `BOOST_RECIPIENT` to a **devnet** address you control. It's a public address, not a secret. The server refuses to start if `SOLANA_CLUSTER` is anything other than `devnet`, and before verifying anything it checks the RPC's genesis hash is devnet's.

Flow:
1. An attendee taps ⚡ on a track. The server issues a single-use **boost intent**: recipient, amount (default 0.001 SOL) and a memo `crowdpulse:<session>:<track>:<intentId>`.
2. Their wallet (Phantom set to devnet) sends a transfer that includes that memo. Without a wallet, the panel shows the details for sending manually, plus a box to paste the signature.
3. `POST /api/solana/boost/verify` fetches the transaction from devnet. The UI shows *pending* until it's `confirmed`. It's **verified** only if:
   - it succeeded on-chain
   - it pays the recipient at least the boost amount
   - it carries this intent's exact memo
   - the signature has never been used before, in any session (`boost_signatures` table, plus a memory check)
4. Only then is the boost recorded (a `boost` event, which is replayed on restart) and broadcast.
   - Each boost counts as 2 votes in queue order, with at most 3 per track.
   - Boosts reset when the track plays and never override the host.
   - Voting stays free.
- If the RPC is down, the result is `unknown` (503) and the boost stays unverified. It is never reported as a success.
- **Send a real boost from the terminal:** fund a throwaway devnet keypair at https://faucet.solana.com, then run `npm run boost:devnet --workspace=@crowdpulse/server -- <keypair.json> track_02`. It prints the explorer link, the verification result and a replay attempt (which must be rejected).

## Auth0 host login (Doc 06)

Attendees stay anonymous. Every **host** endpoint (stage controls, play next, AI recommend/approve/reject) needs an Auth0 access token, checked on the server by Auth0's `express-oauth2-jwt-bearer`. It checks the RS256 signature against your tenant's JWKS, the issuer, the audience and the expiry. The token must also carry a permission for that session.

| Situation | Response |
|---|---|
| No token, a malformed/expired/forged token, or the wrong issuer/audience | **401** |
| Valid token, but no `host:<session>` / `host:*` permission | **403**, and nothing changes |
| Valid host token | 200, and the action is logged |

**Tenant setup** (Auth0 dashboard):
1. **APIs → Create API.** Pick an identifier such as `https://api.crowdpulse.dev` (this is `AUTH0_AUDIENCE`). Under RBAC, turn on **Enable RBAC** and **Add Permissions in the Access Token**. Add the permissions `host:demo` and `host:*`.
2. **User Management → Roles → Create role "Host"** with `host:demo`. Assign it to the host accounts only.
3. **Applications → Create Application → Single Page Application.** Copy its Client ID into `AUTH0_CLIENT_ID`. Set:
   - Allowed Callback URLs: `http://localhost:5173/auth/callback, https://<your-domain>/auth/callback`
   - Allowed Logout URLs and Allowed Web Origins: `http://localhost:5173, https://<your-domain>`
4. In `.env`, set `AUTH0_DOMAIN` (e.g. `crowdpulse.us.auth0.com`), `AUTH0_AUDIENCE` and `AUTH0_CLIENT_ID`. No client secret is needed and none should ever be added to the frontend.

The host page reads these public values from `GET /api/auth/config`. It signs in with Auth0's React SDK (tokens are kept in memory) and sends `Authorization: Bearer …`. Without Auth0 configured, local development falls back to the `x-host-key` dev key. **Production refuses to start without Auth0.**

**Security demo (AU-03):** open `/host/demo` signed in as a host. In a private window, try `curl -X POST <url>/api/host/sessions/demo/visual -H 'content-type: application/json' -d '{"visual":{"theme":"sunset","intensity":1}}'` → 401. Signed in as a user without the Host role → 403. In both cases the stage doesn't change. Then do it from the host dashboard and it works.

**Secret scan (AU-07 / VU-05):** `npm run build && npm run scan:secrets` scans the built bundle and every non-ignored repo file for API keys, database URLs with passwords, private keys, keypair arrays, JWTs and real `.env` values.

## Music playback

On the laptop plugged into the speakers, open the host page and press **Start audio on this device** in its **Now playing** window, which also shows the album cover. If the speakers are on a different laptop, use **`/player/demo`** there. It plays whatever CrowdPulse picks: the host's queue and **Skip**, an approved Gemini recommendation, or, in **Auto play**, the next song in the queue as soon as one ends. **Host picks** mode waits for the host after each song. Music plays **through Spotify** (needs `SPOTIFY_CLIENT_ID` and a Premium account on the speaker laptop). Build the song list in the host page's **Songs** window: search and **Add** / **Play now**, or import one of your Spotify playlists, then **+ Queue** or **🔀 Shuffle** into the host's queue. Gemini estimates each new song's genre, BPM and energy. A `CATALOG_FILE` of songs still works too. Setup: [docs/10_MUSIC_PLAYBACK.md](docs/10_MUSIC_PLAYBACK.md).

## Testing and judge demo (Doc 08)

The runbook is **[docs/08_JUDGE_DEMO.md](docs/08_JUDGE_DEMO.md)**: the 3-minute script, recovery steps when something breaks, and the go/no-go checklist. Evidence and the master tracker live in [evidence/](evidence/README.md).

- `npm run e2e:browser` runs Playwright against an isolated local stack. It checks that a phone can join and vote and the stage updates, that a vote made offline is sent once on reconnect, that the host's theme change reaches the stage, that an attendee gets a 401, and that simulated traffic is labeled. It saves screenshots to `evidence/frontend/`.
- `npm run e2e:check -- --url <url> [--host-token …] [--reset]` runs E2E-01 to 12 plus fault checks against any deployment. It reports PASS/FAIL/SKIP, each SKIP with a reason, and writes `evidence/e2e/latest.md`.
- `npm run demo:crowd -- --url <url> --people 20 --seconds 45` simulates attendees (IDs start with `sim_`). The stage and host page show **Demo data**.
- **Start new run ↺** on the host page (or `POST /api/host/sessions/:id/reset`) starts a fresh run. It's saved as a `session_reset` event, so restarts and dashboard counts begin from there, and earlier history stays in TigerData.

## Deployment on Vultr (Doc 07)

Step-by-step guide: **[docs/07_DEPLOYMENT.md](docs/07_DEPLOYMENT.md)**. Paste [`deploy/cloud-init.yaml`](deploy/cloud-init.yaml) into a new Ubuntu 24.04 instance. It installs Node 24 and Caddy (automatic HTTPS at `<ip>.sslip.io` or your domain), builds the app and installs a hardened systemd service. Fill in `/etc/crowdpulse/crowdpulse.env` on the server, then `systemctl start crowdpulse`. To ship updates, run `deploy/update.sh`.

In production, the server needs Auth0 and `PUBLIC_URL`. It rejects other browser origins over HTTP and WebSocket (403), takes real client IPs from Caddy, and shuts down cleanly with a "server restarting" close code so clients reconnect. `npm run load:plan -- --url https://<host>` runs the 5 → 10 → 25 → 50 attendee load plan and writes `evidence/vultr/load-test-summary.txt`.

## Test matrix (Doc 09)

`npm run test:matrix` runs every suite (server, web, browser, build plus secret scan) and writes **[docs/09_TEST_MATRIX.md](docs/09_TEST_MATRIX.md)**. It covers all 78 playbook test IDs (FE, BE, TD, GM, SOL, AU, VU, E2E) with their P0/P1/P2 priority. For each one it shows the automated tests that cover it (found by the ID in the test name) and its real status. It also lists the P0 tests that aren't passing yet (the go/no-go blockers) and checks the minimum evidence package. A test only shows as PASS if a tagged test actually ran and passed. Rerun it after adding keys or running `e2e:check` against the deployment; it picks up `evidence/e2e/latest.md`.

## Architecture (current)

```
apps/web      React + Vite (join / stage / host)
apps/server  Express + WebSocket (authoritative session state)
packages/shared  Event contract + demo catalog
```

All client events (`vote.submit`, `session.join`, `tap.batch`) go through one strict schema check (unknown fields rejected, UUID `eventId`, anonymous `participantId`) whether they arrive over WebSocket or HTTP. The server deduplicates by `eventId`, allows one vote per participant per track, rate-limits per participant and IP, only serves known sessions, and broadcasts `session.state` (with `epoch`/`version` so clients ignore stale snapshots). Clients keep unacknowledged events in an outbox and resend them on reconnect; dedupe makes that safe.

Host routes (`POST /api/host/sessions/:id/visual`, `/advance`, recommendation approve/reject) require an Auth0 access token with a `host:<session>` permission. Locally, without Auth0, they accept the `x-host-key` dev key instead. Events persist to TigerData before they're applied when `DATABASE_URL` is set. Solana boosts apply only after on-chain verification. The stage freezes and dims when disconnected. Vultr deployment is the remaining doc.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Server + frontend |
| `npm test` | Server (supertest) + web (vitest/jsdom) tests |
| `npm run load-test` | Concurrent votes → `docs/02_LOAD_TEST_RESULTS.json` |
| `npm run dev:web` | Frontend only |
| `npm run dev:server` | Realtime API only |
| `npm run build` | Typecheck / build workspaces |
