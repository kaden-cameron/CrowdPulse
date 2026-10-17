import { useState, type FormEvent } from "react";
import type { SessionState, Track } from "@crowdpulse/shared";
import { hostAddToLibrary, hostClearLibrary, hostPlayTrack, hostRemoveFromLibrary, hostSetQueue } from "../lib/host";
import { usePublicConfig } from "../lib/publicConfig";
import {
  disconnectSpotify,
  redirectProblem,
  spotifyAccessToken,
  spotifyMissingScopes,
  startSpotifyLogin,
  useSpotifyConnected,
} from "../lib/spotify/auth";
import { fetchPlaylistTracks, parsePlaylistId, type FoundTrack } from "../lib/spotify/library";
import { searchSpotifyTracks } from "../lib/spotify/search";

// Host-page window: pick songs. Search Spotify (no login needed when the server has the client
// secret) or import one of your playlists, then build the queue from the library: + Queue,
// Shuffle, or Play now. Gemini estimates genre/BPM/energy for new songs.

type Msg = { kind: "accepted" | "rejected" | "pending"; text: string } | null;

const fmtDuration = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`;
const SOURCE_LABEL: Record<NonNullable<Track["metaSource"]>, string> = {
  catalog: "",
  gemini: "≈ Gemini estimate",
  default: "default values",
};

/** Fisher–Yates; exported for tests. */
export function shuffled<T>(items: T[], rand: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function LibraryCard({
  sessionCode,
  state,
  ready,
  getHeaders,
  onState,
}: {
  sessionCode: string;
  state: SessionState | null;
  ready: boolean;
  getHeaders: () => Promise<Record<string, string>>;
  onState: (s: SessionState) => void;
}) {
  const config = usePublicConfig();
  const connected = useSpotifyConnected();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [playlistInput, setPlaylistInput] = useState("");
  const [preview, setPreview] = useState<{ tracks: FoundTrack[]; skipped: number; truncated: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoundTrack[] | null>(null);

  const tracks = state?.tracks ?? [];
  const playingId = state?.nowPlaying?.trackId;
  const hostQueue = (state?.queue ?? []).filter((q) => q.hostPick).map((q) => q.trackId);
  const inLibrary = new Set(tracks.map((t) => t.spotifyUri).filter(Boolean));
  const libraryIdFor = (uri: string) => tracks.find((t) => t.spotifyUri === uri)?.id;
  // Only "playing" if this song is in the library *and* is the current track (both can be undefined).
  const isPlaying = (uri: string) => {
    const id = libraryIdFor(uri);
    return id !== undefined && playingId === id;
  };

  async function withBusy(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
    } catch (err) {
      setMsg({ kind: "rejected", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function add(found: FoundTrack[]) {
    setMsg({ kind: "pending", text: `Adding ${found.length} song${found.length === 1 ? "" : "s"} — Gemini is estimating BPM and energy…` });
    const r = await hostAddToLibrary(
      sessionCode,
      await getHeaders(),
      found.map(({ title, artist, spotifyUri, coverUrl }) => ({ title, artist, spotifyUri, ...(coverUrl ? { imageUrl: coverUrl } : {}) })),
    );
    const how =
      r.estimatedBy === "gemini" ? " BPM/energy estimated by Gemini." : r.estimatedBy === "mixed" ? " Most BPM/energy estimated by Gemini." : "";
    setMsg({
      kind: r.added ? "accepted" : "rejected",
      text:
        (r.added ? `Added ${r.added} song${r.added === 1 ? "" : "s"}.` : "Nothing added.") +
        (r.skipped ? ` ${r.skipped} already in the library.` : "") +
        how +
        (r.note ? ` ${r.note}` : ""),
    });
    return r;
  }

  const setQueue = async (ids: string[], text: string) => {
    const res = await hostSetQueue(sessionCode, await getHeaders(), ids);
    onState(res.state);
    setMsg({ kind: "accepted", text });
  };

  const onImport = (e: FormEvent) => {
    e.preventDefault();
    const id = parsePlaylistId(playlistInput);
    if (!id) {
      setMsg({ kind: "rejected", text: "Paste a Spotify playlist link (Share → Copy link to playlist)." });
      return;
    }
    void withBusy("import", async () => {
      setPreview(await fetchPlaylistTracks(id, await spotifyAccessToken()));
    });
  };

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    void withBusy("search", async () => {
      const { tracks: hits } = await searchSpotifyTracks(query);
      setResults(
        hits.map((h) => ({
          title: h.title,
          artist: h.artist,
          spotifyUri: h.spotifyUri,
          durationMs: h.durationMs,
          explicit: false,
          imageUrl: h.imageUrl,
          coverUrl: h.coverUrl ?? null,
        })),
      );
    });
  };

  const playNow = (t: FoundTrack) =>
    withBusy(`play:${t.spotifyUri}`, async () => {
      let id = libraryIdFor(t.spotifyUri);
      if (!id) id = (await add([t])).trackIds[0];
      if (!id) throw new Error("Couldn't add that song");
      const res = await hostPlayTrack(sessionCode, await getHeaders(), id);
      onState(res.state);
      setMsg({ kind: "accepted", text: `Playing “${t.title}” now.` });
    });

  const remove = (t: Track) =>
    withBusy(`remove:${t.id}`, async () => {
      await hostRemoveFromLibrary(sessionCode, await getHeaders(), t.id);
      setMsg({ kind: "accepted", text: `Removed “${t.title}”.` });
    });

  const queueSong = (t: Track) =>
    withBusy(`queue:${t.id}`, () => setQueue([...hostQueue, t.id], `“${t.title}” is #${hostQueue.length + 1} in the queue.`));

  const shuffle = () =>
    withBusy("shuffle", () => {
      const ids = shuffled(tracks.filter((t) => t.id !== playingId).map((t) => t.id));
      return setQueue(ids, `Shuffled ${ids.length} songs into the queue.`);
    });

  const clearLibrary = () => {
    const n = tracks.filter((t) => t.id !== playingId).length;
    if (!window.confirm(`Remove ${n} song${n === 1 ? "" : "s"} from the library${playingId ? " (the one playing stays)" : ""}? Their votes and queue spots go too.`)) return;
    void withBusy("clear", async () => {
      const res = await hostClearLibrary(sessionCode, await getHeaders());
      onState(res.state);
      setMsg({ kind: "accepted", text: "Library cleared." });
    });
  };

  const problem = redirectProblem();
  const needsReconnect = connected && spotifyMissingScopes();
  const canImport = ready && connected && !needsReconnect;
  const canSearch = ready && Boolean(config?.spotifySearch || (connected && !needsReconnect));

  return (
    <div className="host-block library-card">
      <h2>Songs</h2>

      <form className="library-form" onSubmit={onSearch}>
        <label className="host-field">
          <span className="metric-label">Search Spotify</span>
          <span className="library-row">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Song or artist"
              disabled={!canSearch}
            />
            <button type="submit" className="btn" disabled={!canSearch || query.trim().length < 2 || busy !== null}>
              {busy === "search" ? "Searching…" : "Search"}
            </button>
          </span>
        </label>
      </form>
      {!ready && <p className="host-sub">Sign in as host to pick songs.</p>}
      {ready && config && !canSearch && (
        <p className="host-sub">Connect Spotify under &ldquo;Import a Spotify playlist&rdquo; to search, or set SPOTIFY_CLIENT_SECRET on the server.</p>
      )}
      {results && (
        <ul className="panel library-results">
          {!results.length && <li className="host-sub">No songs found.</li>}
          {results.map((t) => {
            const already = inLibrary.has(t.spotifyUri);
            return (
              <li key={t.spotifyUri}>
                {t.imageUrl ? <img src={t.imageUrl} alt="" width={40} height={40} /> : <span className="library-art" aria-hidden />}
                <span className="library-meta">
                  <strong>{t.title}</strong>
                  <em>
                    {t.artist}
                    {t.durationMs > 0 && ` · ${fmtDuration(t.durationMs)}`}
                    {t.explicit && " · explicit"}
                  </em>
                </span>
                <button
                  type="button"
                  className="btn compact"
                  disabled={already || busy !== null}
                  onClick={() => void withBusy(`add:${t.spotifyUri}`, async () => void (await add([t])))}
                  aria-label={already ? `${t.title} is in the library` : `Add ${t.title} to the library`}
                >
                  {already ? "In library" : busy === `add:${t.spotifyUri}` ? "Adding…" : "Add"}
                </button>
                <button
                  type="button"
                  className="btn primary compact"
                  disabled={busy !== null || isPlaying(t.spotifyUri)}
                  onClick={() => void playNow(t)}
                  aria-label={`Play ${t.title} now`}
                >
                  {busy === `play:${t.spotifyUri}` ? "…" : "Play now"}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div role="status" aria-live="polite">
        {msg && <p className={`feedback feedback-${msg.kind}`}>{msg.text}</p>}
      </div>

      <div className="library-head">
        <span className="metric-label">
          Library · {tracks.length} song{tracks.length === 1 ? "" : "s"}
        </span>
        <span className="cta-row">
          <button type="button" className="btn compact" disabled={!ready || busy !== null || tracks.length < 2} onClick={() => void shuffle()}>
            {busy === "shuffle" ? "Shuffling…" : "🔀 Shuffle"}
          </button>
          <button
            type="button"
            className="btn ghost compact"
            disabled={!ready || busy !== null || !tracks.some((t) => t.id !== playingId)}
            onClick={clearLibrary}
          >
            {busy === "clear" ? "Clearing…" : "Clear library"}
          </button>
        </span>
      </div>
      <ul className="panel library-list">
        {!tracks.length && <li className="host-sub">No songs yet — search above or import a playlist.</li>}
        {tracks.map((t) => {
          const pos = hostQueue.indexOf(t.id);
          return (
            <li key={t.id}>
              <span className="library-meta">
                <strong>
                  {t.id === playingId && "▶ "}
                  {t.title}
                </strong>
                <em>
                  {t.artist} · {t.genre} · {t.bpm} BPM · energy {t.energy.toFixed(2)}
                  {t.metaSource && SOURCE_LABEL[t.metaSource] && <span className={`meta-${t.metaSource}`}> · {SOURCE_LABEL[t.metaSource]}</span>}
                </em>
              </span>
              <button
                type="button"
                className="btn compact"
                disabled={!ready || busy !== null || t.id === playingId || pos >= 0}
                onClick={() => void queueSong(t)}
                aria-label={pos >= 0 ? `${t.title} is #${pos + 1} in the queue` : `Add ${t.title} to the queue`}
              >
                {pos >= 0 ? `#${pos + 1}` : "+ Queue"}
              </button>
              <button
                type="button"
                className="btn ghost compact"
                disabled={!ready || busy !== null || t.id === playingId}
                onClick={() => void remove(t)}
                aria-label={`Remove ${t.title} from the library`}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>

      <details className="library-import">
        <summary>Import a Spotify playlist</summary>
        {!config?.spotifyClientId ? (
          <p className="host-sub">
            Add <code>SPOTIFY_CLIENT_ID</code> to the server&apos;s env to import playlists.
          </p>
        ) : problem ? (
          <p className="feedback feedback-warn">{problem}</p>
        ) : !connected || needsReconnect ? (
          <div className="host-auth">
            <button
              type="button"
              className="btn"
              disabled={!ready}
              onClick={() => void startSpotifyLogin(config.spotifyClientId!, window.location.pathname)}
            >
              {needsReconnect ? "Reconnect Spotify (new permissions)" : "Connect Spotify"}
            </button>
            <span className="host-sub">{ready ? "Opens a Spotify login window to read your playlists." : "Sign in as host first."}</span>
          </div>
        ) : (
          <div className="host-auth">
            <span className="host-user">✓ Spotify connected</span>
            <button type="button" className="btn ghost compact" onClick={disconnectSpotify}>
              Disconnect
            </button>
          </div>
        )}
        <form className="library-form" onSubmit={onImport}>
          <label className="host-field">
            <span className="metric-label">A playlist you own or collaborate on</span>
            <span className="library-row">
              <input
                type="text"
                value={playlistInput}
                onChange={(e) => setPlaylistInput(e.target.value)}
                placeholder="https://open.spotify.com/playlist/…"
                disabled={!canImport}
              />
              <button type="submit" className="btn" disabled={!canImport || !playlistInput.trim() || busy !== null}>
                {busy === "import" ? "Reading…" : "Preview"}
              </button>
            </span>
          </label>
        </form>
        {preview && (
          <div className="panel library-preview">
            <p>
              <strong>{preview.tracks.length}</strong> song{preview.tracks.length === 1 ? "" : "s"} found
              {preview.tracks.filter((t) => inLibrary.has(t.spotifyUri)).length > 0 &&
                ` (${preview.tracks.filter((t) => inLibrary.has(t.spotifyUri)).length} already in the library)`}
              {preview.skipped > 0 && ` · ${preview.skipped} skipped (local files, podcasts, unavailable)`}
              {preview.truncated && " · only the first 100 are imported"}
            </p>
            <div className="cta-row">
              <button
                type="button"
                className="btn primary"
                disabled={busy !== null || !preview.tracks.length}
                onClick={() =>
                  void withBusy("add-playlist", async () => {
                    await add(preview.tracks);
                    setPreview(null);
                    setPlaylistInput("");
                  })
                }
              >
                {busy === "add-playlist" ? "Adding…" : "Add to library"}
              </button>
              <button type="button" className="btn ghost" onClick={() => setPreview(null)} disabled={busy !== null}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </details>
    </div>
  );
}
