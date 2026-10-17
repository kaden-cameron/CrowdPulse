# CrowdPulse — Vultr deployment and load testing (Doc 07)

The goal is one public HTTPS URL that judges can open on their own phones. Everything runs on one small Vultr VM: **Caddy** (automatic HTTPS, WebSocket proxy) → **Node server** (API, WebSocket and the built web app) → TigerData, Gemini, Auth0 and Solana devnet over the internet.

```
phone / projector ──HTTPS──▶ Caddy :443 ──▶ crowdpulse (systemd) 127.0.0.1:8787 ──▶ TigerData · Gemini · Auth0 · Solana devnet
```

## 1. Create the instance (about 10 minutes)

1. **Vultr → Deploy → Cloud Compute (Shared CPU).** Pick Ubuntu 24.04 LTS x64 with 1 vCPU / 2 GB RAM, in the region closest to the venue. A 1 GB plan works but `npm ci` and the build are slower.
2. **SSH key:** add yours, so password login isn't needed.
3. **Additional features → Cloud-Init User-Data:** paste all of [`deploy/cloud-init.yaml`](../deploy/cloud-init.yaml). To use your own domain, fill in `DOMAIN=` and point an A record at the instance. Otherwise it uses `<ip-with-dashes>.sslip.io`, which also gets a real Let's Encrypt certificate.
4. Deploy. Setup takes about 3–5 minutes after boot. Follow it with `ssh root@<ip> tail -f /var/log/cloud-init-output.log`.

Cloud-init installs Node 24 and Caddy, clones the repo to `/opt/crowdpulse`, builds it, writes the Caddy config for your hostname, opens only ports 22, 80 and 443, and installs the `crowdpulse` systemd service. **It doesn't start the app**, because production refuses to start without Auth0 and `PUBLIC_URL`.

## 2. Configure secrets on the server only

```bash
ssh root@<ip>
cat /etc/crowdpulse/domain                 # your public hostname
nano /etc/crowdpulse/crowdpulse.env        # mode 600, owned by crowdpulse
systemctl start crowdpulse
journalctl -u crowdpulse -f                # look for the startup line: persistence=tigerdata, hostAuth=auth0
```

`PUBLIC_URL` is already filled in. Add `AUTH0_*`, `DATABASE_URL`, `GEMINI_API_KEY` and optionally `BOOST_RECIPIENT`. All the keys are described in [`deploy/crowdpulse.env.example`](../deploy/crowdpulse.env.example). Secrets never go in the repo, in screenshots, or in the web bundle (`npm run scan:secrets` checks). If one leaks, rotate it.

**Auth0 dashboard → your SPA application**, adding these to the existing localhost entries:
- Allowed Callback URLs: `https://<host>/auth/callback`
- Allowed Logout URLs and Allowed Web Origins: `https://<host>`

## 3. Deploying updates

```bash
ssh root@<ip> /opt/crowdpulse/deploy/update.sh
```

It pulls `main`, runs `npm ci`, builds, restarts the service and waits for `/api/health`. If the app doesn't come up, it prints the last 40 log lines. Connected phones and the projector see "Reconnecting", then come back with the current state.

## 4. What production mode enforces

