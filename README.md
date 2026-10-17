# CrowdPulse

Live crowd energy for the stage — SwampHacks build following the CrowdPulse playbook.

**Stage 00–01 status:** attendee join/vote UI with hype taps, shared stage visualizer with QR join, host controls (theme/intensity override, play next), and a validated WebSocket event → `session.state` loop with tests.

## Quick start

```bash
npm install
npm run dev        # server + web together (or dev:server / dev:web separately)
npm test           # server + web tests
```

- App: http://localhost:5173  
- API / WS: http://localhost:8787  
- Demo session: `demo`

### Demo paths

| Role | URL |
|------|-----|
| Attendee | http://localhost:5173/join/demo |
| Stage (projector) | http://localhost:5173/stage/demo |
| Host | http://localhost:5173/host/demo (dev host key: `local-dev-host-key`) |

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

## Architecture (current)

```
apps/web      React + Vite (join / stage / host)
apps/server  Express + WebSocket (authoritative session state)
packages/shared  Event contract + demo catalog
```

All client events (`vote.submit`, `session.join`, `tap.batch`) go through one strict schema check (unknown fields rejected, UUID `eventId`, anonymous `participantId`) whether they arrive over WebSocket or HTTP. The server deduplicates by `eventId`, allows one vote per participant per track, rate-limits per participant and IP, only serves known sessions, and broadcasts `session.state` (with `epoch`/`version` so clients ignore stale snapshots). Clients keep unacknowledged events in an outbox and resend them on reconnect; dedupe makes that safe.

Host routes (`POST /api/host/sessions/:id/visual`, `/advance`) require an `x-host-key` header until Auth0 replaces it (Doc 06). The stage freezes and dims when disconnected rather than animating stale data. Gemini, Auth0, Solana, TigerData, and Vultr come in later playbook stages — voting still works without them.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Server + frontend |
| `npm test` | Server (supertest) + web (vitest/jsdom) tests |
| `npm run dev:web` | Frontend only |
| `npm run dev:server` | Realtime API only |
| `npm run build` | Typecheck / build workspaces |
