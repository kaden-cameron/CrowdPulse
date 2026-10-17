# CrowdPulse — Music playback

CrowdPulse decides **what** plays: crowd votes, devnet boosts, Gemini picks and the host. A **player page** on the DJ laptop makes the sound through the venue speakers and reports back. The server stays the source of truth: the player only follows `nowPlaying`.

```
votes · boosts · Gemini · host ──▶ server: nowPlaying + playback state ──WebSocket──▶ /player/demo (DJ laptop) ──▶ PA speakers
                                          ▲                                               │
                                          └──── started / progress (every 5s) / ended ◀───┘
```

## Running it

1. On the laptop plugged into the speakers, open **`/player/demo`**. Sign in as host, then press **▶ Start audio on this device**. Browsers only allow sound after a click, so this step can't be skipped.
2. On the host page, use the **Music playback** card:
   - **Auto play:** when a song ends, the top-voted track starts. If nothing has votes, it plays the least-recently-played track. Music never stops on its own.
   - **DJ picks:** when a song ends, nothing else starts until the host taps **Play next ▶** or approves a Gemini recommendation.
   - The card shows whether the player is online (it reports every 5 s), what's playing, and any playback error.
3. The stage shows a progress bar under **Now playing** while a song is actually playing.

`?demoSeconds=20` on the player URL shortens the generated tracks for rehearsals (the default is 60 s).

## Where the audio comes from

| Source | When |
|---|---|
| **Audio file** | The track ID is listed in [`apps/web/public/audio/manifest.json`](../apps/web/public/audio/README.md) (`{"track_01": "gator-glow.mp3"}`) and the file is in that folder. |
| **Generated demo track** | Every other track. It's a groove built live in the browser from the track's BPM, energy and genre: four-on-the-floor and an arpeggio for high energy, half-time drums and pads for chill tracks. It always works, offline, with no licensing questions. |

**Only add music you're allowed to play in public:** your own tracks, royalty-free music, or Creative Commons tracks that allow it, credited where the license requires. Files in that folder are publicly downloadable from the app. If a file fails to load, the player falls back to the generated version and tells the host.

Songs crossfade over 1.5 s, and a limiter keeps the output from clipping the PA.

## Rules the server enforces

- Only the host can send player reports or change the mode (Auth0 or the dev key), so attendees can't fake "song ended".
- A report only counts for the **current track and round**. A second player tab, a stale report or a duplicate "ended" can't skip songs.
- Host actions ("Play next", Gemini approval, "Start new run") are applied in order with in-flight votes, so the song that plays is the one the crowd and host see.
- The mode is saved in TigerData and survives restarts. If the player page reloads mid-song, it picks up where the server says the song is.

API: `POST /api/host/sessions/:id/playback/mode {mode: "auto"|"dj"}` and `POST /api/host/sessions/:id/playback/report {event, trackId, round, positionMs?, durationMs?, source?, message?}`. The state is in `session.state.playback`.

## Adding Spotify later

The browser player implements the `PlayerAdapter` interface ([`apps/web/src/lib/player/types.ts`](../apps/web/src/lib/player/types.ts)): `unlock`, `play`, `stop`, `setVolume`, `positionMs`, `onEnded`. A Spotify player would implement the same interface, so votes, Gemini and the host flow don't change.

- **Web Playback SDK** (the player page becomes a Spotify device), or **Spotify Connect** (the server tells a Spotify device to play).
- Needs Spotify Premium for the app owner and the host. Development mode allows at most 5 users, which is fine because only hosts sign in to Spotify.
- Map catalog tracks to Spotify track IDs. Keep our own BPM and energy, because Spotify no longer gives new apps audio features.
- Spotify forbids mixing or blending tracks in third-party apps, so turn off our crossfade for Spotify and use the Spotify app's own setting. Its license covers personal listening only; a real venue needs its own public-performance license.
- Keep the local player as the on-stage backup if Spotify sign-in or the device connection fails.
