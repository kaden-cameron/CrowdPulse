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
