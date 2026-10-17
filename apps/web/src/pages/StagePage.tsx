import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import QRCode from "qrcode";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { StageCanvas } from "../components/StageCanvas";
import { useSessionSocket } from "../hooks/useSessionSocket";

export function StagePage() {
  const { sessionCode = "demo" } = useParams();
  const { state, status, lastMessageAt } = useSessionSocket(
    sessionCode,
    "stage",
  );
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
    <main className="stage-page" data-theme={visual.theme}>
      <StageCanvas visual={visual} paused={!live} />

      <div className="stage-overlay">
        <header className="stage-header">
          <div>
            <p className="brand-mark stage-brand">CrowdPulse</p>
            <h1 className="stage-session">
              {state?.sessionName ?? "Connecting…"}
            </h1>
          </div>
          <div className="stage-header-meta">
            <ConnectionBadge status={status} lastMessageAt={lastMessageAt} />
            <p className="freshness">
              {state
                ? `Updated ${new Date(state.updatedAt).toLocaleTimeString()}`
                : "Waiting for server"}
            </p>
          </div>
        </header>

        <div className="stage-center">
          <p className="theme-label">{visual.theme.replaceAll("_", " ")}</p>
          <div className="energy-block" aria-label="Energy meter">
            <div className="energy-score">{state?.energyScore ?? 0}</div>
            <div className="energy-bar-track">
              <div
                className="energy-bar-fill"
                style={{ width: `${state?.energyScore ?? 0}%` }}
              />
            </div>
            <p className="energy-caption">Live engagement</p>
          </div>
          <div className="now-playing">
            <p className="theme-label">Now playing</p>
            <p className="now-playing-title">
              {state?.nowPlaying
                ? `${state.nowPlaying.title} — ${state.nowPlaying.artist}`
                : "Waiting for the first pick"}
            </p>
            <SongProgress state={state} />
          </div>
        </div>

        <footer className="stage-footer">
          <section className="stage-queue">
            <h2>Next up</h2>
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
              {!state?.queue.length && (
                <li className="empty-queue">Votes will fill the queue</li>
              )}
            </ol>
          </section>

          <section className="stage-side">
            <div className="quest">
              <h2>{state?.crowdQuest.label ?? "Crowd quest"}</h2>
              <div className="quest-bar">
                <div style={{ width: `${questPct}%` }} />
              </div>
              <p>
                {state?.crowdQuest.progress ?? 0} /{" "}
                {state?.crowdQuest.goal ?? 100}
              </p>
            </div>
            <div className="latest-event" aria-live="polite">
              <h2>Latest</h2>
              <p>{state?.latestEvent?.message ?? "Session warming up"}</p>
            </div>
            <div className="join-qr">
              {qr && (
                <div className="join-qr-code">
                  <img src={qr} alt={`QR code to join at ${joinUrl}`} />
                </div>
              )}
              <p className="join-qr-hint">
                {joinUrl.replace(/^https?:\/\//, "")}
                <span>{state?.participants ?? 0} in the crowd</span>
                {joinBase.warning && <span className="join-qr-warning">{joinBase.warning}</span>}
              </p>
            </div>
            {!!state?.simulatedParticipants && (
              <p className="demo-data-badge" role="note">
                Demo data · {state.simulatedParticipants} simulated attendees
              </p>
            )}
          </section>
        </footer>
      </div>

      {!live && status !== "connecting" && (
        <div className="stage-stale" role="alert">
          {status === "not_found"
            ? "Session not found"
            : "Disconnected — live data paused"}
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
