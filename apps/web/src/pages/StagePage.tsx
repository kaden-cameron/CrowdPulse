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
  const joinUrl = `${window.location.origin}/join/${encodeURIComponent(sessionCode)}`;
  const [qr, setQr] = useState<string | null>(null);
  const live = status === "connected";

  useEffect(() => {
    QRCode.toDataURL(joinUrl, {
      margin: 1,
      width: 280,
      color: { dark: "#06141f", light: "#ffffff" },
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
                <img src={qr} alt={`QR code to join at ${joinUrl}`} />
              )}
              <p className="join-qr-hint">
                {joinUrl.replace(/^https?:\/\//, "")}
                <span>{state?.participants ?? 0} in the crowd</span>
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
