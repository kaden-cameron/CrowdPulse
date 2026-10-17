import { Link, useParams } from "react-router-dom";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { StageCanvas } from "../components/StageCanvas";
import { useSessionSocket } from "../hooks/useSessionSocket";

export function StagePage() {
  const { sessionCode = "demo" } = useParams();
  const { state, status } = useSessionSocket(sessionCode, "stage");

  const visual = state?.visualState ?? {
    theme: "electric_blue" as const,
    intensity: 0.35,
  };

  const questPct = state
    ? Math.round((state.crowdQuest.progress / state.crowdQuest.goal) * 100)
    : 0;

  return (
    <main className="stage-page" data-theme={visual.theme}>
      <StageCanvas visual={visual} />

      <div className="stage-overlay">
        <header className="stage-header">
          <div>
            <p className="brand-mark stage-brand">CrowdPulse</p>
            <h1 className="stage-session">
              {state?.sessionName ?? "Connecting…"}
            </h1>
          </div>
          <div className="stage-header-meta">
            <ConnectionBadge status={status} />
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
            <Link className="join-qr-hint" to={`/join/${sessionCode}`}>
              Join: /join/{sessionCode}
            </Link>
          </section>
        </footer>
      </div>
    </main>
  );
}
