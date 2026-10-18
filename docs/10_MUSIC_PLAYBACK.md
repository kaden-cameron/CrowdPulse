# CrowdPulse — Music playback

CrowdPulse decides **what** plays: crowd votes, devnet boosts, Gemini picks and the host. A **player page** on the DJ laptop makes the sound through the venue speakers and reports back. The server stays the source of truth: the player only follows `nowPlaying`.

```
votes · boosts · Gemini · host ──▶ server: nowPlaying + playback state ──WebSocket──▶ /player/demo (DJ laptop) ──▶ PA speakers
                                          ▲                                               │
                                          └──── started / progress (every 5s) / ended ◀───┘
```

## Running it

1. On the laptop plugged into the speakers, open the host page (**`/host/demo`**). Its **Now playing** window is the player: sign in, then press **▶ Start audio on this device** under *Speakers*. Browsers only allow sound after a click, so this step can't be skipped.
   - If the speakers are on a different laptop from the host, open **`/player/demo`** there instead. It shows the same Now playing window on its own. Only start audio on one device, or both will play.
   - **Now playing** shows the album cover, the song, and a progress bar. Covers are saved when a song is added from Spotify. For songs added before that, the server looks the cover up on Spotify, which needs `SPOTIFY_CLIENT_SECRET`.
2. On the host page, use the **Now playing** window:
   - **Auto play:** when a song ends, the top-voted track starts. If nothing has votes, it plays the least-recently-played track. Music never stops on its own.
   - **DJ picks:** when a song ends, nothing else starts until the host taps **⏭ Skip** or approves a Gemini recommendation.
   - The card shows whether the player is online (it reports every 5 s), what's playing, and any playback error.
3. The stage shows a progress bar under **Now playing** while a song is actually playing.

## Where the audio comes from

**Spotify only.** The speaker tab becomes a Spotify Connect device ("CrowdPulse") and plays each song in full. It needs `SPOTIFY_CLIENT_ID` on the server and a Spotify Premium login on the speaker laptop. The old "This laptop" option (local audio files and generated demo tracks) has been removed.

## Rules the server enforces

