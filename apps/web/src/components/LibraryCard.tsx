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
import { SongPicker } from "./SongPicker";
import { useAutoHide } from "../hooks/useAutoHide";

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

export type LibrarySort = "added" | "newest" | "title" | "artist" | "votes" | "genre" | "bpm" | "energy";
const SORT_LABELS: Record<LibrarySort, string> = {
  added: "Order added",
  newest: "Newest first",
  title: "Title A–Z",
  artist: "Artist A–Z",
  votes: "Most votes",
  genre: "Genre",
  bpm: "BPM (fast first)",
  energy: "Energy (high first)",
};

/** The library in the host's chosen order (display only; the library itself doesn't change). */
export function sortLibrary<T extends { title: string; artist: string; genre: string; votes: number; bpm: number; energy: number }>(
  tracks: T[],
  sort: LibrarySort,
): T[] {
  const az = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
  const list = [...tracks];
  switch (sort) {
    case "newest":
      return list.reverse();
    case "title":
      return list.sort((a, b) => az(a.title, b.title));
    case "artist":
      return list.sort((a, b) => az(a.artist, b.artist) || az(a.title, b.title));
    case "votes":
      return list.sort((a, b) => b.votes - a.votes);
    case "genre":
      return list.sort((a, b) => az(a.genre, b.genre) || az(a.title, b.title));
    case "bpm":
      return list.sort((a, b) => b.bpm - a.bpm);
    case "energy":
      return list.sort((a, b) => b.energy - a.energy);
    default:
      return list;
  }
}

export type SearchFields = { title: string; artist: string; album: string };

/**
 * The search box plus optional exact fields → one Spotify query, using its field filters
 * (`track:"…" artist:"…" album:"…"`). Quotes typed by the host are dropped.
 */