| Setting | Behavior |
|---|---|
| `NODE_ENV=production` (set by the service) | Refuses to start without Auth0 and `PUBLIC_URL`. The dev host key is off. |
| `PUBLIC_URL` / `CORS_ORIGINS` | Browser requests and WebSocket upgrades from any other origin get **403** (VU-08). Requests without an Origin header (curl) are judged by auth alone. |
| Client IP | Trusts `X-Forwarded-For` only from Caddy on loopback, so rate limits apply per real client and the header can't be spoofed from outside. |
| `RATE_LIMIT_IP_PER_MIN` (default 6000) | An abuse backstop only. Every attendee on venue Wi-Fi can share one IP, and the per-attendee limit does the real throttling. |
| Restarts | On SIGTERM, clients get close code 1012 ("server restarting") and reconnect. systemd restarts on crash within about 2 s. State is replayed from TigerData. |
| Headers | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`. Caddy adds HSTS. |
| Process hardening | Runs as the unprivileged `crowdpulse` user, with a read-only filesystem (`ProtectSystem=strict`), no home access and a private /tmp. |

## 5. Acceptance (VU-01 to VU-08)

Run these from your laptop against the deployed URL. Save outputs and screenshots into `evidence/vultr/`, then run `npm run test:matrix`.

| ID | How | Pass |
|---|---|---|
| VU-01 | Open `https://<host>/join/demo` on a phone **with Wi-Fi off** | Loads over cellular; screenshot → `evidence/vultr/public-url-check.png` |
| VU-02 | `curl https://<host>/api/health` | `ok: true`, `database: up`, no config values |
| VU-03 | Two devices on different networks open `/stage/demo` and `/join/demo`, then vote | Both update live (WebSocket through Caddy) |
| VU-04 | `ssh root@<ip> systemctl restart crowdpulse` with the stage open | Stage shows Reconnecting → Live with the same votes (replayed) |
| VU-05 | `npm run build && npm run scan:secrets` | PASS, 0 findings |
| VU-06 | `npm run load:plan -- --url https://<host>` | Writes `evidence/vultr/load-test-summary.txt`; every stage meets targets |
| VU-07 | Remove `GEMINI_API_KEY` from the env file, `systemctl restart crowdpulse`, then `npm run e2e:check -- --url https://<host>` | E2E-11 PASS; AI card says unavailable. Put the key back afterwards. |
| VU-08 | `curl -X POST https://<host>/api/sessions/demo/votes -H 'origin: https://evil.example' -H 'content-type: application/json' -d '{}'` | 403 `Origin not allowed` |

Then run the full suite against the deployment:

```bash
CROWDPULSE_HOST_TOKEN=<host access token> npm run e2e:check -- --url https://<host> --reset
npm run test:matrix
```

## 6. Load test plan (Doc 07 §5)

`npm run load:plan -- --url https://<host> [--stages 5,10,25,50] [--seconds 20]` ramps through the stages. Each virtual attendee:
- holds a WebSocket like a phone
- sends about one action per second (60% hype taps, 30% votes, 10% mood changes)

For each stage it records req/s, p50/p95/max latency, the error rate (5xx and network errors), 429s, WebSocket opened/failed/dropped counts, and how long a vote takes to reach the voter's own socket. It writes `evidence/vultr/load-test-summary.txt` and `.json`, including the client platform. Run it from a laptop, not from the server itself.

**Local baseline (not VU-06 evidence).** Production mode on a MacBook Air, in memory, no database, 15 s per stage:

| Users | Req/s | p50 | p95 | Errors | WS drops | Vote → socket p95 |
|---|---|---|---|---|---|---|
| 5 | 5.0 | 6 ms | 15 ms | 0% | 0 | 11 ms |
| 10 | 9.8 | 6 ms | 13 ms | 0% | 0 | 11 ms |
| 25 | 23.8 | 6 ms | 28 ms | 0% | 0 | 9 ms |
| 50 | 47.7 | 6 ms | 27 ms | 0% | 0 | 11 ms |

Expect the deployed numbers to be higher: every event waits on a TigerData write before it's applied, and there's real network latency. Record those numbers rather than these.

## 7. Demo resilience

- Keep a second phone on cellular data and the short URL printed on paper.
- **Start new run ↺** on the host page resets the demo without touching the database.
- If the network is unreliable, record a backup video of the full loop and label it **backup recording**.
- Rehearse from a clean browser profile, not a tab that's already signed in.
- Troubleshooting:
  - `journalctl -u crowdpulse -n 100` for app logs
  - `journalctl -u caddy -n 50` for certificates and the proxy
  - `systemctl status crowdpulse caddy`
