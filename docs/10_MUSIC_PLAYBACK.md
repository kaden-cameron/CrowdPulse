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

## Spotify

The player page can play through **Spotify** instead of the laptop's own audio. The page becomes a Spotify device called "CrowdPulse" (via the Web Playback SDK), and CrowdPulse starts each track on it. Votes, Gemini, boosts, auto/DJ modes and the host flow work exactly the same.

### One-time setup

1. **Spotify Developer Dashboard → your app → Settings**
   - **Redirect URIs:** add `https://<your-host>/spotify/callback` (e.g. `https://155-138-211-63.sslip.io/spotify/callback`) and, for local testing, `http://127.0.0.1:5173/spotify/callback`. Spotify rejects `localhost`: use `127.0.0.1`.
   - **APIs used:** tick **Web API** and **Web Playback SDK**.
   - **User Management:** add the Spotify account(s) the host will log in with. Development mode allows at most **5 users**. Attendees never log in to Spotify.
2. **Premium:** the app owner's account and the host's account both need Spotify **Premium**.
3. **Server env** (`.env` locally, `/etc/crowdpulse/crowdpulse.env` on Vultr):
   ```
   SPOTIFY_CLIENT_ID=<your app's Client ID>
   CATALOG_FILE=apps/server/catalog.json
   ```
   Only the **Client ID** is used. Login uses PKCE, so the **Client Secret is not needed. Don't put it in any env file, the repo or the frontend.** The Client ID is public by design.
4. **Real songs:** copy `apps/server/catalog.example.json` to `apps/server/catalog.json` and replace the demo entries with your songs:
   ```json
   { "id": "song_01", "title": "Song Title", "artist": "Artist", "genre": "house", "bpm": 124, "energy": 0.8,
     "spotifyUri": "https://open.spotify.com/track/…" }
   ```
   - `spotifyUri` is optional. Paste a share link (Share → Copy Song Link) or a `spotify:track:` URI. Without it, the player searches Spotify for the title and artist and plays the top match.
   - **`bpm` and `energy` (0–1) are yours to set,** because Spotify no longer gives new apps audio features. Gemini uses them.
   - IDs must be unique, with 2–100 songs. The server refuses to start on a bad file and names the problem.
   - Restart the server after changing it. Votes in the current run refer to the old IDs, so start a new run.

### Building the song list from the host page

The **Music library** window on `/host/demo` builds the session's song list straight from Spotify, so no catalog file is needed:

1. **Connect Spotify** in that window. It's the same login as the player, plus permission to read your playlists. If you connected before this feature existed, the window shows **Reconnect Spotify** once.
2. **Import a playlist:** paste its link (Share → Copy link to playlist) → **Preview** → **Add to library**. Up to 100 songs per import, and 150 in the library. Local files, podcasts and unavailable songs are skipped, and songs already in the library aren't added twice.
   - **Spotify only lets apps read playlists you own or collaborate on.** For someone else's playlist (even a public one), open it in Spotify, select the songs and add them to a playlist of your own, then import that.
3. **Search:** type a song or artist → **Add** puts it in the library for attendees to vote on. **Play next** adds it if needed and starts it on the player straight away.
4. **Gemini estimates genre, BPM and energy** for new songs, in batches, using its general knowledge of each song. These are estimates, and the library list marks them "≈ Gemini estimate". Every value is checked before it's stored: plain-text genre, BPM 40–220, energy 0–1.
   - **If Gemini isn't configured or can't answer,** the song is still added with neutral values (110 BPM, energy 0.5), marked "default values".
5. Remove songs with ✕ (not the one playing). The library is saved in TigerData and survives restarts and new runs, and Gemini isn't called again for songs already stored.

A catalog file (below) is still supported for a fixed starting list. Songs added from the host page go on top of it.

### At the venue

1. On the speaker laptop, use Chrome, Edge or Firefox to open `https://<your-host>/player/demo` (or `http://127.0.0.1:5173/player/demo` locally) and sign in as host.
2. **Play music from → Spotify → Connect Spotify (Premium account)**, then log in. You come back to the player.
3. Press **▶ Start audio on this device**. The Spotify app on any phone will now list a "CrowdPulse" device. Leave it alone, because picking another device takes playback away from CrowdPulse.
4. Use Auto play or DJ picks on the host page as usual.

When a track ends, the player pauses Spotify straight away, so Spotify's autoplay doesn't start an unrelated song, and tells the server. There's no crossfade, because Spotify forbids mixing in third-party apps.

### When something goes wrong

| Message | Fix |
|---|---|
| "Spotify isn't set up on this server" | Set `SPOTIFY_CLIENT_ID` and restart |
| "Spotify doesn't allow localhost" | Open the page at `http://127.0.0.1:…` |
| "Spotify Premium is required" / "Spotify refused playback (403)" | Log in with a Premium account that's on the app's User Management list |
| "… wasn't found on Spotify" | Add that song's `spotifyUri` to the catalog. In auto mode the player skips to the next song. |
| "This browser can't run the Spotify player" | Use desktop Chrome, Edge or Firefox |

**Backup:** switch **Play music from → This laptop** at any time. It plays local files or generated tracks and picks up the current song immediately.

**Licensing:** Spotify's license covers personal listening, not public performance. That's fine for a hackathon demo; a real venue needs its own public-performance license.

### How it's built

`SpotifyPlayer` ([`apps/web/src/lib/player/spotifyPlayer.ts`](../apps/web/src/lib/player/spotifyPlayer.ts)) implements the same `PlayerAdapter` as the local player. The login is in [`apps/web/src/lib/spotify/auth.ts`](../apps/web/src/lib/spotify/auth.ts): Authorization Code with PKCE, with tokens in the tab's session storage, refreshed automatically. The server only adds `SPOTIFY_CLIENT_ID` to `GET /api/public-config` and loads `CATALOG_FILE`.
