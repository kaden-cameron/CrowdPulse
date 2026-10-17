# E2E run — 2026-10-17T15:25:06.076Z

Target: https://155-138-211-63.sslip.io · session `demo` · database up · gemini configured · host creds none

**7 pass · 0 fail · 6 skip**

| ID | Check | Result | Evidence / reason |
|---|---|---|---|
| HEALTH | Health endpoint is up and leaks no config | PASS | database=up gemini=configured |
| E2E-01 | Join link resolves the correct session | PASS | "SwampHacks Main Stage"; /join page HTTP 200; unknown session 404 |
| E2E-02/03 | Vote is accepted and a second client sees it without refresh | PASS | second client updated in 183 ms |
| FAULT | Duplicate eventId counts once; invalid event rejected | PASS | retry → duplicate, count unchanged; unknown track / missing sessionId → 400 |
| E2E-04/05 | Event persists to TigerData and metrics advance | PASS | totalEvents 20 → 21; latest 2026-10-17T15:25:05.143Z; query 69.3 ms |
| E2E-09 | Attendee (no host credentials) can't use host actions | PASS | host routes → 401, forged token → 401, no state change |
| E2E-06 | Real Gemini recommendation with structured, validated output | SKIP | no host credentials |
| E2E-07 | Host rejects a recommendation; stage unchanged | SKIP | no host credentials |
| E2E-08 | Host approves a valid recommendation; stage changes to it | SKIP | no host credentials |
| HOST | Host manual stage change reaches clients (FE-08) | SKIP | no host credentials |
| E2E-10 | Solana devnet boost verified server-side | SKIP | malformed signature rejected ✓; pass --boost-signature/--boost-intent from `npm run boost:devnet` for a live verified boost |
| E2E-11 | Votes and stage updates continue while Gemini is unavailable | SKIP | Gemini is configured here; covered by unit test GM-07 — rerun this check against a server without GEMINI_API_KEY |
| E2E-12 | Reconnected client gets the current authoritative state | PASS | missed update recovered on reconnect (v6 → v7) |
