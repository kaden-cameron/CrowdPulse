# CrowdPulse — Stage 00 acceptance snapshot

Derived from the master roadmap. Core loop to protect:

**attendee action → validated event → updated metrics → (later) Gemini recommendation → host-approved stage change**

## Must ship (roadmap)

- [x] Mobile-friendly attendee page with session join, mood, track voting
- [x] Shared stage screen with queue, energy, visual-state changes
- [x] Host dashboard shell (metrics live; AI approve later)
- [x] Backend event validation + realtime broadcast (minimal for FE loop)
- [ ] TigerData / PostgreSQL persistence
- [ ] Real Gemini API recommendation
- [ ] Solana boost / Auth0 / Vultr (as time allows)

## Exit criterion — build order step 1

> A vote on one phone updates a second browser within 1 second on the same network.

Prove with `/join/demo` + `/stage/demo` open together.

## Frontend proof (PDF 01)

| ID | Status notes |
|----|----------------|
| FE-01 | Join `/join/demo` loads session name |
| FE-02 | Vote pending → accepted; queue updates after server |
| FE-03 | Stage browser syncs without refresh |
| FE-04 | Connection badge + reconnect |
| FE-05 | Unknown track rejected server-side |
| FE-06 | Host controls focusable |
| FE-07 | Mobile + projector layouts |
| FE-08 | Theme/intensity follow server `visualState` |

## Demo honesty

Never present mock AI / cached chain txs as live. Label any simulated streams **Demo data**.
