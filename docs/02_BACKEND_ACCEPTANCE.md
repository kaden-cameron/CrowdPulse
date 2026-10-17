# CrowdPulse — PDF 02 backend acceptance (mapped)

PDF 02 (validation, persistence, WS, idempotency, AI isolation, host/Solana boundaries) is implemented across the current stack:

| PDF 02 requirement | Where it lives now |
|--------------------|--------------------|
| Schema validation + rate limits | `apps/server/src/app.ts` (zod) + `session.ts` |
| Persist then apply; never claim unsaved votes | `session.ts` + TigerData `db.ts` (Doc 03) |
| Idempotent `eventId` | `event_ids` table + in-memory seen set |
| WS `session.state` + heartbeat / reconnect snapshot | `apps/server/src/index.ts` |
| Structured logs with eventId / latency | `log.ts` call sites in vote path |
| AI must not block voting | Gemini runs via `recommendation.ts` off the vote path (Doc 04) |
| Host-gated privileged actions | Auth0 JWT + `host:<session>` permission (`auth.ts`, Doc 06); `x-host-key` only when Auth0 is not configured |
| Solana verify boundary | `solana.ts`: devnet-only, confirmed tx, recipient/amount/memo, global signature replay check (Doc 05) |

## BE checklist

| ID | How to prove |
|----|----------------|
| BE-01 | POST vote without `sessionId` → 400 |
| BE-02 | Unknown track → rejected; queue unchanged |
| BE-03 | Same `eventId` twice → duplicate / one count |
| BE-04 | Burst taps/votes → 429; health still ok |
| BE-05 | Two WS clients; vote updates both |
| BE-06 | No / disabled Gemini → votes still work |
| BE-07 | DB down / bad `DATABASE_URL` write → clear reject, not “saved” |
| BE-08 | Logs + SQL (`apps/server/sql/demo-queries.sql`) trace `eventId` |

```bash
npm test --workspace=@crowdpulse/server
npm run load-test   # with server running
```
