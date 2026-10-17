import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionState } from "@crowdpulse/shared";
import { reportPlayback, type PlaybackReport } from "../host";
import { spotifyAccessToken, spotifyConnected } from "../spotify/auth";
import { decide, type Playing } from "./follow";
import { LocalPlayer } from "./localPlayer";
import { SpotifyPlayer } from "./spotifyPlayer";
import type { PlayerAdapter, PlayerUnavailableError, StartedInfo } from "./types";

// Makes this browser tab the session's speaker output: it plays whatever the server says is now
// playing (host pick, Gemini approval, or auto mode) and reports started / progress / ended.
// Nothing plays until the host presses Start audio (browsers require a click before audio).

const PROGRESS_EVERY_MS = 5000;
const SOURCE_KEY = "crowdpulse.player.source";
export type Source = "local" | "spotify";

export type NowInfo = StartedInfo & { trackId: string; title: string; artist: string };

export function usePlayerEngine({
  sessionCode,
  state,
  ready,
  getHeaders,
  generatedDurationS = 60,
}: {
  sessionCode: string;
  state: SessionState | null;
  ready: boolean;
  getHeaders: () => Promise<Record<string, string>>;
  generatedDurationS?: number;
}) {
  const [source, setSource] = useState<Source>(() => {
    try {
      return sessionStorage.getItem(SOURCE_KEY) === "spotify" ? "spotify" : "local";
    } catch {
      return "local";
    }
  });
  // Has this tab's host picked a source yet? If not, the card defaults to Spotify when it's set up.
  const [sourceChosen] = useState(() => {
    try {
      return sessionStorage.getItem(SOURCE_KEY) !== null;
    } catch {
      return false;
    }
  });
  const player: PlayerAdapter = useMemo(
    () =>
      source === "spotify"
        ? new SpotifyPlayer({ getToken: spotifyAccessToken })
        : new LocalPlayer({ generatedDurationS }),
    [source, generatedDurationS],
  );

  const [unlocked, setUnlocked] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [info, setInfo] = useState<NowInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0); // re-render for the progress bar
  const [followSeq, setFollowSeq] = useState(0); // re-run the follower after a play finishes
  const playing = useRef<Playing>(null);
  const seekSeen = useRef(0);
  const busy = useRef(false);

  // Always use the latest sign-in (callbacks registered earlier would otherwise keep stale headers).
  const send = async (report: PlaybackReport) => {
    try {
      await reportPlayback(sessionCode, await getHeaders(), report);
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
    if (!unlocked || !ready || busy.current) return;
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
    seekSeen.current = state!.playback.seekSeq; // startAtMs already includes any earlier seek
    player
      .play(track, { startAtMs: action.startAtMs })
      .then(async (started) => {
        setInfo({ ...started, trackId: track.id, title: track.title, artist: track.artist });
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
        if ((err as Partial<PlayerUnavailableError>).playerUnavailable) {
          // Not this song's fault (Spotify disconnected, no Premium…): stop this device and ask the
          // host to start again, instead of telling the server the song failed (auto mode would skip).
          player.stop();
          setUnlocked(false);
          setError(`${err.message}. Press Start audio to try again.`);
          return;
        }
        setError(`Couldn't play ${track.title}: ${err.message}`);
        await send({ event: "error", trackId: action.trackId, round: action.round, message: err.message });
      })
      .finally(() => {
        busy.current = false;
        setFollowSeq((n) => n + 1); // state may have moved on while this track was loading
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, unlocked, ready, player, followSeq]);

  // The host moved the song position: jump to where the server now says the song is.
  useEffect(() => {
    const pb = state?.playback;
    const p = playing.current;
    if (!unlocked || !pb || !p || busy.current || pb.seekSeq <= seekSeen.current) return;
    if (pb.trackId !== p.trackId || pb.round !== p.round || !pb.startedAt) return;
    seekSeen.current = pb.seekSeq;
    player.seek(Date.now() - Date.parse(pb.startedAt)).catch((err: Error) => setError(`Couldn't move in the song: ${err.message}`));
  }, [state, unlocked, player]);

  // Redraw the progress bar every second (also when another device is the player).
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Heartbeat: keeps the "player online" light green and corrects drift.
  useEffect(() => {
    if (!unlocked) return;
    const t = window.setInterval(() => {
      const p = playing.current;
      if (p && ready && !busy.current) {
        void sendRef.current({ event: "progress", trackId: p.trackId, round: p.round, positionMs: player.positionMs(), durationMs: info?.durationMs, source: info?.source });
      }
    }, PROGRESS_EVERY_MS);
    return () => window.clearInterval(t);
  }, [unlocked, ready, info, player]);

  useEffect(() => {
    // New player (source switched): it needs its own Start audio click, then picks up mid-song.
    setUnlocked(false);
    playing.current = null;
    setInfo(null);
    return () => player.stop();
  }, [player]);

  useEffect(() => player.setVolume(volume), [player, volume, unlocked]);

  const chooseSource = (next: Source) => {
    try {
      sessionStorage.setItem(SOURCE_KEY, next);
    } catch {
      /* storage blocked */
    }
    setError(null);
    setSource(next);
  };

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

  /** Silence this tab (another device can take over as the player). */
  const stopHere = () => {
    player.stop();
    playing.current = null;
    setInfo(null);
    setUnlocked(false);
  };

  return {
    source,
    sourceChosen,
    chooseSource,
    spotifyReady: source === "spotify" && spotifyConnected(),
    unlocked,
    start,
    stopHere,
    volume,
    setVolume,
    info,
    error,
    positionMs: () => player.positionMs(),
  };
}
