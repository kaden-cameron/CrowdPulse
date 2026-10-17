# Evidence (Doc 08 §4, Doc 09 §3)

Real evidence captured from running the app. Never put API keys, bearer tokens, wallet secrets, `.env` values or personal data in here. Don't mark a test passed based only on reading the code.

```
evidence/
  frontend/   join-and-vote.png, stage-updated.png, host-dashboard.png   ← npm run e2e:browser
  backend/    duplicate-rejected.txt                                      ← npm run e2e:check
  tigerdata/  metrics-after-vote.json  (+ add a screenshot of the SQL editor)
  gemini/     request-metadata.txt, baseline-results.csv, evaluation-summary.txt   ← e2e:check, npm run eval
  solana/     devnet-signature.txt                                        ← e2e:check --boost-signature …
  auth0/      attendee-forbidden.txt                                      ← e2e:check
  vultr/      public-url-check.png, load-test-summary.txt                 ← Doc 07
  e2e/        latest.md (+ timestamped runs)                              ← npm run e2e:check
```

## Master tracker

Update this table during the hackathon, using a file path for each piece of evidence.

| Test group | Owner | Status | Evidence / notes |
|---|---|---|---|
| Frontend (FE-01 to 08) | | Pass, local only | `frontend/*.png` from `e2e:browser` on the local isolated stack (5/5 pass). Rerun on a real phone against the deployed URL. |
| Backend (BE-01 to 08) | | Pass, local only | Unit tests + `e2e:check` locally: duplicate counted once, 400 on invalid, 401 on host routes, reconnect snapshot. Load test not yet run on the merged build. |
| TigerData (TD-01 to 08) | | Not run | Needs `DATABASE_URL`. The integration suite skips without it. |
| Gemini (GM-01 to 09) | | Partial | GM-02 to 08 pass against a fake model. GM-01 (live call) and the eval need `GEMINI_API_KEY`. |
| Solana (SOL-01 to 09) | | Partial | SOL-02 to 09 pass against a fake RPC. Real devnet transactions are correctly refused. A live paid boost (SOL-01) needs a funded devnet wallet. |
| Auth0 (AU-01 to 08) | | Partial | AU-02 to 06 and AU-08 pass against a local stand-in JWKS. AU-07 secret scan is clean. AU-01 (real login) needs a tenant. |
| Vultr / load (VU-*) | | Not run | Doc 07 |
| End-to-end (E2E-01 to 12) | | Partial, local only | `e2e:check` locally: 8 pass, 5 skip (no DB, Gemini, boost recipient). Must be rerun against the deployment with all integrations on. |

## Minimum evidence package (Doc 09 §4)

- [ ] Image or clip of an attendee vote updating the stage (`frontend/`, local version done; redo on the deployed URL)
- [ ] A SQL query result matching a UI event (`tigerdata/`)
- [ ] One real Gemini request and validated response, without secrets (`gemini/request-metadata.txt`)
- [ ] An access-control failure from an attendee (`auth0/attendee-forbidden.txt`)
- [ ] A public deployment health check and a load-test summary (`vultr/`)
- [ ] A verified Solana devnet signature, if Solana is in the demo (`solana/`)
- [ ] Baseline-versus-Gemini results with the scenario count and limitations (`gemini/baseline-results.csv`)
