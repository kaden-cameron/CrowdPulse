import { useState, type FormEvent } from "react";
import type { SessionState, Track } from "@crowdpulse/shared";
import { hostAddToLibrary, hostPlayTrack, hostRemoveFromLibrary } from "../lib/host";
import { usePublicConfig } from "../lib/publicConfig";
import {
  disconnectSpotify,
  redirectProblem,
  spotifyAccessToken,
  spotifyConnected,
  spotifyMissingScopes,
  startSpotifyLogin,
} from "../lib/spotify/auth";
import { fetchPlaylistTracks, parsePlaylistId, searchSpotifyTracks, type FoundTrack } from "../lib/spotify/library";

// Host-page window: build the session's song list from Spotify — import a playlist or search and
// add songs one by one (or play one next). Gemini estimates genre/BPM/energy for new songs.

type Msg = { kind: "accepted" | "rejected" | "pending"; text: string } | null;

const fmtDuration = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`;
const SOURCE_LABEL: Record<NonNullable<Track["metaSource"]>, string> = {
  catalog: "",
  gemini: "≈ Gemini estimate",
  default: "default values",
};

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
  const [connected, setConnected] = useState(spotifyConnected);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [playlistInput, setPlaylistInput] = useState("");
  const [preview, setPreview] = useState<{ tracks: FoundTrack[]; skipped: number; truncated: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoundTrack[] | null>(null);

  const tracks = state?.tracks ?? [];
  const inLibrary = new Set(tracks.map((t) => t.spotifyUri).filter(Boolean));
  const libraryIdFor = (uri: string) => tracks.find((t) => t.spotifyUri === uri)?.id;
  // Only "playing" if this song is in the library *and* is the current track (both can be undefined).
  const isPlaying = (uri: string) => {
    const id = libraryIdFor(uri);
    return id !== undefined && state?.nowPlaying?.trackId === id;
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
      setResults(await searchSpotifyTracks(query, await spotifyAccessToken()));
    });
  };

  const playNext = (t: FoundTrack) =>
    withBusy(`play:${t.spotifyUri}`, async () => {
      let id = libraryIdFor(t.spotifyUri);
      if (!id) id = (await add([t])).trackIds[0];
      if (!id) throw new Error("Couldn't add that song");
      const res = await hostPlayTrack(sessionCode, await getHeaders(), id);
      onState(res.state);
      setMsg({ kind: "accepted", text: `Playing “${t.title}” next.` });
    });

  const remove = (t: Track) =>
    withBusy(`remove:${t.id}`, async () => {
      await hostRemoveFromLibrary(sessionCode, await getHeaders(), t.id);
      setMsg({ kind: "accepted", text: `Removed “${t.title}”.` });
    });

  const problem = redirectProblem();
  const needsReconnect = connected && spotifyMissingScopes();
  const canUseSpotify = ready && connected && !needsReconnect;

  return (
    <div className="host-block library-card">
      <h2>Music library</h2>

      {!config?.spotifyClientId ? (
        <p className="host-sub">
          Add <code>SPOTIFY_CLIENT_ID</code> to the server&apos;s env to import songs from Spotify.
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
          <span className="host-sub">{ready ? "Uses your Spotify account to read playlists and search." : "Sign in as host first."}</span>
        </div>
      ) : (
        <div className="host-auth">
          <span className="host-user">✓ Spotify connected</span>
          <button
            type="button"
            className="btn ghost compact"
            onClick={() => {
              disconnectSpotify();
              setConnected(false);
            }}
          >
            Disconnect
          </button>
        </div>
      )}

      <form className="library-form" onSubmit={onImport}>
        <label className="host-field">
          <span className="metric-label">Import a playlist you own or collaborate on</span>
          <span className="library-row">
            <input
              type="text"
              value={playlistInput}
              onChange={(e) => setPlaylistInput(e.target.value)}
              placeholder="https://open.spotify.com/playlist/…"
              disabled={!canUseSpotify}
            />
            <button type="submit" className="btn" disabled={!canUseSpotify || !playlistInput.trim() || busy !== null}>
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

      <form className="library-form" onSubmit={onSearch}>
        <label className="host-field">
          <span className="metric-label">Search Spotify</span>
          <span className="library-row">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Song or artist"
              disabled={!canUseSpotify}
            />
            <button type="submit" className="btn" disabled={!canUseSpotify || !query.trim() || busy !== null}>
              {busy === "search" ? "Searching…" : "Search"}
            </button>
          </span>
        </label>
      </form>
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
                    {t.artist} · {fmtDuration(t.durationMs)}
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
                  onClick={() => void playNext(t)}
                  aria-label={`Play ${t.title} next`}
                >
                  {busy === `play:${t.spotifyUri}` ? "…" : "Play next"}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div role="status" aria-live="polite">
        {msg && <p className={`feedback feedback-${msg.kind}`}>{msg.text}</p>}
      </div>

      <details className="library-list">
        <summary>
          {tracks.length} song{tracks.length === 1 ? "" : "s"} in the library
        </summary>
        <ul className="panel">
          {tracks.map((t) => (
            <li key={t.id}>
              <span className="library-meta">
                <strong>{t.title}</strong>
                <em>
                  {t.artist} · {t.genre} · {t.bpm} BPM · energy {t.energy.toFixed(2)}
                  {t.metaSource && SOURCE_LABEL[t.metaSource] && <span className={`meta-${t.metaSource}`}> · {SOURCE_LABEL[t.metaSource]}</span>}
                </em>
              </span>
              <button
                type="button"
                className="btn ghost compact"
                disabled={!ready || busy !== null || t.status === "playing" || tracks.length <= 2}
                onClick={() => void remove(t)}
                aria-label={`Remove ${t.title} from the library`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
