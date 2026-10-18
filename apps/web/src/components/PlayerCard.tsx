import { useState } from "react";
import { HIGHLIGHT_CLIP_SECONDS, type HighlightPart, type HighlightSettings, type PlaybackMode, type SessionState } from "@crowdpulse/shared";
import {
  hostPause,
  hostPlaybackMode,
  hostPrevious,
  hostResume,
  hostSaveHighlight,
  hostSeek,
  hostSetHighlights,
  hostSetRepeat,
  hostSkip,
} from "../lib/host";
import { usePlayerEngine } from "../lib/player/usePlayerEngine";
import { RepeatIcon } from "./Icons";
import { useAutoHide } from "../hooks/useAutoHide";
import { usePublicConfig } from "../lib/publicConfig";
import { useSpotifyCover } from "../lib/spotify/cover";
import { disconnectSpotify, redirectProblem, startSpotifyLogin, useSpotifyConnected } from "../lib/spotify/auth";

// Host-page window: what's playing (album cover, draggable position), auto / DJ mode, skip, and this
// tab as the speaker output. The cover and progress show even when another device is the player.

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const STATUS_TEXT: Record<string, string> = {
  idle: "Nothing chosen yet",
  loading: "Starting…",
  playing: "Playing",
  ended: "Finished — pick the next song",
  paused: "Paused",
  error: "Couldn't play",
};
const SOURCE_TEXT: Record<string, string> = { spotify: "Spotify" };

