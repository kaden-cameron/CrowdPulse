import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { useHostAccess } from "../components/HostAccess";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { reportPlayback, type PlaybackReport } from "../lib/host";
import { decide, type Playing } from "../lib/player/follow";
import { LocalPlayer } from "../lib/player/localPlayer";
import { SpotifyPlayer } from "../lib/player/spotifyPlayer";
import type { PlayerAdapter, StartedInfo } from "../lib/player/types";
import { usePublicConfig } from "../lib/publicConfig";
import {
  disconnectSpotify,
  redirectProblem,
  spotifyAccessToken,
  spotifyConnected,
  startSpotifyLogin,
} from "../lib/spotify/auth";
import { HostSignIn } from "./HostPage";

// Open this on the laptop connected to the speakers. It plays whatever the server says is now
// playing (host pick, Gemini approval, or auto mode) and reports started / progress / ended.

const PROGRESS_EVERY_MS = 5000;
const SOURCE_KEY = "crowdpulse.player.source";
type Source = "local" | "spotify";

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function PlayerPage() {
  const { sessionCode = "demo" } = useParams();
  const [params] = useSearchParams();
  // ?demoSeconds=N shortens generated tracks (rehearsals and tests). Default 60s.
  const generatedDurationS = Math.max(3, Math.min(600, Number(params.get("demoSeconds")) || 60));
  const access = useHostAccess();
  const { state, status, lastMessageAt } = useSessionSocket(sessionCode, "stage");
  const config = usePublicConfig();
  const [source, setSource] = useState<Source>(() => {
    try {
      return sessionStorage.getItem(SOURCE_KEY) === "spotify" ? "spotify" : "local";
    } catch {
      return "local";
    }
  });
  const spotifyReady = source === "spotify" && spotifyConnected();
  const player: PlayerAdapter = useMemo(
    () =>
      source === "spotify"
        ? new SpotifyPlayer({ getToken: spotifyAccessToken })
        : new LocalPlayer({ generatedDurationS }),
    [source, generatedDurationS],
  );

  const [unlocked, setUnlocked] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [info, setInfo] = useState<(StartedInfo & { title: string; artist: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0); // re-render for the progress bar
  const [followSeq, setFollowSeq] = useState(0); // re-run the follower after a play finishes
  const playing = useRef<Playing>(null);
  const busy = useRef(false);

  // Always use the latest sign-in (callbacks registered earlier would otherwise keep stale headers).
  const send = async (report: PlaybackReport) => {
    try {
      await reportPlayback(sessionCode, await access.getHeaders(), report);
    } catch (err) {
      setError(`Couldn't reach the server: ${(err as Error).message}`);
    }
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  // Song finished on its own → tell the server (it starts the next one in auto mode).
  useEffect(() => {
    player.onEnded(() => {
      const p = playing.current;
      playing.current = null;
      setInfo(null);
      if (p) void sendRef.current({ event: "ended", trackId: p.trackId, round: p.round });
    });
  }, [player]);

  // Follow the server: start, stop or re-announce whenever state changes.
  useEffect(() => {
    if (!unlocked || !access.ready || busy.current) return;
    const action = decide(state, playing.current);
    if (action.type === "none") return;
    if (action.type === "stop") {
      player.stop();
      playing.current = null;
      setInfo(null);
      return;
    }
    if (action.type === "reannounce") {
      const p = playing.current!;
      void send({ event: "started", trackId: p.trackId, round: p.round, positionMs: player.positionMs(), durationMs: info?.durationMs, source: info?.source });
      return;
    }
    const track = state!.tracks.find((t) => t.id === action.trackId);
    if (!track) return;
    busy.current = true;
    playing.current = { trackId: action.trackId, round: action.round };
    player
      .play(track, { startAtMs: action.startAtMs })
      .then(async (started) => {
        setInfo({ ...started, title: track.title, artist: track.artist });
        setError(started.note ?? null);
        await send({
          event: "started",
          trackId: action.trackId,
          round: action.round,
          positionMs: action.startAtMs,
          durationMs: started.durationMs,
          source: started.source,
        });
      })
      .catch(async (err: Error) => {
        playing.current = null;
        setError(`Couldn't play ${track.title}: ${err.message}`);
        await send({ event: "error", trackId: action.trackId, round: action.round, message: err.message });
      })
      .finally(() => {
        busy.current = false;
        setFollowSeq((n) => n + 1); // state may have moved on while this track was loading
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, unlocked, access.ready, player, followSeq]);

  // Redraw the progress bar every second.
  useEffect(() => {
    if (!unlocked) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [unlocked]);

  // Heartbeat: keeps the host page's "player online" light green and corrects drift.
  useEffect(() => {
    if (!unlocked) return;
    const t = window.setInterval(() => {
      const p = playing.current;
      if (p && access.ready && !busy.current) {
        void sendRef.current({ event: "progress", trackId: p.trackId, round: p.round, positionMs: player.positionMs(), durationMs: info?.durationMs, source: info?.source });
      }
    }, PROGRESS_EVERY_MS);
    return () => window.clearInterval(t);
  }, [unlocked, access.ready, info, player]);

  useEffect(() => {
    // New player (source switched): it needs its own Start audio click, then picks up mid-song.
    setUnlocked(false);
    playing.current = null;
    setInfo(null);
    return () => player.stop();
  }, [player]);

  const chooseSource = (next: Source) => {
    try {
      sessionStorage.setItem(SOURCE_KEY, next);
    } catch {
      /* storage blocked */
    }
    setError(null);
    setSource(next);
  };
  useEffect(() => player.setVolume(volume), [player, volume, unlocked]);

  const start = async () => {
    try {
      await player.unlock();
      player.setVolume(volume);
      setUnlocked(true);
      setError(null);
    } catch (err) {
      setError(`Audio couldn't start: ${(err as Error).message}`);
    }
  };

  const pos = info ? Math.min(player.positionMs(), info.durationMs) : 0;
  const pb = state?.playback;

  return (
    <main className="host-page">
      <header className="page-top">
        <Link to="/" className="brand-inline">
          CrowdPulse
        </Link>
        <ConnectionBadge status={status} lastMessageAt={lastMessageAt} />
      </header>
      <section className="host-grid">
        <div className="host-block">
          <h1>Player · {state?.sessionName ?? sessionCode}</h1>
          <p className="host-sub">
            Open this on the laptop connected to the speakers. It plays what CrowdPulse picks: the
            host&apos;s choice, an approved Gemini pick, or the next song in auto mode.
          </p>
          <HostSignIn />
        </div>

        <div className="host-block player-block">
          <fieldset className="mood-field compact-field">
            <legend>Play music from</legend>
            <div className="target-row two">
              {(["local", "spotify"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`mood-chip ${source === s ? "selected" : ""}`}
                  aria-pressed={source === s}
                  onClick={() => chooseSource(s)}
                >
                  <span className="mood-label">{s === "local" ? "This laptop" : "Spotify"}</span>
                  <span className="mood-hint">
                    {s === "local" ? "Audio files or generated demo tracks" : "Real songs · needs Spotify Premium"}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>

          {source === "spotify" && (
            <SpotifySetup
              clientId={config?.spotifyClientId ?? null}
              loading={!config}
              connected={spotifyConnected()}
              returnTo={window.location.pathname + window.location.search}
              onDisconnect={() => {
                disconnectSpotify();
                chooseSource("spotify");
                setUnlocked(false);
              }}
            />
          )}

          {!unlocked ? (
            <button
              type="button"
              className="btn primary wide player-start"
              disabled={!access.ready || (source === "spotify" && !spotifyReady)}
              onClick={start}
            >
              {!access.ready
                ? "Sign in as host first"
                : source === "spotify" && !spotifyReady
                  ? "Connect Spotify first"
                  : "▶ Start audio on this device"}
            </button>
          ) : (
            <>
              <p className="metric-label">
                {pb?.mode === "auto" ? "Auto play" : "DJ picks"} ·{" "}
                {info ? ({ file: "audio file", generated: "generated demo track", spotify: "Spotify" } as const)[info.source] : "waiting"}
              </p>
              <p className="player-title">{info ? info.title : pb?.status === "ended" ? "Song finished" : "Nothing playing"}</p>
              <p className="host-sub">
                {info
                  ? info.artist
                  : pb?.status === "ended"
                    ? "DJ picks mode — waiting for the host to choose the next song."
                    : "Waiting for the host to pick a song (or switch on auto play)."}
              </p>
              {info && (
                <div className="player-progress" aria-label="Song progress">
                  <div className="quest-bar">
                    <div style={{ width: `${(pos / Math.max(1, info.durationMs)) * 100}%` }} />
                  </div>
                  <span>
                    {fmt(pos)} / {fmt(info.durationMs)}
                  </span>
                </div>
              )}
              <label className="host-field">
                <span className="metric-label">Volume {Math.round(volume * 100)}%</span>
                <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
              </label>
            </>
          )}
          {error && (
            <p className="feedback feedback-warn" role="status">
              {error}
            </p>
          )}
        </div>
      </section>
    </main>
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
      <span className="host-user">✓ Spotify connected. Spotify will list this tab as the &ldquo;CrowdPulse&rdquo; device.</span>
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
