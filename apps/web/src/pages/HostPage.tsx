import { Link, useParams } from "react-router-dom";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { useSessionSocket } from "../hooks/useSessionSocket";

export function HostPage() {
  const { sessionCode = "demo" } = useParams();
  const { state, status } = useSessionSocket(sessionCode, "host");

  return (
    <main className="host-page">
      <header className="page-top">
        <Link to="/" className="brand-inline">
          CrowdPulse
        </Link>
        <ConnectionBadge status={status} />
      </header>

      <section className="host-grid">
        <div className="host-block">
          <h1>Host · {state?.sessionName ?? sessionCode}</h1>
          <p className="host-sub">
            Session controls and AI recommendations land here in later stages.
            Live metrics below are already server-owned.
          </p>
        </div>

        <div className="metric-strip" role="group" aria-label="Session metrics">
          <div>
            <span className="metric-label">Energy</span>
            <strong>{state?.energyScore ?? "—"}</strong>
          </div>
          <div>
            <span className="metric-label">Theme</span>
            <strong>
              {state?.visualState.theme.replaceAll("_", " ") ?? "—"}
            </strong>
          </div>
          <div>
            <span className="metric-label">Intensity</span>
            <strong>
              {state
                ? Math.round(state.visualState.intensity * 100)
                : "—"}
              %
            </strong>
          </div>
          <div>
            <span className="metric-label">Queue depth</span>
            <strong>{state?.queue.length ?? 0}</strong>
          </div>
        </div>

        <div className="host-block ai-card" tabIndex={0}>
          <h2>Gemini recommendation</h2>
          <p className="ai-status">Unavailable — wire-up in stage 04</p>
          <p>
            Voting and stage visuals keep working without AI. Approve/reject
            controls will appear when a real recommendation is available.
          </p>
          <div className="cta-row">
            <button type="button" className="btn primary" disabled>
              Approve
            </button>
            <button type="button" className="btn ghost" disabled>
              Reject
            </button>
          </div>
        </div>

        <div className="host-block">
          <h2>Queue</h2>
          <ol className="host-queue">
            {(state?.queue ?? []).map((item) => (
              <li key={item.trackId}>
                {item.title} — {item.artist} ({item.votes})
              </li>
            ))}
            {!state?.queue.length && <li>No votes yet</li>}
          </ol>
          <div className="cta-row">
            <Link className="btn ghost" to={`/stage/${sessionCode}`}>
              Open stage
            </Link>
            <Link className="btn ghost" to={`/join/${sessionCode}`}>
              Attendee link
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