export function buildSpotifyQuery(free: string, f: SearchFields): string {
  const clean = (v: string) => v.replace(/"/g, "").trim();
  return [
    clean(free),
    clean(f.title) && `track:"${clean(f.title)}"`,
    clean(f.artist) && `artist:"${clean(f.artist)}"`,
    clean(f.album) && `album:"${clean(f.album)}"`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** For the results header: "daft punk · artist Daft Punk · album Discovery". */
function describeSearch(free: string, f: SearchFields): string {
  return [free.trim(), f.title.trim() && `title ${f.title.trim()}`, f.artist.trim() && `artist ${f.artist.trim()}`, f.album.trim() && `album ${f.album.trim()}`]
    .filter(Boolean)
    .join(" · ");
}

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
  useAutoHide(msg, () => setMsg(null));
  const [playlistInput, setPlaylistInput] = useState("");
  const [preview, setPreview] = useState<{ tracks: FoundTrack[]; skipped: number; truncated: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoundTrack[] | null>(null);
  const [searched, setSearched] = useState("");
  // Optional exact fields (Spotify field filters): title, artist, album.
  const [fields, setFields] = useState<SearchFields>({ title: "", artist: "", album: "" });
  const hasQuery = query.trim().length >= 2 || Object.values(fields).some((v) => v.trim());
  const [sort, setSort] = useState<LibrarySort>("added");

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
      const q = buildSpotifyQuery(query, fields);
      const { tracks: hits } = await searchSpotifyTracks(q);
      setSearched(describeSearch(query, fields));
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

  /** Search result → library (if needed) → end of the host's queue. */
  const queueFound = (t: FoundTrack) =>
    withBusy(`queue:${t.spotifyUri}`, async () => {
      let id = libraryIdFor(t.spotifyUri);
      if (!id) id = (await add([t])).trackIds[0];
      if (!id) throw new Error("Couldn't add that song");
      await setQueue([...hostQueue.filter((q) => q !== id), id], `“${t.title}” is #${hostQueue.length + 1} in the queue.`);
    });

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
            <button type="submit" className="btn" disabled={!canSearch || !hasQuery || busy !== null}>
              {busy === "search" ? "Searching…" : "Search"}
            </button>
          </span>
        </label>
        <details className="search-fields">
          <summary>Search by title, artist or album</summary>
          <div className="search-fields-row">
            {(["title", "artist", "album"] as const).map((f) => (
              <label key={f} className="host-field">
                <span className="metric-label">{f === "title" ? "Title" : f === "artist" ? "Artist" : "Album"}</span>
                <input
                  type="text"
                  value={fields[f]}
                  onChange={(e) => setFields((x) => ({ ...x, [f]: e.target.value }))}
                  placeholder="Optional"
                  disabled={!canSearch}
                />
              </label>
            ))}
          </div>
        </details>
      </form>
      {!ready && <p className="host-sub">Sign in as host to pick songs.</p>}
      {ready && config && !canSearch && (
        <p className="host-sub">Connect Spotify under &ldquo;Import a Spotify playlist&rdquo; to search, or set SPOTIFY_CLIENT_SECRET on the server.</p>
      )}
      {results && (
        <div className="results-head">
          <span className="metric-label">
            {results.length ? `${results.length} result${results.length === 1 ? "" : "s"}` : "No songs found"}
            {searched && ` for “${searched}”`}
          </span>
          <button type="button" className="btn ghost compact" onClick={() => setResults(null)} aria-label="Close search results" title="Close">
            ✕
          </button>
        </div>
      )}
      {results && results.length > 0 && (
        <SongPicker
          label="Spotify search results"
          items={results.map((t) => ({
            key: t.spotifyUri,
            title: t.title,
            artist: t.artist,
            meta: [t.durationMs > 0 ? fmtDuration(t.durationMs) : "", t.explicit ? "explicit" : ""].filter(Boolean).join(" · ") || undefined,
            imageUrl: t.imageUrl,
            unavailable: inLibrary.has(t.spotifyUri) ? "In library" : undefined,
          }))}
          busy={busy !== null}
          onAdd={(keys) =>
            withBusy("add-search", async () => void (await add(results.filter((t) => keys.includes(t.spotifyUri)))))
          }
          rowAction={(item) => {
            const t = results.find((r) => r.spotifyUri === item.key)!;
            const id = libraryIdFor(t.spotifyUri);
            const pos = id ? hostQueue.indexOf(id) : -1;
            return (
              <>
                <button
                  type="button"
                  className="btn compact"
                  disabled={busy !== null || pos >= 0 || isPlaying(t.spotifyUri)}
                  onClick={() => void queueFound(t)}
                  aria-label={pos >= 0 ? `${t.title} is #${pos + 1} in the queue` : `Add ${t.title} to the queue`}
                >
                  {busy === `queue:${t.spotifyUri}` ? "…" : pos >= 0 ? `#${pos + 1}` : "+ Queue"}
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
              </>
            );
          }}
        />
      )}

      <div role="status" aria-live="polite">
        {msg && <p className={`feedback feedback-${msg.kind}`}>{msg.text}</p>}
      </div>

      <div className="library-head">
        <span className="metric-label">
          Library · {tracks.length} song{tracks.length === 1 ? "" : "s"}
        </span>
        <label className="library-sort">
          <span>Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as LibrarySort)} aria-label="Sort the library">
            {(Object.keys(SORT_LABELS) as LibrarySort[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
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
        {sortLibrary(tracks, sort).map((t) => {
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
          <div className="library-preview">
            <p className="host-sub">
              <strong>{preview.tracks.length}</strong> song{preview.tracks.length === 1 ? "" : "s"} in the playlist
              {preview.skipped > 0 && ` · ${preview.skipped} skipped (local files, podcasts, unavailable)`}
              {preview.truncated && " · only the first 100 are shown"} — pick the ones to add.
            </p>
            <SongPicker
              label="Songs in the playlist"
              selectAllInitially
              items={preview.tracks.map((t) => ({
                key: t.spotifyUri,
                title: t.title,
                artist: t.artist,
                meta: t.durationMs > 0 ? fmtDuration(t.durationMs) : undefined,
                imageUrl: t.imageUrl,
                unavailable: inLibrary.has(t.spotifyUri) ? "In library" : undefined,
              }))}
              busy={busy !== null}
              onAdd={(keys) =>
                withBusy("add-playlist", async () => {
                  await add(preview.tracks.filter((t) => keys.includes(t.spotifyUri)));
                  setPreview(null);
                  setPlaylistInput("");
                })
              }
            />
            <button type="button" className="btn ghost compact" onClick={() => setPreview(null)} disabled={busy !== null}>
              Cancel
            </button>
          </div>
        )}
      </details>
    </div>
  );
}
