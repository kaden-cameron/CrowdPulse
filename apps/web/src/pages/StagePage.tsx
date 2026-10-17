import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import QRCode from "qrcode";
import { MenuBar } from "../components/MenuBar";
import { StageCanvas } from "../components/StageCanvas";
import { Window } from "../components/Window";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { useSessionAppearance } from "../lib/theme";

export function StagePage() {
  const { sessionCode = "demo" } = useParams();
  const { state, status, lastMessageAt } = useSessionSocket(
    sessionCode,
    "stage",
  );
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

  const questPct = state
    ? Math.round((state.crowdQuest.progress / state.crowdQuest.goal) * 100)
    : 0;

  return (
    <main className="stage-page desktop" data-theme={visual.theme}>
      <MenuBar title={state?.sessionName ?? "Stage"} status={status} lastMessageAt={lastMessageAt} />

      <div className="stage-desktop">
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
              CrowdPulse: <strong>ON AIR</strong> <span className="on-air-dot" aria-hidden>●</span>
            </p>
            <p className="now-playing-title">
              {state?.nowPlaying ? `${state.nowPlaying.artist} – ${state.nowPlaying.title}` : "Waiting for the first pick"}
            </p>
            <SongProgress state={state} />
            <p className="latest-event" aria-live="polite">
              {state?.latestEvent?.message ?? "Session warming up"}
            </p>
          </div>
        </Window>

        <div className="stage-col">
          <Window title="Join the party" className="join-window">
            <div className="join-qr">
              {qr && (
                <div className="join-qr-code">
                  <img src={qr} alt={`QR code to join at ${joinUrl}`} />
                </div>
              )}
              <p className="join-qr-hint">
                Scan to vote
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
              {(state?.queue.length ? state.queue : []).map((item, i) => (
                <li key={item.trackId}>
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
              {!state?.queue.length && <li className="empty-queue">Votes will fill the queue</li>}
            </ol>
          </Window>

          <Window title="Crowd quest" className="stage-quest">
            <p className="quest-label">{state?.crowdQuest.label ?? "Crowd quest"}</p>
            <div className="quest-bar">
              <div style={{ width: `${questPct}%` }} />
            </div>
            <p className="quest-count">
              {state?.crowdQuest.progress ?? 0} / {state?.crowdQuest.goal ?? 100}
            </p>
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

/** Progress of the current song, from the player's reports (only while it's actually playing). */
function SongProgress({ state }: { state: import("@crowdpulse/shared").SessionState | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const pb = state?.playback;
  if (!pb || pb.status !== "playing" || !pb.startedAt || !pb.durationMs) return null;
  const pct = Math.min(100, ((now - Date.parse(pb.startedAt)) / pb.durationMs) * 100);
  return (
    <div className="song-progress" aria-hidden>
      <div style={{ width: `${pct}%` }} />
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
