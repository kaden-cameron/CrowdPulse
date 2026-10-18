import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import QRCode from "qrcode";
import { MenuBar } from "../components/MenuBar";
import { StageCanvas } from "../components/StageCanvas";
import { Window } from "../components/Window";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { useSessionAppearance } from "../lib/theme";
import { useSpotifyCover } from "../lib/spotify/cover";

export function StagePage() {
  const { sessionCode = "demo" } = useParams();
  const { state, status, lastMessageAt } = useSessionSocket(sessionCode, "stage");
  useSessionAppearance(sessionCode, state?.appearance);
  const joinBase = useJoinBase();
  const joinUrl = `${joinBase.origin}/join/${encodeURIComponent(sessionCode)}`;
  const [qr, setQr] = useState<string | null>(null);
  const live = status === "connected";

  useEffect(() => {
    // Scannable from the back of a room: the standard 4-module quiet zone, pure black on white,
    // generated large so it stays crisp when the projector scales it.
    QRCode.toDataURL(joinUrl, {
      margin: 4,
      width: 640,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then(setQr)
      .catch(() => setQr(null));
  }, [joinUrl]);

  const visual = state?.visualState ?? {
    theme: "electric_blue" as const,
    intensity: 0.35,
  };

  const playingTrack = state?.nowPlaying ? state.tracks.find((t) => t.id === state.nowPlaying!.trackId) : undefined;
  const cover = useSpotifyCover(playingTrack?.spotifyUri ?? state?.nowPlaying?.spotifyUri, playingTrack?.imageUrl ?? state?.nowPlaying?.imageUrl);
  // The host turned crowd energy off: show the calm layout without the visuals.
  const minimal = state?.appearance.showEnergy === false;

  return (
    <main className="stage-page desktop" data-theme={visual.theme}>
      <MenuBar title={state?.sessionName ?? "Stage"} status={status} lastMessageAt={lastMessageAt} />

      <div className={`stage-desktop${minimal ? " minimal" : ""}`}>
        {minimal ? (
          // Energy hidden by the host: a quiet screen — just the song (over the stage visuals), the
          // QR code and the queue.
          <Window title="Now playing" className="stage-tv stage-quiet" headingLevel={1}>
            <div className="tv-screen">
              <StageCanvas visual={visual} paused={!live} />
              <div className="tv-dither" aria-hidden />
              <section className="stage-song" aria-label="Now playing">
                <div className="stage-song-cover">{cover ? <img src={cover} alt="" /> : <span aria-hidden>♪</span>}</div>
                <div className="stage-song-meta">
                  <p className="on-air">
                    <strong>NOW PLAYING</strong>{" "}
                    <span className="on-air-dot" aria-hidden>
                      ●
                    </span>
                  </p>
                  <h1 className="stage-song-title">{state?.nowPlaying?.title ?? "Waiting for the first pick"}</h1>
                  {state?.nowPlaying && <p className="stage-song-artist">{state.nowPlaying.artist}</p>}
                  <SongProgress state={state} />
                </div>
              </section>
            </div>
          </Window>
        ) : (
          <Window title="CrowdPulse TV" className="stage-tv" headingLevel={1}>
            <div className="tv-screen">
              <StageCanvas visual={visual} paused={!live} />
              <div className="tv-dither" aria-hidden />
              <div className="tv-overlay">
                <span className="tv-tag">{visual.theme.replaceAll("_", " ")}</span>
                <div className="energy-block" aria-label={`Crowd energy ${state?.energyScore ?? 0}`}>
                  <div className="energy-score">{state?.energyScore ?? 0}</div>
                  <div className="energy-bar-track">
                    <div className="energy-bar-fill" style={{ width: `${state?.energyScore ?? 0}%` }} />
                  </div>
                  <p className="energy-caption">crowd energy</p>
                </div>
              </div>
              <div className="tv-strip" aria-hidden>
                <span>▶ live</span>
                <span>{Math.round(visual.intensity * 100)}% intensity</span>
              </div>
            </div>
            <div className="panel now-playing">
              <p className="on-air">
                CrowdPulse: <strong>ON AIR</strong>{" "}
                <span className="on-air-dot" aria-hidden>
                  ●
                </span>
              </p>
              <div className="stage-now">
                {cover && <img className="stage-cover" src={cover} alt="" width={72} height={72} />}
                <p className="now-playing-title">
                  {state?.nowPlaying ? `${state.nowPlaying.artist} – ${state.nowPlaying.title}` : "Waiting for the first pick"}
                </p>
              </div>
              <SongProgress state={state} />
              <p className="latest-event" aria-live="polite">
                {state?.latestEvent?.message ?? "Session warming up"}
              </p>
            </div>
          </Window>
        )}

        <div className="stage-col">
          <Window title="Join the party" className="join-window">
            <div className="join-qr">
              {qr && (
                <div className="join-qr-code">
                  <img src={qr} alt={`QR code to join at ${joinUrl}`} />
                </div>
              )}
              <p className="join-qr-hint">
                <span className="scan-cta">
                  <span aria-hidden className="scan-arrow">
                    ←
                  </span>{" "}
                  Scan to vote!
                </span>
                <span className="scan-sub">Pick the next song from your phone</span>

                <strong>{joinUrl.replace(/^https?:\/\//, "")}</strong>
                <span>{state?.participants ?? 0} in the crowd</span>
                {joinBase.warning && <span className="join-qr-warning">{joinBase.warning}</span>}
              </p>
            </div>
            {!!state?.simulatedParticipants && (
              <p className="demo-data-badge" role="note">
                Demo data · {state.simulatedParticipants} simulated attendees
              </p>
            )}
          </Window>

          <Window title="Up next" className="stage-queue" bodyClassName="panel">
            <ol>
              {(state?.queue ?? []).slice(0, STAGE_QUEUE_SIZE).map((item, i) => (
                <li key={`${item.trackId}-${i}`}>
                  <span className="q-rank">{i + 1}</span>
                  <span>
                    <strong>{item.title}</strong>
                    <em>
                      {item.artist} · {item.votes}
                      {item.boosts > 0 && ` · ⚡${item.boosts}`}
                    </em>
                  </span>
                </li>
              ))}
              {/* Nothing queued: what auto play would pick next on its own. */}
              {!state?.queue.length &&
                (state?.autoNext ?? []).slice(0, STAGE_QUEUE_SIZE).map((item, i) => (
                  <li key={item.trackId} className="queue-auto">
                    <span className="q-rank">{i + 1}</span>
                    <span>
                      <strong>{item.title}</strong>
                      <em>{item.artist}</em>
                    </span>
                    <span className="auto-tag">auto</span>
                  </li>
                ))}
              {!state?.queue.length && !state?.autoNext?.length && <li className="empty-queue">Votes will fill the queue</li>}
            </ol>
            {(state?.queue.length ?? 0) > STAGE_QUEUE_SIZE && (
              <p className="queue-more">+{state!.queue.length - STAGE_QUEUE_SIZE} more in the queue</p>
            )}
          </Window>
        </div>
      </div>

      {!live && status !== "connecting" && (
        <div className="stage-stale" role="alert">
          {status === "not_found" ? "Session not found" : "Disconnected — live data paused"}
        </div>
      )}
    </main>
  );
}

/** The projector shows just the next few songs, so the QR code and song stay the focus. */
export const STAGE_QUEUE_SIZE = 4;

/** m:ss */
export const fmtClock = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};

/**
 * Progress of the current song with a timer (elapsed / length), from the player's reports. Always
 * shown: empty at 0:00 / 0:00 when nothing is playing, so the screen doesn't jump around.
 */
function SongProgress({ state }: { state: import("@crowdpulse/shared").SessionState | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const pb = state?.playback;
  const dur = pb?.durationMs ?? 0;
  const elapsed =
    !pb || !dur
      ? 0
      : pb.status === "paused"
        ? (pb.pausedPositionMs ?? 0)
        : pb.status === "playing" && pb.startedAt
          ? now - Date.parse(pb.startedAt)
          : 0;
  // Highlights mode: the bar and timer cover just the clip being played.
  const clip = pb && pb.clipStartMs != null && pb.clipEndMs != null && pb.clipEndMs > pb.clipStartMs ? { start: pb.clipStartMs, end: pb.clipEndMs } : null;
  const full = dur ? Math.min(Math.max(0, elapsed), dur) : 0;
  const length = clip ? clip.end - clip.start : dur;
  const pos = clip ? Math.min(Math.max(0, full - clip.start), length) : full;
  return (
    <div className="stage-progress">
      <div className="song-progress" aria-hidden>
        <div style={{ width: `${length ? (pos / length) * 100 : 0}%` }} />
      </div>
      <span className="stage-timer" aria-label={length ? `${fmtClock(pos)} of ${fmtClock(length)}${clip ? " (highlight)" : ""}` : "Nothing playing"}>
        {fmtClock(pos)} / {fmtClock(length)}
        {clip && <em> · highlight</em>}
        {pb?.status === "paused" && <em> · paused</em>}
      </span>
    </div>
  );
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * The origin the QR code should send phones to. A stage opened at localhost would encode a URL
 * that only works on this laptop, so prefer the server's PUBLIC_URL, then (in development) this
 * machine's LAN IP on the same port, and only then the address the stage was opened at.
 */
function useJoinBase(): { origin: string; warning: string | null } {
  const here = window.location;
  const isLocal = LOCAL_HOSTS.has(here.hostname);
  const [base, setBase] = useState<{ origin: string; warning: string | null }>({
    origin: here.origin,
    warning: isLocal ? "Opened at localhost — phones can't use this link." : null,
  });
  useEffect(() => {
    fetch("/api/public-config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg: { publicUrl: string | null; lanIp: string | null } | null) => {
        if (cfg?.publicUrl) setBase({ origin: cfg.publicUrl, warning: null });
        else if (isLocal && cfg?.lanIp) {
          setBase({ origin: `${here.protocol}//${cfg.lanIp}${here.port ? `:${here.port}` : ""}`, warning: null });
        }
      })
      .catch(() => {});
  }, [isLocal, here.origin, here.protocol, here.port]);
  return base;
}
