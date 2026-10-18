import { useEffect, useRef, useState } from "react";
import {
  addSessionTrack,
  searchSpotifyTracks,
  type SpotifySearchHit,
} from "../lib/spotify/search";
import { usePublicConfig } from "../lib/publicConfig";
import { spotifyConnected, startSpotifyLogin } from "../lib/spotify/auth";

interface Props {
  sessionId: string;
  participantId?: string;
  /** Host-only: play the song immediately after adding it. */
  onPlayNow?: (trackId: string) => Promise<void>;
  /** After a song is added; `vote` is true when the button promised a vote ("Add & vote"). */
  onAdded?: (trackId: string, vote: boolean) => void;
  /** Attendee can vote right now (votes left, active tab). When false the button is just "Add". */
  canVote?: boolean;
  /** When true, show Connect Spotify for client-side search fallback. */
  allowClientLogin?: boolean;
  compact?: boolean;
}

export function SpotifySearch({
  sessionId,
  participantId,
  onPlayNow,
  onAdded,
  canVote = true,
  allowClientLogin = false,
  compact = false,
}: Props) {
  const cfg = usePublicConfig();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SpotifySearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const debounce = useRef<number | null>(null);
  // Only the newest search may update the results (an older, slower one is ignored).
  const searchSeq = useRef(0);
  const connected = typeof window !== "undefined" && spotifyConnected();

  useEffect(() => {
    if (debounce.current) window.clearTimeout(debounce.current);
    const q = query.trim();
    if (q.length < 2) {
      searchSeq.current++;
      setBusy(false);
      setHits([]);
      setError(null);
      setHint(null);
      return;
    }
    debounce.current = window.setTimeout(() => {
      void runSearch(q);
    }, 350);
    return () => {
      if (debounce.current) window.clearTimeout(debounce.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- search when query settles
  }, [query]);

  async function runSearch(q: string) {
    const seq = ++searchSeq.current;
    setBusy(true);
    setError(null);
    setHint(null);
    try {
      const { tracks, source } = await searchSpotifyTracks(q);
      if (seq !== searchSeq.current) return;
      setHits(tracks);
      if (!tracks.length) setHint("No matches — try another spelling.");
      else if (source === "client") setHint("Searching with your Spotify account.");
    } catch (err) {
      if (seq !== searchSeq.current) return;
      setHits([]);
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      if (seq === searchSeq.current) setBusy(false);
    }
  }

  // Host mode (Play now) never votes; attendees vote only when they can.
  const votes = !onPlayNow && canVote;

  async function add(hit: SpotifySearchHit, play: boolean) {
    const vote = votes && !play;
    setAdding(hit.id);
    setError(null);
    try {
      const { trackId } = await addSessionTrack(sessionId, hit, participantId);
      onAdded?.(trackId, vote);
      if (play && onPlayNow) await onPlayNow(trackId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add song");
    } finally {
      setAdding(null);
    }
  }

  if (!cfg) return null;
  if (!cfg.spotifyClientId) {
    return (
      <p className="privacy-note">
        Spotify isn&apos;t set up on this server yet — set <code>SPOTIFY_CLIENT_ID</code> to search real songs.
      </p>
    );
  }

  const canSearch = cfg.spotifySearch || (allowClientLogin && connected);

  return (
    <div className={`spotify-search ${compact ? "compact" : ""}`}>
      <label className="host-field">
        <span className="metric-label">Search Spotify</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Song or artist…"
          autoComplete="off"
          enterKeyHint="search"
          disabled={!canSearch && !allowClientLogin}
        />
      </label>

      {!cfg.spotifySearch && allowClientLogin && !connected && (
        <p className="privacy-note">
          Server search needs <code>SPOTIFY_CLIENT_SECRET</code>.{" "}
          <button
            type="button"
            className="btn ghost compact"
            onClick={() => {
              if (!cfg.spotifyClientId) return;
              void startSpotifyLogin(cfg.spotifyClientId, window.location.pathname + window.location.search);
            }}
          >
            Connect Spotify to search here
          </button>
        </p>
      )}

      {!cfg.spotifySearch && !allowClientLogin && (
        <p className="privacy-note">
          Song search for phones needs <code>SPOTIFY_CLIENT_SECRET</code> on the server. Until then, the host can
          add songs from the host page.
        </p>
      )}

      {busy && (
        <p className="feedback feedback-pending" role="status">
          Searching…
        </p>
      )}
      {hint && !error && (
        <p className="privacy-note" role="status">
          {hint}
        </p>
      )}
      {error && (
        <p className="feedback feedback-rejected" role="alert">
          {error}
        </p>
      )}

      {hits.length > 0 && (
        <ul className="spotify-results panel">
          {hits.map((hit) => (
            <li key={hit.id} className="spotify-result">
              {hit.imageUrl ? (
                <img src={hit.imageUrl} alt="" width={40} height={40} className="spotify-art" />
              ) : (
                <span className="spotify-art placeholder" aria-hidden />
              )}
              <div className="spotify-result-text">
                <p className="track-title">{hit.title}</p>
                <p className="track-meta">
                  {hit.artist}
                  {hit.album ? ` · ${hit.album}` : ""}
                </p>
              </div>
              <div className="spotify-result-actions">
                <button
                  type="button"
                  className="btn primary compact"
                  disabled={adding === hit.id}
                  onClick={() => void add(hit, false)}
                >
                  {adding === hit.id ? "…" : votes ? "Add & vote" : "Add"}
                </button>
                {onPlayNow && (
                  <button
                    type="button"
                    className="btn ghost compact"
                    disabled={adding === hit.id}
                    onClick={() => void add(hit, true)}
                  >
                    Play
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
