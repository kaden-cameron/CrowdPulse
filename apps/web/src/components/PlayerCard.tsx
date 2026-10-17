import { useState } from "react";
import type { PlaybackMode, SessionState } from "@crowdpulse/shared";
import { hostAdvance, hostPlaybackMode } from "../lib/host";
import { usePlayerEngine } from "../lib/player/usePlayerEngine";
import { usePublicConfig } from "../lib/publicConfig";
import { useSpotifyCover } from "../lib/spotify/cover";
import { disconnectSpotify, redirectProblem, spotifyConnected, startSpotifyLogin } from "../lib/spotify/auth";

// Host-page window: what's playing (album cover, progress), auto / DJ mode, play next, and this
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
  error: "Couldn't play",
};
const SOURCE_TEXT = { file: "audio file", generated: "generated demo track", spotify: "Spotify" } as const;

export function PlayerCard({
  sessionCode,
  state,
  ready,
  getHeaders,
  onState,
  generatedDurationS,
}: {
  sessionCode: string;
  state: SessionState | null;
  ready: boolean;
  getHeaders: () => Promise<Record<string, string>>;
  onState: (s: SessionState) => void;
  generatedDurationS?: number;
}) {
  const config = usePublicConfig();
  const engine = usePlayerEngine({ sessionCode, state, ready, getHeaders, generatedDurationS });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "accepted" | "rejected"; text: string } | null>(null);

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
  } else if (pb?.status === "playing" && pb.startedAt && pb.durationMs) {
    dur = pb.durationMs;
    pos = Math.min(Date.now() - Date.parse(pb.startedAt), dur);
  }
  const cover = useSpotifyCover(track?.spotifyUri, here?.imageUrl ?? track?.imageUrl);
  const playedBy = here ? SOURCE_TEXT[here.source] : pb?.source && pb.status === "playing" ? SOURCE_TEXT[pb.source as keyof typeof SOURCE_TEXT] : null;

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
    run(m === "auto" ? "Auto play on" : "DJ picks on", async () => hostPlaybackMode(sessionCode, await getHeaders(), m));
  const playNext = () => run("Playing the top-voted track", async () => hostAdvance(sessionCode, await getHeaders()));

  return (
    <div className="host-block player-card">
      <div className="analytics-head">
        <h2>Now playing</h2>
        <span className={`player-light ${pb?.playerOnline ? "on" : "off"}`}>
          {engine.unlocked ? "● This tab is the player" : pb?.playerOnline ? "● Player online" : "○ No player"}
        </span>
      </div>

      <div className="now-playing">
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
            {pb?.mode === "auto" ? "Auto play" : "DJ picks"}
            {playedBy && ` · ${playedBy}`}
          </p>
          <p className="player-title">{np ? np.title : "Nothing playing"}</p>
          <p className="host-sub">
            {np ? `${np.artist} · ${STATUS_TEXT[pb?.status ?? "idle"]}` : "Pick a song, or switch on auto play."}
          </p>
          {dur > 0 && (
            <div className="player-progress" aria-label="Song progress">
              <div className="quest-bar">
                <div style={{ width: `${(pos / Math.max(1, dur)) * 100}%` }} />
              </div>
              <span>
                {fmt(pos)} / {fmt(dur)}
              </span>
            </div>
          )}
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
            <span className="mood-label">{m === "auto" ? "Auto play" : "DJ picks"}</span>
            <span className="mood-hint">{m === "auto" ? "Next song starts when one ends" : "Host starts every song"}</span>
          </button>
        ))}
      </div>
      <div className="cta-row">
        <button type="button" className="btn primary" disabled={busy || !ready} onClick={() => void playNext()}>
          Play next ▶
        </button>
      </div>
      <div role="status" aria-live="polite">
        {msg && <p className={`feedback feedback-${msg.kind}`}>{msg.text}</p>}
      </div>

      <fieldset className="mood-field compact-field speakers">
        <legend>Speakers · play the music from this tab</legend>
        <div className="target-row two">
          {(["local", "spotify"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={`mood-chip ${engine.source === s ? "selected" : ""}`}
              aria-pressed={engine.source === s}
              onClick={() => engine.chooseSource(s)}
            >
              <span className="mood-label">{s === "local" ? "This laptop" : "Spotify"}</span>
              <span className="mood-hint">
                {s === "local" ? "Audio files or generated demo tracks" : "Real songs · needs Spotify Premium"}
              </span>
            </button>
          ))}
        </div>

        {engine.source === "spotify" && (
          <SpotifySetup
            clientId={config?.spotifyClientId ?? null}
            loading={!config}
            connected={spotifyConnected()}
            returnTo={window.location.pathname + window.location.search}
            onDisconnect={() => {
              disconnectSpotify();
              engine.chooseSource("spotify");
              engine.stopHere();
            }}
          />
        )}

        {!engine.unlocked ? (
          <>
            <button
              type="button"
              className="btn primary wide player-start"
              disabled={!ready || (engine.source === "spotify" && !engine.spotifyReady)}
              onClick={() => void engine.start()}
            >
              {!ready
                ? "Sign in as host first"
                : engine.source === "spotify" && !engine.spotifyReady
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