export function PlayerCard({
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
  const engine = usePlayerEngine({ sessionCode, state, ready, getHeaders });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "accepted" | "rejected"; text: string } | null>(null);
  useAutoHide(msg, () => setMsg(null));
  const [drag, setDrag] = useState<number | null>(null); // slider position while the host drags it
  const spotifyConnected = useSpotifyConnected();

  const pb = state?.playback;
  const np = state?.nowPlaying;
  const track = np ? state?.tracks.find((t) => t.id === np.trackId) : undefined;
  const here = engine.info && engine.info.trackId === np?.trackId ? engine.info : null;
  // Progress: from this tab's player when it's the one playing, else from the server's timing.
  let pos = 0;
  let dur = 0;
  if (here) {
    dur = here.durationMs;
    pos = Math.min(engine.positionMs(), dur);
  } else if (pb?.status === "paused" && pb.durationMs) {
    dur = pb.durationMs;
    pos = Math.min(pb.pausedPositionMs ?? 0, dur);
  } else if (pb?.status === "playing" && pb.startedAt && pb.durationMs) {
    dur = pb.durationMs;
    pos = Math.min(Date.now() - Date.parse(pb.startedAt), dur);
  }
  const cover = useSpotifyCover(track?.spotifyUri, here?.imageUrl ?? track?.imageUrl);
  const playedBy = here ? SOURCE_TEXT[here.source] : pb?.source && pb.status === "playing" ? SOURCE_TEXT[pb.source] ?? pb.source : null;

  async function run(label: string, action: () => Promise<{ state: SessionState }>) {
    setBusy(true);
    setMsg(null);
    try {
      onState((await action()).state);
      setMsg({ kind: "accepted", text: label });
    } catch (err) {
      setMsg({ kind: "rejected", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const setMode = (m: PlaybackMode) =>
    run(m === "auto" ? "Auto play on" : "Host picks on", async () => hostPlaybackMode(sessionCode, await getHeaders(), m));
  const skip = () => run("Skipped to the next song", async () => hostSkip(sessionCode, await getHeaders()));
  const hl = pb?.highlights;
  const setHighlights = (next: HighlightSettings) =>
    run(next.enabled ? `Highlights mode: ~${next.clipSec}s ${next.part === "auto" ? "best moments" : next.part === "chorus" ? "choruses" : "drops"}` : "Highlights mode off", async () =>
      hostSetHighlights(sessionCode, await getHeaders(), next),
    );
  /** Move this song's highlight start by ±10 s, save it for next time, and jump there. */
  const nudge = (by: number) =>
    run(by < 0 ? "Highlight starts 10s earlier (saved)" : "Highlight starts 10s later (saved)", async () => {
      if (!np || !hl || pb?.clipStartMs == null) throw new Error("No highlight playing");
      const to = Math.max(0, pb.clipStartMs + by);
      const headers = await getHeaders();
      // The whole section shifts: same length, starting earlier / later.
      const end = pb.clipEndMs != null ? pb.clipEndMs + (to - pb.clipStartMs) : undefined;
      await hostSaveHighlight(sessionCode, headers, np.trackId, hl.part, to, end);
      return hostSeek(sessionCode, headers, to);
    });
  const back = () => run("Went back", async () => hostPrevious(sessionCode, await getHeaders()));
  const paused = pb?.status === "paused";
  const togglePause = () =>
    paused
      ? run("Playing again", async () => hostResume(sessionCode, await getHeaders()))
      : run("Paused", async () => hostPause(sessionCode, await getHeaders()));
  const commitSeek = () => {
    if (drag === null) return;
    const to = drag;
    setDrag(null);
    void run(`Moved to ${fmt(to)}`, async () => hostSeek(sessionCode, await getHeaders(), to));
  };
  const canSeek = ready && !busy && pb?.status === "playing" && dur > 0;

  return (
    <div className="host-block player-card">
      <div className="analytics-head">
        <h2>Now playing</h2>
        <span className={`player-light ${pb?.playerOnline ? "on" : "off"}`}>
          {engine.unlocked ? "● This tab is the player" : pb?.playerOnline ? "● Player online" : "○ No player"}
        </span>
      </div>

      <div className="np-layout">
        <div className="cover" aria-hidden={!cover}>
          {cover ? (
            <img src={cover} alt={np ? `Album cover for ${np.title}` : ""} width={300} height={300} />
          ) : (
            <span className="cover-blank" aria-hidden>
              ♪
            </span>
          )}
        </div>
        <div className="now-meta">
          <p className="metric-label">
            {pb?.mode === "auto" ? "Auto play" : "Host picks"}
            {playedBy && ` · ${playedBy}`}
          </p>
          <p className="player-title">{np ? np.title : "Nothing playing"}</p>
          <p className="host-sub">
            {np ? `${np.artist} · ${STATUS_TEXT[pb?.status ?? "idle"]}` : "Pick a song, or switch on auto play."}
          </p>
          {/* Always shown (empty when nothing's playing) so the window doesn't jump around. */}
          <div className="player-progress with-transport">
            <input
              type="range"
              className="seek-slider"
              min={0}
              max={Math.max(1, Math.round(dur))}
              step={1000}
              value={Math.round(drag ?? pos)}
              disabled={!canSeek}
              aria-label="Song position"
              aria-valuetext={dur > 0 ? `${fmt(drag ?? pos)} of ${fmt(dur)}` : "Nothing playing"}
              style={{ ["--fill" as string]: `${dur > 0 ? ((drag ?? pos) / dur) * 100 : 0}%` }}
              onChange={(e) => setDrag(Number(e.target.value))}
              onPointerUp={commitSeek}
              onKeyUp={commitSeek}
              onBlur={commitSeek}
            />
            <span>
              {fmt(drag ?? pos)} / {fmt(dur)}
            </span>
            {/* Second row of the same grid: ⏮ ⏸ ⏭ centered under the bar, 🔁 Repeat under the timer. */}
            <div className="transport-main">
              <button
                type="button"
                className="btn"
                disabled={busy || !ready || !np}
                onClick={() => void back()}
                aria-label="Previous: restart this song, or go back to the one before"
                title="Restart this song (or, in the first 5 seconds, go back to the one before)"
              >
                ⏮
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy || !ready || !np || (!paused && pb?.status !== "playing" && pb?.status !== "loading")}
                onClick={() => void togglePause()}
                aria-label={paused ? "Resume" : "Pause"}
                title={paused ? "Resume" : "Pause"}
              >
                {paused ? "▶" : "⏸"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy || !ready || (state?.tracks.length ?? 0) < 1}
                onClick={() => void skip()}
                aria-label="Skip to the next song"
                title="Skip: plays your queue first, then the top votes"
              >
                ⏭
              </button>
            </div>
            <button
              type="button"
              className={`btn transport-repeat${pb?.repeat ? " primary" : ""}`}
              disabled={busy || !ready}
              aria-pressed={!!pb?.repeat}
              onClick={() =>
                void run(pb?.repeat ? "Repeat off" : "Repeat on", async () => hostSetRepeat(sessionCode, await getHeaders(), !pb?.repeat))
              }
              aria-label="Repeat the song when it finishes"
              title={pb?.repeat ? "Repeat is on: the song replays when it finishes" : "Repeat: replay the song when it finishes"}
            >
              <RepeatIcon />
            </button>
          </div>
        </div>
      </div>
      {pb?.status === "error" && pb.message && <p className="feedback feedback-rejected">{pb.message}</p>}

      <div className="target-row two">
        {(["auto", "dj"] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={`mood-chip ${pb?.mode === m ? "selected" : ""}`}
            aria-pressed={pb?.mode === m}
            disabled={busy || !ready}
            onClick={() => void setMode(m)}
          >
            <span className="mood-label">{m === "auto" ? "Auto play" : "Host picks"}</span>
            <span className="mood-hint">{m === "auto" ? "Next song starts when one ends" : "Host starts every song"}</span>
          </button>
        ))}
      </div>

      {/* Highlights mode: each song plays only its best section. */}
      <div className="highlights-row">
        <label className="highlights-toggle">
          <input
            type="checkbox"
            checked={!!hl?.enabled}
            disabled={busy || !ready || !hl}
            onChange={(e) => hl && void setHighlights({ ...hl, enabled: e.target.checked })}
          />
          Highlights mode
        </label>
        {hl?.enabled ? (
          <span className="highlights-options">
            <select
              value={hl.clipSec}
              disabled={busy || !ready}
              aria-label="Clip length"
              onChange={(e) => void setHighlights({ ...hl, clipSec: Number(e.target.value) as HighlightSettings["clipSec"] })}
            >
              {HIGHLIGHT_CLIP_SECONDS.map((n) => (
                <option key={n} value={n}>
                  ~{n}s clips
                </option>
              ))}
            </select>
            <select
              value={hl.part}
              disabled={busy || !ready}
              aria-label="Which part of each song"
              onChange={(e) => void setHighlights({ ...hl, part: e.target.value as HighlightPart })}
            >
              <option value="auto">Best moment</option>
              <option value="chorus">Chorus</option>
              <option value="drop">Drop</option>
            </select>
            <select
              value={hl.transition}
              disabled={busy || !ready}
              aria-label="Transition between clips"
              onChange={(e) => void setHighlights({ ...hl, transition: e.target.value as HighlightSettings["transition"] })}
            >
              <option value="fade">Fade</option>
              <option value="cut">Cut</option>
            </select>
          </span>
        ) : (
          <span className="host-sub">Play only each song&apos;s best bit.</span>
        )}
      </div>
      {hl?.enabled && np && pb?.clipStartMs != null && pb.clipEndMs != null && (
        <div className="clip-row">
          <span>
            Highlight {fmt(pb.clipStartMs)}–{fmt(pb.clipEndMs)}
          </span>
          <span className="clip-nudge">
            <button type="button" className="btn ghost compact" disabled={busy || !ready} onClick={() => void nudge(-10_000)} aria-label="Start the highlight 10 seconds earlier">
              −10s
            </button>
            <button type="button" className="btn ghost compact" disabled={busy || !ready} onClick={() => void nudge(10_000)} aria-label="Start the highlight 10 seconds later">
              +10s
            </button>
          </span>
        </div>
      )}
      <div role="status" aria-live="polite">
        {msg && <p className={`feedback feedback-${msg.kind}`}>{msg.text}</p>}
      </div>

      <fieldset className="mood-field compact-field speakers">
        <legend>Speakers · play the music from this tab through Spotify</legend>
        <SpotifySetup
          clientId={config?.spotifyClientId ?? null}
          loading={!config}
          connected={spotifyConnected}
          returnTo={window.location.pathname + window.location.search}
          onDisconnect={() => {
            disconnectSpotify();
            engine.stopHere();
          }}
        />

        {!engine.unlocked ? (
          <>
            <button
              type="button"
              className="btn primary wide player-start"
              disabled={!ready || !engine.spotifyReady}
              onClick={() => void engine.start()}
            >
              {!ready
                ? "Sign in as host first"
                : !engine.spotifyReady
                  ? "Connect Spotify first"
                  : "▶ Start audio on this device"}
            </button>
            {pb?.playerOnline && (
              <p className="host-sub">Another device is already the player — only start audio here if it should take over.</p>
            )}
          </>
        ) : (
          <div className="speaker-row">
            <label className="host-field">
              <span className="metric-label">Volume {Math.round(engine.volume * 100)}%</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={engine.volume}
                onChange={(e) => engine.setVolume(Number(e.target.value))}
              />
            </label>
            <button type="button" className="btn ghost compact" onClick={engine.stopHere}>
              Stop audio here
            </button>
          </div>
        )}
        {engine.error && (
          <p className="feedback feedback-warn" role="status">
            {engine.error}
          </p>
        )}
      </fieldset>
    </div>
  );
}

function SpotifySetup({
  clientId,
  loading,
  connected,
  returnTo,
  onDisconnect,
}: {
  clientId: string | null;
  loading: boolean;
  connected: boolean;
  returnTo: string;
  onDisconnect: () => void;
}) {
  if (loading) return <p className="host-sub">Loading Spotify settings…</p>;
  if (!clientId) {
    return (
      <p className="feedback feedback-warn">
        Spotify isn&apos;t set up on this server. Add <code>SPOTIFY_CLIENT_ID</code> to the server&apos;s env file
        and restart (see docs/10_MUSIC_PLAYBACK.md).
      </p>
    );
  }
  const problem = redirectProblem();
  if (problem) return <p className="feedback feedback-warn">{problem}</p>;
  return connected ? (
    <div className="host-auth">
      <span className="host-user">✓ Spotify connected. Spotify lists this tab as the &ldquo;CrowdPulse&rdquo; device.</span>
      <button type="button" className="btn ghost compact" onClick={onDisconnect}>
        Disconnect
      </button>
    </div>
  ) : (
    <button type="button" className="btn ghost wide" onClick={() => void startSpotifyLogin(clientId, returnTo)}>
      Connect Spotify (Premium account)
    </button>
  );
}
