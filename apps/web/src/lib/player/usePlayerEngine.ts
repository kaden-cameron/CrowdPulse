import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionState } from "@crowdpulse/shared";
import { fetchHighlight, reportPlayback, type PlaybackReport } from "../host";
import { spotifyAccessToken, spotifyConnected } from "../spotify/auth";
import { decide, playableTrack, type Playing } from "./follow";
import { clipWindow } from "@crowdpulse/shared";
import { HybridPlayer } from "./hybridPlayer";
import { LocalPlayer } from "./localPlayer";
import { SpotifyPlayer } from "./spotifyPlayer";
import { PlaybackCancelledError, type PlayerUnavailableError, type StartedInfo } from "./types";

// Makes this browser tab the session's speaker output: it plays whatever the server says is now
// playing (host pick, Gemini approval, or auto mode) and reports started / progress / ended.
// Nothing plays until the host presses Start audio (browsers require a click before audio).

const PROGRESS_EVERY_MS = 5000;
/** Highlights mode fades (when the host picks "fade"): out at the end of a clip, in at the start. */
const FADE_OUT_MS = 2_000;
const FADE_IN_MS = 1_200;

export type NowInfo = StartedInfo & { trackId: string; title: string; artist: string };

export function usePlayerEngine({
  sessionCode,
  state,
  ready,
  getHeaders,
}: {
  sessionCode: string;
  state: SessionState | null;
  ready: boolean;
  getHeaders: () => Promise<Record<string, string>>;
}) {
  // Speaker output: Spotify songs through Spotify (this tab becomes a Spotify Connect device), local
  // files from this laptop.
  const local = useMemo(() => new LocalPlayer(), []);
  const player = useMemo(() => new HybridPlayer(new SpotifyPlayer({ getToken: spotifyAccessToken }), local, spotifyConnected), [local]);

  const [unlocked, setUnlocked] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [info, setInfo] = useState<NowInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0); // re-render for the progress bar
  const [followSeq, setFollowSeq] = useState(0); // re-run the follower after a play finishes
  const playing = useRef<Playing>(null);
  // The song + round this tab last finished: not restarted while the server catches up.
  const ended = useRef<Playing>(null);
  // Bumped when this tab stops (Stop audio here, another speaker took over, unmount): a song still
  // loading then gives up quietly instead of starting sound and telling the server "started".
  const loadGen = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Highlights mode: the part of the current song to play (ms), and whether to fade at the ends.
  const clip = useRef<{ start: number; end: number; fade: boolean; trackId: string } | null>(null);
  // Fade level (0–1) multiplied into the host's volume, for clip fade out / in.
  const fadeLevel = useRef(1);
  const fadeTimer = useRef<number | undefined>(undefined);
  // One speaker at a time: this tab's id, and the player the server named when we last looked.
  const playerId = useRef(`pl_${Math.random().toString(36).slice(2, 12)}`);
  const knownOwner = useRef<string | null>(null);
  const seekSeen = useRef(0);
  const held = useRef(false); // this tab paused its song because the host pressed ⏸
  const busy = useRef(false);
  // Always use the latest sign-in (callbacks registered earlier would otherwise keep stale headers).
  const send = async (report: PlaybackReport) => {
    try {
      await reportPlayback(sessionCode, await getHeaders(), { ...report, playerId: playerId.current });
    } catch (err) {
      setError(`Couldn't reach the server: ${(err as Error).message}`);
    }
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  // Song stopped early by itself (it never really played): report it as a failed song so the host
  // sees why. Auto mode moves on, and pauses after 3 failures in a row.
  useEffect(() => {
    player.onProblem?.((message) => {
      const p = playing.current;
      playing.current = null;
      ended.current = p;
      setInfo(null);
      setError(message);
      if (p) void sendRef.current({ event: "error", trackId: p.trackId, round: p.round, message });
    });
  }, [player]);

  // Song finished on its own → tell the server (it starts the next one in auto mode).
  useEffect(() => {
    player.onEnded(() => {
      const p = playing.current;
      playing.current = null;
      ended.current = p;
      setInfo(null);
      if (p) void sendRef.current({ event: "ended", trackId: p.trackId, round: p.round });
    });
  }, [player]);

  // Follow the server: start, stop or re-announce whenever state changes.
  useEffect(() => {
    if (!unlocked || !ready || busy.current) return;
    const action = decide(state, playing.current, Date.now(), ended.current);
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
    const track = playableTrack(state!, action.trackId);
    if (!track) return;
    busy.current = true;
    const gen = ++loadGen.current;
    // After each wait: if this tab stopped meanwhile, silence whatever started and give up quietly.
    const live = () => {
      if (gen === loadGen.current) return;
      player.stop();
      throw new PlaybackCancelledError();
    };
    playing.current = { trackId: action.trackId, round: action.round };
    ended.current = null;
    held.current = false;
    seekSeen.current = state!.playback.seekSeq; // startAtMs already includes any earlier seek
    const hl = state!.playback.highlights;
    // Picking up mid-song (reload) in highlights mode: keep the clip the server already knows.
    const resumeClip =
      action.startAtMs > 0 && state!.playback.clipStartMs != null && state!.playback.clipEndMs != null
        ? { start: state!.playback.clipStartMs, end: state!.playback.clipEndMs }
        : null;
    clip.current = null;
    (async () => {
      // Highlights mode, fresh song: start at its best bit (asked from the server; saved per song).
      const highlight =
        hl.enabled && action.startAtMs === 0
          ? await fetchHighlight(sessionCode, await getHeaders(), track.id, hl.part).catch(() => ({ startMs: null, endMs: null, source: "default" as const }))
          : null;
      live();
      // Fade-in clips start silent; everything else at full volume (even right after a fade-out).
      fadeTo(hl.enabled && hl.transition === "fade" ? 0 : 1, 0);
      const started = await player.play(track, { startAtMs: highlight?.startMs ?? action.startAtMs });
      live();
      let win = resumeClip;
      if (highlight) {
        win = clipWindow(highlight, started.durationMs, hl.clipSec);
        // Unknown start or one that had to move (past the end): jump to where the clip really starts.
        if (win.start !== (highlight.startMs ?? -1)) await player.seek(win.start).catch(() => {});
        live();
      }
      // The host pressed ⏸ while it was loading: end up paused (the hold effect waits for loads).
      const pb = stateRef.current?.playback;
      if (pb && pb.status === "paused" && pb.trackId === action.trackId && pb.round === action.round) {
        held.current = true;
        await player.hold().catch((err: Error) => setError(`Couldn't pause: ${err.message}`));
        live();
      }
      clip.current = win ? { ...win, fade: hl.transition === "fade", trackId: track.id } : null;
      if (hl.enabled && hl.transition === "fade") fadeTo(1, FADE_IN_MS);
      setInfo({ ...started, trackId: track.id, title: track.title, artist: track.artist });
      setError(started.note ?? null);
      await send({
        event: "started",
        trackId: action.trackId,
        round: action.round,
        positionMs: win && highlight ? win.start : action.startAtMs,
        durationMs: started.durationMs,
        source: started.source,
        ...(win ? { clipStartMs: win.start, clipEndMs: win.end } : {}),
      });
      live();
      // Warm up the next song's highlight so the switch is quick.
      const next = state!.queue[0]?.trackId;
      if (hl.enabled && next) void fetchHighlight(sessionCode, await getHeaders(), next, hl.part).catch(() => {});
    })()
      .catch(async (err: Error) => {
        // Stopped or replaced while loading: nobody's fault, nothing to report.
        if (gen !== loadGen.current) return;
        playing.current = null;
        if ((err as Partial<PlaybackCancelledError>).cancelled) return;
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

  // Another tab or device pressed Start audio and took over as the speaker: stop here, so the two
  // don't fight over the Spotify account (each pausing the other = a second of sound, then quiet).
  useEffect(() => {
    const owner = state?.playback.playerId ?? null;
    const changed = owner !== knownOwner.current;
    knownOwner.current = owner;
    if (!unlocked || !changed || !owner || owner === playerId.current) return;
    loadGen.current++;
    player.stop();
    playing.current = null;
    setInfo(null);
    setUnlocked(false);
    setError("Another tab or device is now the speaker, so this one stopped. Press Start audio here to take it back.");
  }, [state, unlocked, player]);

  // ⏸ / ▶ from the host: hold the song here, or carry on.
  useEffect(() => {
    const pb = state?.playback;
    const p = playing.current;
    // While loading, the load itself checks for ⏸ at the end (holding now would hit the old song).
    if (!unlocked || !pb || !p || busy.current || pb.trackId !== p.trackId || pb.round !== p.round) return;
    if (pb.status === "paused" && !held.current) {
      held.current = true;
      player.hold().catch((err: Error) => setError(`Couldn't pause: ${err.message}`));
    } else if (pb.status === "playing" && held.current) {
      held.current = false;
      fadeTo(1, 0); // a clip fade-out cut short by ⏸ starts over
      player.unhold().catch((err: Error) => setError(`Couldn't resume: ${err.message}`));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, unlocked, player, followSeq]);

  // The host moved the song position: jump to where the server now says the song is.
  useEffect(() => {
    const pb = state?.playback;
    const p = playing.current;
    if (!unlocked || !pb || !p || busy.current || pb.seekSeq <= seekSeen.current) return;
    if (pb.trackId !== p.trackId || pb.round !== p.round || !pb.startedAt) return;
    seekSeen.current = pb.seekSeq;
    const target = Date.now() - Date.parse(pb.startedAt);
    // Highlights mode: the clip moves with the host (same length, starting where they moved to).
    const c = clip.current;
    if (c && c.trackId === p.trackId) clip.current = { ...c, start: target, end: target + (c.end - c.start) };
    fadeTo(1, 0); // a clip fade-out in progress starts over from the new position
    player.seek(target).catch((err: Error) => setError(`Couldn't move in the song: ${err.message}`));
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
      if (p && ready && !busy.current && !held.current) {
        const c = clip.current && clip.current.trackId === p.trackId ? clip.current : null;
        void sendRef.current({
          event: "progress",
          trackId: p.trackId,
          round: p.round,
          positionMs: player.positionMs(),
          durationMs: info?.durationMs,
          source: info?.source,
          ...(c ? { clipStartMs: Math.round(c.start), clipEndMs: Math.round(c.end) } : {}),
        });
      }
    }, PROGRESS_EVERY_MS);
    return () => window.clearInterval(t);
  }, [unlocked, ready, info, player]);

  useEffect(() => {
    // Unmount: stop the music this tab was playing.
    setUnlocked(false);
    playing.current = null;
    setInfo(null);
    return () => {
      loadGen.current++;
      window.clearInterval(fadeTimer.current);
      player.stop();
      player.dispose();
    };
  }, [player]);

  useEffect(() => player.setVolume(volume * fadeLevel.current), [player, volume, unlocked]);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  /** Ramp the fade level to `target` over `ms` (volume × level), for clip transitions. */
  function fadeTo(target: number, ms: number) {
    window.clearInterval(fadeTimer.current);
    if (ms <= 0) {
      fadeLevel.current = target;
      player.setVolume(volumeRef.current * target);
      return;
    }
    const from = fadeLevel.current;
    const t0 = Date.now();
    fadeTimer.current = window.setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / ms);
      fadeLevel.current = from + (target - from) * k;
      player.setVolume(volumeRef.current * fadeLevel.current);
      if (k >= 1) window.clearInterval(fadeTimer.current);
    }, 80);
  }

  // Highlights mode: end the clip on time (fading out first if chosen), then tell the server the song
  // is done — it moves on exactly as if the song had finished.
  useEffect(() => {
    if (!unlocked) return;
    const t = window.setInterval(() => {
      const c = clip.current;
      const p = playing.current;
      if (!c || !p || p.trackId !== c.trackId || held.current || busy.current) return;
      const pos = player.positionMs();
      if (c.fade && pos >= c.end - FADE_OUT_MS && fadeLevel.current === 1) fadeTo(0, FADE_OUT_MS);
      if (pos >= c.end) {
        clip.current = null;
        player.stop();
        playing.current = null;
        ended.current = p;
        setInfo(null);
        void sendRef.current({ event: "ended", trackId: p.trackId, round: p.round });
        if (!c.fade) fadeTo(1, 0);
      }
    }, 200);
    return () => window.clearInterval(t);
  }, [unlocked, player]);

  const start = async () => {
    // Taking over from whoever is the player now isn't a "change" to react to.
    knownOwner.current = state?.playback.playerId ?? null;
    ended.current = null;
    try {
      await player.unlock();
      player.setVolume(volume);
      setUnlocked(true);
      setError(player.spotifyProblem ? `Spotify couldn't start here (${player.spotifyProblem}) — local files still play.` : null);
    } catch (err) {
      setError(`Audio couldn't start: ${(err as Error).message}`);
    }
  };

  /** Silence this tab (another device can take over as the player). */
  const stopHere = () => {
    loadGen.current++;
    player.stop();
    playing.current = null;
    setInfo(null);
    setUnlocked(false);
  };

  return {
    spotifyReady: spotifyConnected(),
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
