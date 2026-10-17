# CrowdPulse

Live crowd energy for the stage — SwampHacks build following the CrowdPulse playbook.

**Stage 00–01 status:** attendee join/vote UI, shared stage visualizer, host scaffolding, and a validated WebSocket vote → `session.state` loop.

## Quick start

```bash
npm install
npm run dev:server
# in another terminal
npm run dev:web
```

- App: http://localhost:5173  
- API / WS: http://localhost:8787  
- Demo session: `demo`

### Demo paths

| Role | URL |
|------|-----|
| Attendee | http://localhost:5173/join/demo |
| Stage (projector) | http://localhost:5173/stage/demo |
| Host | http://localhost:5173/host/demo |

QR/onboarding: print or display a QR that opens `/join/demo` (or your LAN IP for phones).

## Acceptance checks (FE-01 … FE-08)

1. Open `/join/demo` on a phone — join screen shows **SwampHacks Main Stage**.
2. Pick a mood, vote a track — button shows pending → accepted; vote count rises.
3. Open `/stage/demo` in a second browser — queue/energy update without refresh.
4. Toggle airplane mode briefly — badge shows disconnected/reconnecting, then recovers.
5. From DevTools, submit `vote.submit` with `trackId: "nope"` — rejected; queue unchanged.
6. On `/host/demo`, Tab through Approve/Reject and links.
7. Resize to phone and wide projector — controls and stage stay usable.
8. Keep voting — theme/intensity on stage shifts as energy climbs (`calm_waves` → `electric_blue` → `sunset` → `neon_pulse`).

## Architecture (current)

```
apps/web      React + Vite (join / stage / host)
apps/server  Express + WebSocket (authoritative session state)
packages/shared  Event contract + demo catalog
```

Server validates track IDs, deduplicates by `eventId`, rate-limits clients, and broadcasts `session.state`. Gemini, Auth0, Solana, TigerData, and Vultr come in later playbook stages — voting still works without them.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev:web` | Frontend only |
| `npm run dev:server` | Realtime API only |
| `npm run build` | Typecheck / build workspaces |
