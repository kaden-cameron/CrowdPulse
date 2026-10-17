# CrowdPulse — Judge demo runbook (Doc 08)

Use this to rehearse and run the 3-minute demo. Rehearse it **twice in a row, with a timer**, starting from a clean browser profile, before judging.

## Before judges arrive (T-15 min)

1. **Deployed URL is up:** `curl https://<your-domain>/api/health` should return `ok: true`. `database` must be `up`, and `gemini` must be `configured` if you're showing AI.
2. **Run the automated check** against the deployed URL. It writes to `evidence/e2e/latest.md`. Don't run it during the demo, because it casts votes.
   ```bash
   CROWDPULSE_HOST_TOKEN=<host access token> npm run e2e:check -- --url https://<your-domain> --reset
   ```
   Go only if there are **0 FAIL** results, and every SKIP is something you've chosen to leave out of the demo.
3. **Start a clean run:** Host page → **Start new run ↺**. Old data stays in TigerData for audit, and no manual database edits are needed.
4. **Screens:**
   - **Projector:** `/stage/demo`. Check the QR code shows the public URL, not `localhost`.
   - **Laptop:** `/host/demo`, signed in as the host. Have a private window open on the same page for the security beat.
   - **Terminal:** the TigerData SQL editor with `apps/server/sql/demo-queries.sql` loaded.
   - **Two phones**, one on cellular data, plus the short URL printed on paper.
   - **Devnet:** if you're showing Solana, Phantom set to devnet and funded, with Solana Explorer ready.

## The 3 minutes

| Time | Do this | Say this (one line) | Proof on screen |
|---|---|---|---|
| 0:00–0:25 | Judge scans the QR, picks a mood, taps **Continue to vote** | "No app, no account: scan and you're in." | Their phone shows the session name; the stage crowd count goes up |
| 0:25–0:55 | Judge and teammate vote for different tracks; judge taps **Hype tap** | "Every vote is checked on the server, then pushed to every screen." | "Up next" reorders and the energy meter climbs, with no refresh |
| 0:55–1:25 | Host page **Live analytics**, then run *Latest events* in the SQL editor | "That vote is a row in TigerData. The dashboard reads the same table." | The SQL row matches the vote; "Latest persisted event" advances; hatched bars show what isn't aggregated yet |
| 1:25–1:55 | **Gemini AI DJ** → *Raise energy* → **Get recommendation** → read the reason → **Approve & apply** | "Gemini sees a crowd summary and proposes. The server checks it. I decide." | The reason cites crowd data; the baseline sits beside it; response ID and latency shown; the stage theme changes |
| 1:55–2:20 | (If ready) Phone: ⚡ on a track → pay with Phantom (devnet) | "Optional boost on Solana devnet, test SOL only. It only counts once the server verifies it on-chain." | Pending → verified; Explorer link; ⚡ on the stage queue |
| 2:20–2:40 | In the private window, run the `curl` from the README security demo | "Attendees can't touch host controls. The server enforces it, not the UI." | 401 (or 403 for a signed-in non-host); stage unchanged |
| 2:40–3:00 | Show `evidence/e2e/latest.md` and the load-test result | "Here's what we measured, and what we didn't." | PASS/SKIP table with real numbers |

**If Solana isn't ready, skip that beat** and give the time to the AI or data beat. Never show a fake confirmation.

## If something breaks

| Problem | Do this |
|---|---|
| A phone can't load the page | Use the printed short URL. Hand over the spare phone (cellular data). |
| Gemini is slow or failing | Say so: "AI unavailable — voting keeps working." Keep voting on screen to show it. Don't show a cached answer as live. |
| The database is down | The dashboard says the query failed and the phones say "retrying". Point at the honest error. Votes aren't counted as saved. |
| Solana RPC is slow | The status stays *pending* or *unknown*. Show the Explorer link and move on. |
| The stage loses connection | It dims and says "Disconnected — live data paused". It recovers by itself. Reload only as a last resort. |
| You need visible activity | `npm run demo:crowd -- --url https://<your-domain> --people 20 --seconds 45 --mood wild`. The stage labels it **Demo data**. Say it's simulated. |

## Go / no-go (from Doc 08 §6)

- [ ] The core vote-to-stage flow passes **3 times in a row** on the deployed URL
- [ ] At least one **real Gemini call** succeeds from the deployed environment (E2E-06 PASS)
- [ ] TigerData shows the matching events and a live metric (E2E-04/05 PASS)
- [ ] A host endpoint rejects an attendee (E2E-09 PASS)
- [ ] Solana is either **verified live** (E2E-10 PASS) or **left out** of the demo
- [ ] The public app is reachable from a second device on a **different network**
- [ ] The fallback path has been rehearsed, and simulated data is labeled
- [ ] The pitch fits in 3 minutes, with time for judge questions

> If the end-to-end loop isn't reliable, stop adding features. Fix the loop, rehearse it, and present a smaller product that clearly works.

## Test commands

| Command | What it covers |
|---|---|
| `npm test` | Unit and integration tests: validation, dedup, persistence failure, replay, AI validation (GM-02 to 08), Solana (SOL-02 to 09), Auth0 (AU-02 to 06, 08), reset |
| `npm run e2e:browser` | Playwright on an isolated local stack: phone joins and votes, stage updates, offline vote sent once, host theme change, attendee 401, demo-data label. Saves screenshots to `evidence/frontend/` |
| `npm run e2e:check -- --url <url> [--host-token …]` | API-level E2E-01 to 12 plus fault checks against any deployment. Writes `evidence/e2e/latest.md` |
| `npm run load-test` | Concurrent vote load (Doc 07). Writes `docs/02_LOAD_TEST_RESULTS.json` |
| `npm run scan:secrets` | Bundle and repo secret scan (AU-07 / VU-05) |
