import { useEffect, useState } from "react";
import type { PlaybackMode, SessionState } from "@crowdpulse/shared";
import { hostPlaybackMode, hostSeek, hostSkip } from "../lib/host";
import { usePlayerEngine } from "../lib/player/usePlayerEngine";
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
  const [drag, setDrag] = useState<number | null>(null); // slider position while the host drags it
  const spotifyConnected = useSpotifyConnected();

  const pb = state?.playback;
  const np = state?.nowPlaying;
  const track = np ? state?.tracks.find((t) => t.id === np.trackId) : undefined;
  const here = engine.info && engine.info.trackId === np?.trackId ? engine.info : null;
  // A real Spotify song playing as a generated stand-in: tell the host how to hear the real thing.
  const standIn = here?.source === "generated" && !!track?.spotifyUri;

  // Spotify set up on this server → play real songs by default (until the host picks a source).
  const spotifyId = config?.spotifyClientId;
  useEffect(() => {
    if (spotifyId && !engine.sourceChosen && engine.source === "local" && !engine.unlocked) engine.chooseSource("spotify");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotifyId]);

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
  const skip = () => run("Skipped to the next song", async () => hostSkip(sessionCode, await getHeaders()));
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
            {pb?.mode === "auto" ? "Auto play" : "DJ picks"}
            {playedBy && ` · ${playedBy}`}
          </p>
          <p className="player-title">{np ? np.title : "Nothing playing"}</p>
          <p className="host-sub">
            {np ? `${np.artist} · ${STATUS_TEXT[pb?.status ?? "idle"]}` : "Pick a song, or switch on auto play."}
          </p>
          {dur > 0 && (
            <div className="player-progress">
              <input
                type="range"
                className="seek-slider"
                min={0}
                max={Math.round(dur)}
                step={1000}
                value={Math.round(drag ?? pos)}
                disabled={!canSeek}
                aria-label="Song position"
                aria-valuetext={`${fmt(drag ?? pos)} of ${fmt(dur)}`}
                style={{ ["--fill" as string]: `${((drag ?? pos) / Math.max(1, dur)) * 100}%` }}
                onChange={(e) => setDrag(Number(e.target.value))}
                onPointerUp={commitSeek}
                onKeyUp={commitSeek}
                onBlur={commitSeek}
              />
              <span>
                {fmt(drag ?? pos)} / {fmt(dur)}
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
        <button type="button" className="btn primary" disabled={busy || !ready || (state?.tracks.length ?? 0) < 1} onClick={() => void skip()}>
          Skip ⏭
        </button>
        <span className="host-sub">Plays your queue first, then the top votes.</span>
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
            connected={spotifyConnected}
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
        {standIn && (
          <p className="feedback feedback-warn" role="status">
            This is a generated 1-minute stand-in, not the real song. Choose <strong>Spotify</strong> above,
            connect a Premium account and press Start audio to hear real songs.
          </p>
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
