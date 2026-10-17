import { useCallback, useEffect, useState } from "react";
import {
  COMMON_GENRES,
  HOST_TARGETS,
  SONG_REQUEST_LIMITS,
  STREAM_STOPS,
  type HostTarget,
  type FoundSong,
  type SongRequest,
  type Recommendation,
  type SessionState,
  type Track,
} from "@crowdpulse/shared";
import {
  decideRecommendation,
  fetchRecommendations,
  hostAddToLibrary,
  hostFindSongs,
  hostPlayTrack,
  requestRecommendation,
  type AiSnapshot,
} from "../lib/host";

const TARGET_LABELS: Record<HostTarget, string> = {
  raise_energy: "Raise energy",
  hold_steady: "Hold steady",
  cool_down: "Cool down",
};

const STATUS_LABELS: Record<Recommendation["status"], string> = {
  pending: "Awaiting your decision",
  approved: "Approved",
  rejected: "Rejected",
  invalid: "Rejected by server validator",
  failed: "AI unavailable",
};

const POLL_MS = 5000;

export function AiPanel({
  sessionId,
  getHeaders,
  ready,
  tracks,
  onState,
}: {
  sessionId: string;
  getHeaders: () => Promise<Record<string, string>>;
  /** Host is signed in (or has a dev key). */
  ready: boolean;
  tracks: Track[];
  onState: (state: SessionState) => void;
}) {
  const [snapshot, setSnapshot] = useState<AiSnapshot | null>(null);
  const [target, setTarget] = useState<HostTarget>("raise_energy");
  // What the host asks for: free text plus sliders (energy/tempo can be "any").
  const [prompt, setPrompt] = useState("");
  const [genre, setGenre] = useState<string | null>(null);
  // Popularity range as indexes into STREAM_STOPS (the ends mean no limit).
  const [minIdx, setMinIdx] = useState(0);
  const [maxIdx, setMaxIdx] = useState(STREAM_STOPS.length - 1);
  const [busy, setBusy] = useState<"ask" | "decide" | "find" | "surprise" | `song:${string}` | null>(null);
  const filters = {
    genre,
    minStreams: minIdx === 0 ? null : STREAM_STOPS[minIdx],
    maxStreams: maxIdx === STREAM_STOPS.length - 1 ? null : STREAM_STOPS[maxIdx],
  };
  const genreOptions = [...new Set([...tracks.map((t) => t.genre.toLowerCase()).filter((g) => g && g !== "unknown" && g !== "spotify"), ...COMMON_GENRES])].sort();
  const [found, setFound] = useState<{ songs: FoundSong[]; note: string | null } | null>(null);
  const [foundMsg, setFoundMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!ready) return;
    try {
      setSnapshot(await fetchRecommendations(sessionId, await getHeaders()));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load recommendations");
    }
  }, [sessionId, ready, getHeaders]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  async function ask() {
    setBusy("ask");
    setError(null);
    try {
      const request: SongRequest = { prompt: prompt.trim(), ...filters };
      const res = await requestRecommendation(sessionId, await getHeaders(), target, request);
      setSnapshot((s) => ({
        ai: res.ai,
        recommendations: [res.recommendation, ...(s?.recommendations ?? []).filter((r) => r.id !== res.recommendation.id)],
      }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  /** Lyrics or a description → Gemini names the song(s) → Spotify matches the host can add or play. */
  async function find(surprise: boolean) {
    setBusy(surprise ? "surprise" : "find");
    setError(null);
    setFoundMsg(null);
    try {
      setFound(await hostFindSongs(sessionId, await getHeaders(), surprise ? { surprise: true, ...filters } : { text: prompt.trim(), ...filters }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  async function useSong(song: FoundSong, play: boolean) {
    const hit = song.spotify;
    if (!hit) return;
    setBusy(`song:${hit.spotifyUri}`);
    setError(null);
    try {
      const headers = await getHeaders();
      const existing = tracks.find((t) => t.spotifyUri === hit.spotifyUri)?.id;
      const id =
        existing ??
        (
          await hostAddToLibrary(sessionId, headers, [
            { title: hit.title, artist: hit.artist, spotifyUri: hit.spotifyUri, ...(hit.coverUrl ? { imageUrl: hit.coverUrl } : {}) },
          ])
        ).trackIds[0];
      if (!id) throw new Error("Couldn't add that song");
      if (play) onState((await hostPlayTrack(sessionId, headers, id)).state);
      setFoundMsg(play ? `Playing “${hit.title}” now.` : `Added “${hit.title}” to the library.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  async function decide(id: string, decision: "approve" | "reject") {
    setBusy("decide");
    setError(null);
    try {
      const res = await decideRecommendation(sessionId, await getHeaders(), id, decision);
      if (res.state) onState(res.state);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  const title = (id: string | null) => (id ? tracks.find((t) => t.id === id)?.title ?? id : "—");
  const latest = snapshot?.recommendations[0] ?? null;
  const ai = snapshot?.ai;

  return (
    <div className="host-block ai-card">
      <div className="analytics-head">
        <h2>Gemini AI DJ</h2>
        <span className="analytics-meta">
          {!ready
            ? "Sign in as host to use AI"
            : !ai
              ? "Loading…"
              : ai.configured
                ? `${ai.model}${ai.lastError ? " · last call failed" : ""}`
                : "Not configured"}
        </span>
      </div>

      {ai && !ai.configured && (
        <p className="ai-status">Unavailable — set GEMINI_API_KEY on the server. Voting and stage controls still work.</p>
      )}
      {ai?.lastError && ai.configured && <p className="feedback feedback-rejected">{ai.lastError}</p>}
      {error && (
        <p className="feedback feedback-rejected" role="alert">
          {error}
        </p>
      )}

      <fieldset className="mood-field compact-field">
        <legend>Host target</legend>
        <div className="target-row">
          {HOST_TARGETS.map((t) => (
            <button
              key={t}
              type="button"
              className={`mood-chip ${target === t ? "selected" : ""}`}
              aria-pressed={target === t}
              onClick={() => setTarget(t)}
            >
              <span className="mood-label">{TARGET_LABELS[t]}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <label className="host-field">
        <span className="metric-label">Ask for a kind of song, or type lyrics (optional)</span>
        <textarea
          className="ai-prompt"
          rows={2}
          maxLength={SONG_REQUEST_LIMITS.promptMax}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. an upbeat 2000s pop-punk singalong — or “is this the real life, is this just fantasy”"
        />
      </label>

      <label className="host-field">
        <span className="metric-label">Genre (optional)</span>
        <select className="ai-genre" value={genre ?? ""} onChange={(e) => setGenre(e.target.value || null)}>
          <option value="">Any genre</option>
          {genreOptions.map((g) => (
            <option key={g} value={g}>
              {g.replace(/\b\w/g, (c) => c.toUpperCase())}
            </option>
          ))}
        </select>
      </label>

      <PopularityRange min={minIdx} max={maxIdx} onChange={(lo, hi) => (setMinIdx(lo), setMaxIdx(hi))} />

      <div className="cta-row ai-actions">
        <button type="button" className="btn primary" disabled={!ready || !ai?.configured || busy !== null} onClick={ask}>
          {busy === "ask" ? "Asking Gemini…" : "Get recommendation"}
        </button>
        <button
          type="button"
          className="btn compact"
          disabled={!ready || !ai?.configured || busy !== null || prompt.trim().length < 2}
          onClick={() => void find(false)}
          title="Recognizes songs from lyrics or a description, even if they're not in the library"
        >
          {busy === "find" ? "Looking it up…" : "🔎 Find on Spotify"}
        </button>
        <button
          type="button"
          className="btn compact"
          disabled={!ready || !ai?.configured || busy !== null}
          onClick={() => void find(true)}
          title="A random song in this genre and popularity range (popular songs come up more often)"
        >
          {busy === "surprise" ? "Picking…" : "🎲 Surprise me"}
        </button>
      </div>
      <p className="host-sub ai-help">
        <strong>Get recommendation</strong> picks from your library · <strong>Find</strong> recognizes lyrics or a description ·{" "}
        <strong>Surprise me</strong> finds a random song, favoring popular ones. Stream counts are Gemini&apos;s estimates.
      </p>
      {found && (
        <div className="panel ai-found" aria-live="polite">
          {found.note && <p className="host-sub">{found.note}</p>}
          <ul className="library-results">
            {found.songs.map((song) => {
              const hit = song.spotify;
              const inLibrary = !!hit && tracks.some((t) => t.spotifyUri === hit.spotifyUri);
              return (
                <li key={`${song.title}|${song.artist}`}>
                  {hit?.imageUrl ? <img src={hit.imageUrl} alt="" width={40} height={40} /> : <span className="library-art" aria-hidden />}
                  <span className="library-meta">
                    <strong>{hit?.title ?? song.title}</strong>
                    <em>
                      {hit?.artist ?? song.artist} · {song.why}
                      {song.streams != null && ` · ≈ ${fmtStreams(song.streams)} streams`}
                      {!hit && " · not found on Spotify"}
                    </em>
                  </span>
                  {hit && (
                    <>
                      <button
                        type="button"
                        className="btn compact"
                        disabled={busy !== null || inLibrary}
                        onClick={() => void useSong(song, false)}
                        aria-label={inLibrary ? `${hit.title} is in the library` : `Add ${hit.title} to the library`}
                      >
                        {inLibrary ? "In library" : "Add"}
                      </button>
                      <button
                        type="button"
                        className="btn primary compact"
                        disabled={busy !== null}
                        onClick={() => void useSong(song, true)}
                        aria-label={`Play ${hit.title} now`}
                      >
                        {busy === `song:${hit.spotifyUri}` ? "…" : "Play now"}
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {foundMsg && <p className="feedback feedback-accepted">{foundMsg}</p>}
        </div>
      )}

      {latest && (
        <div className={`rec rec-${latest.status}`} aria-live="polite">
          <p className="rec-status">{STATUS_LABELS[latest.status]}</p>
          {latest.request?.prompt && <p className="rec-asked">You asked: “{latest.request.prompt}”</p>}

          {latest.proposal ? (
            <>
              <p className="rec-reason">“{latest.proposal.reason}”</p>
              <dl className="rec-grid">
                <div>
                  <dt>Next track</dt>
                  <dd>{title(latest.proposal.recommended_track_id)}</dd>
                </div>
                <div>
                  <dt>Stage</dt>
                  <dd>
                    {latest.proposal.visual_theme.replaceAll("_", " ")} @ {Math.round(latest.proposal.intensity * 100)}%
                  </dd>
                </div>
                <div>
                  <dt>Target energy</dt>
                  <dd>{latest.proposal.target_energy}</dd>
                </div>
                <div>
                  <dt>Confidence (model-reported)</dt>
                  <dd>{Math.round(latest.proposal.confidence * 100)}%</dd>
                </div>
              </dl>
            </>
          ) : (
            <ul className="rec-errors">
              {latest.validationErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}

          <p className="rec-baseline">
            Baseline (majority vote): <strong>{title(latest.baseline.trackId)}</strong> — {latest.baseline.reason}
          </p>

          {latest.status === "pending" && (
            <div className="cta-row">
              <button
                type="button"
                className="btn primary"
                disabled={busy !== null}
                onClick={() => decide(latest.id, "approve")}
              >
                Approve &amp; apply
              </button>
              <button
                type="button"
                className="btn ghost"
                disabled={busy !== null}
                onClick={() => decide(latest.id, "reject")}
              >
                Reject
              </button>
            </div>
          )}

          <p className="rec-meta">
            {latest.model}
            {latest.modelVersion && ` (${latest.modelVersion})`}
            {latest.latencyMs != null && ` · ${latest.latencyMs} ms`}
            {latest.responseId && ` · response ${latest.responseId.slice(0, 12)}…`}
            {` · for “${TARGET_LABELS[latest.hostTarget]}”`}
          </p>

          <details className="chart-table">
            <summary>Show what was sent to Gemini</summary>
            <pre className="rec-input">{JSON.stringify(latest.input, null, 2)}</pre>
          </details>
        </div>
      )}

      {snapshot && snapshot.recommendations.length > 1 && (
        <details className="chart-table">
          <summary>History ({snapshot.recommendations.length - 1} earlier)</summary>
          <ul className="rec-history">
            {snapshot.recommendations.slice(1).map((r) => (
              <li key={r.id}>
                <span>{new Date(r.createdAt).toLocaleTimeString()}</span>
                <span>{r.proposal ? title(r.proposal.recommended_track_id) : "—"}</span>
                <span className={`rec-pill rec-${r.status}`}>{r.status}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** 2_500_000_000 → "2.5B", 120_000 → "120K". */
export function fmtStreams(n: number): string {
  const f = (v: number, unit: string) => `${Number(v.toFixed(v < 10 ? 1 : 0))}${unit}`;
  return n >= 1e9 ? f(n / 1e9, "B") : n >= 1e6 ? f(n / 1e6, "M") : n >= 1e3 ? f(n / 1e3, "K") : String(n);
}

/** Popularity: a two-handle range over STREAM_STOPS (all-time Spotify streams, Gemini's estimate). */
function PopularityRange({ min, max, onChange }: { min: number; max: number; onChange: (min: number, max: number) => void }) {
  const last = STREAM_STOPS.length - 1;
  const lo = min === 0 ? "any" : fmtStreams(STREAM_STOPS[min]);
  const hi = max === last ? `${fmtStreams(STREAM_STOPS[last])}+` : fmtStreams(STREAM_STOPS[max]);
  const pct = (i: number) => `${(i / last) * 100}%`;
  return (
    <div className="host-field popularity">
      <span className="metric-label">
        Popularity · {min === 0 && max === last ? "any" : `${lo} – ${hi}`} streams
      </span>
      <div className="range2" style={{ ["--lo" as string]: pct(min), ["--hi" as string]: pct(max) }}>
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={min}
          aria-label="Minimum streams"
          aria-valuetext={min === 0 ? "No minimum" : `${lo} streams`}
          onChange={(e) => onChange(Math.min(Number(e.target.value), max), max)}
        />
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={max}
          aria-label="Maximum streams"
          aria-valuetext={max === last ? "No maximum" : `${hi} streams`}
          onChange={(e) => onChange(min, Math.max(Number(e.target.value), min))}
        />
      </div>
    </div>
  );
}