- Only the host can send player reports or change the mode (Auth0 or the dev key), so attendees can't fake "song ended".
- A report only counts for the **current track and round**. A second player tab, a stale report or a duplicate "ended" can't skip songs.
- Host actions (Skip, Gemini approval, "Start new run") are applied in order with in-flight votes, so the song that plays is the one the crowd and host see.
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
   SPOTIFY_CLIENT_SECRET=<your app's Client Secret>   # server-only; enables phone search
   ```
   - **Client ID** is public (player login uses PKCE).
   - **Client Secret** stays on the server. It powers `/api/spotify/search` so attendees can find real songs without logging into Spotify. Never put it in the frontend or commit it.
   - Optional: `CATALOG_FILE=apps/server/catalog.json` for a fixed starter list. With Spotify configured and no catalog file, the session starts **empty** and songs come from search.
4. **Real songs (live search):** on `/join/demo` or `/host/demo`, use **Search Spotify**, then **Add & vote** (attendee) or **Add** / **Play** (host). Tracks land in the live catalog with their `spotify:track:` URI so the player page can play them.
   - Optional fixed list: copy `apps/server/catalog.example.json` to `apps/server/catalog.json` and set `CATALOG_FILE`.
   - **`bpm` and `energy` (0–1)** for searched songs use defaults (Spotify no longer gives new apps audio features). Override them in a catalog file if you care for Gemini.
   - Catalog max 100 songs. Restart after changing `CATALOG_FILE`; live search adds do not need a restart.

### Building the song list from the host page

The **Songs** window on `/host/demo` builds the session's song list straight from Spotify, so no catalog file is needed:

1. **Connect Spotify** in that window. It's the same login as the player, plus permission to read your playlists. If you connected before this feature existed, the window shows **Reconnect Spotify** once.
2. **Import a playlist:** paste its link (Share → Copy link to playlist) → **Preview** → untick any songs you don't want → **Add selected**. Up to 100 songs per import, and 150 in the library. Local files, podcasts and unavailable songs are skipped, and songs already in the library aren't added twice.
   - **Spotify only lets apps read playlists you own or collaborate on.** For someone else's playlist (even a public one), open it in Spotify, select the songs and add them to a playlist of your own, then import that.
3. **Search:** type a song or artist, tick results (or **Select all**) → **Add selected** puts them in the library for attendees to vote on. **Play now** adds it if needed and starts it straight away. Search runs on the server (needs `SPOTIFY_CLIENT_SECRET`), so it works without connecting Spotify; only playlist import needs your Spotify login, which opens in a popup so the host sign-in is kept.
4. **Gemini estimates genre, BPM and energy** for new songs, in batches, using its general knowledge of each song. These are estimates, and the library list marks them "≈ Gemini estimate". Every value is checked before it's stored: plain-text genre, BPM 40–220, energy 0–1.
   - **If Gemini isn't configured or can't answer,** the song is still added with neutral values (110 BPM, energy 0.5), marked "default values".
5. Remove songs with ✕ (not the one playing). The library is saved in TigerData and survives restarts and new runs, and Gemini isn't called again for songs already stored.

### The queue, skipping and moving within a song

- **The host's queue comes first.** **+ Queue** on a library song adds it to the end of the **Queue** window, and **🔀 Shuffle** puts the whole library there in random order. In the Queue window, ↑ / ↓ reorder, ✕ takes a song out, and **Clear queue** empties it. The crowd's top-voted songs play after the host's picks. Saved in TigerData.
- **⏮ Previous** restarts the song if it's more than 5 s in; otherwise it goes back to the song before (and Skip returns to the one you left). **⏸ Pause / ▶ Resume** hold the song on the speaker and carry on from the same spot; auto play waits while paused.
- **⏭ Skip** plays the next song in the queue now. If the queue is empty it plays the least recently played song, so it always works.
- **Drag the position slider** in Now playing to jump within the song. The player, wherever it is, jumps too, and the projector's progress bar follows.
- **Clear library** removes every song except the one playing (after a confirmation).
- **Auto play never loops through broken songs.** If the player itself can't play (Spotify disconnected, not Premium), that device stops and asks the host to press Start audio again; nothing is skipped. If 3 songs in a row fail, auto play pauses and the host page shows the error.
- **Gemini avoids repeats.** It's never offered the last 4 songs played or its own last 3 suggestions (unless the library is too small), and it sees how often it has suggested each song.

### Attendees: votes, genre, one voter per device

- **Joining:** attendees pick a mood and **what they want to hear** (a genre from the library, or "Anything"). The host page shows the genre tally under *Genres people want*, and Gemini sees it as `crowd_genres`.
- **The vote list** shows the playing song, then the most-voted songs first, 15 per page, with a search box (title, artist or genre).
- **Votes:** each attendee can have **3 votes at once**. Tapping **Voted ✓ · undo** takes a vote back and frees it. A song that plays uses its votes up.
- **One voter per device:** every tab on a device shares the same anonymous id, and the server remembers it, so a reload or a new tab goes straight back to voting with the same votes. Only one tab is active at a time; older tabs show *Use it here*. (A private window or another browser is a different device as far as the app can tell.)

### Host settings (⚙︎)

The ⚙︎ button at the right of the host page's menu bar opens Account, Appearance and Stage controls. **Show crowd energy** (under Appearance) hides the energy meter on the projector and the energy number on phones, for everyone. The library in **Songs** can be sorted (title, artist, votes, genre, BPM, energy, newest).

### Asking Gemini

The Gemini window has a text box (a description or a line of lyrics, optional), an optional **genres** picker (choose any number; none = any genre), and one **Popularity** slider: a minimum and maximum of all-time Spotify streams (0 to 2B+). Spotify doesn't give apps play counts, so stream numbers are **Gemini's estimates**, labelled as such.

- **Get recommendation** picks from the library, limited to the chosen genres and aimed at the popularity range. The host still approves every pick. If no library song is in that genre, it says so instead of asking Gemini.
- **🔎 Find songs** lists songs for a description ("songs for a late-night hackathon party") or recognizes lyrics, even songs not in the library. Choose **How many** (5–50). Gemini names the songs (titles and artists only, never lyrics) with estimated streams; songs outside the range are dropped, and each one is checked on Spotify (a 20-song find takes about 7 s). Tick songs, or **Select all**, then **Add selected**; or **Play now** on one.
- **🎲 Surprise me** finds one random song in the genre and popularity range that isn't already in the library. Gemini suggests a varied pool; the server picks one at random, weighted toward more-streamed songs (by the square root of streams, so hits come up more often without always winning), and confirms it on Spotify.

Find and Surprise me need `GEMINI_API_KEY` and `SPOTIFY_CLIENT_SECRET`.

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
| "… wasn't found on Spotify" | Add that song's `spotifyUri` to the catalog. In auto mode the player skips to the next song (and pauses after 3 failures in a row). |
| "This browser can't run the Spotify player" | Use desktop Chrome, Edge or Firefox |

**Licensing:** Spotify's license covers personal listening, not public performance. That's fine for a hackathon demo; a real venue needs its own public-performance license.

### How it's built

`SpotifyPlayer` ([`apps/web/src/lib/player/spotifyPlayer.ts`](../apps/web/src/lib/player/spotifyPlayer.ts)) implements the same `PlayerAdapter` as the local player. The login is in [`apps/web/src/lib/spotify/auth.ts`](../apps/web/src/lib/spotify/auth.ts): Authorization Code with PKCE, with tokens in the tab's session storage, refreshed automatically. The server only adds `SPOTIFY_CLIENT_ID` to `GET /api/public-config` and loads `CATALOG_FILE`.
