import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  MOODS,
  THEME_ALLOWLIST,
  type SessionState,
  type VisualTheme,
} from "@crowdpulse/shared";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { hostAdvance, hostSetVisual } from "../lib/host";

const KEY_STORAGE = "crowdpulse.hostKey";

export function HostPage() {
  const { sessionCode = "demo" } = useParams();
  const { state, status, lastMessageAt, applyState } = useSessionSocket(
    sessionCode,
    "host",
  );
  const [hostKey, setHostKey] = useState(
    () => sessionStorage.getItem(KEY_STORAGE) ?? "",
  );
  const [theme, setTheme] = useState<VisualTheme>("calm_waves");
  const [intensity, setIntensity] = useState(0.5);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    kind: "accepted" | "rejected";
    text: string;
  } | null>(null);

  useEffect(() => {
    sessionStorage.setItem(KEY_STORAGE, hostKey);
  }, [hostKey]);

  async function run(label: string, action: () => Promise<{ state: SessionState }>) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await action();
      applyState(res.state);
      setMessage({ kind: "accepted", text: label });
    } catch (err) {
      setMessage({
        kind: "rejected",
        text: err instanceof Error ? err.message : "Request failed",
      });
    } finally {
      setBusy(false);
    }
  }

  const totalMoods = state ? MOODS.reduce((n, m) => n + state.moods[m], 0) : 0;

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
          <h1>Host · {state?.sessionName ?? sessionCode}</h1>
          <p className="host-sub">
            Live metrics are server-owned. Stage controls need the host key
            until Auth0 login lands.
          </p>
        </div>

        <div className="metric-strip" role="group" aria-label="Session metrics">
          <div>
            <span className="metric-label">Energy</span>
            <strong>{state?.energyScore ?? "—"}</strong>
          </div>
          <div>
            <span className="metric-label">Crowd</span>
            <strong>{state?.participants ?? "—"}</strong>
          </div>
          <div>
            <span className="metric-label">Theme</span>
            <strong>
              {state?.visualState.theme.replaceAll("_", " ") ?? "—"}
            </strong>
          </div>
          <div>
            <span className="metric-label">
              Intensity · {state?.visualMode ?? "—"}
            </span>
            <strong>
              {state
                ? Math.round(state.visualState.intensity * 100)
                : "—"}
              %
            </strong>
          </div>
        </div>

        <div className="host-block">
          <h2>Stage controls</h2>
          <label className="host-field">
            <span className="metric-label">Host key</span>
            <input
              type="password"
              autoComplete="off"
              value={hostKey}
              onChange={(e) => setHostKey(e.target.value)}
              placeholder="Temporary until Auth0"
            />
          </label>

          <fieldset className="mood-field">
            <legend>Theme</legend>
            <div className="mood-grid">
              {THEME_ALLOWLIST.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`mood-chip ${theme === t ? "selected" : ""}`}
                  aria-pressed={theme === t}
                  onClick={() => setTheme(t)}
                >
                  <span className="mood-label">{t.replaceAll("_", " ")}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <label className="host-field">
            <span className="metric-label">
              Intensity {Math.round(intensity * 100)}%
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={intensity}
              onChange={(e) => setIntensity(Number(e.target.value))}
            />
          </label>

          <div className="cta-row">
            <button
              type="button"
              className="btn primary"
              disabled={busy || !hostKey}
              onClick={() =>
                run("Stage updated", () =>
                  hostSetVisual(sessionCode, hostKey, { theme, intensity }),
                )
              }
            >
              Apply to stage
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busy || !hostKey || state?.visualMode === "auto"}
              onClick={() =>
                run("Stage follows the crowd", () =>
                  hostSetVisual(sessionCode, hostKey, null),
                )
              }
            >
              Back to auto
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busy || !hostKey}
              onClick={() =>
                run("Playing the top-voted track", () =>
                  hostAdvance(sessionCode, hostKey),
                )
              }
            >
              Play next ▶
            </button>
          </div>
          <div role="status" aria-live="polite">
            {message && (
              <p className={`feedback feedback-${message.kind}`}>
                {message.text}
              </p>
            )}
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
          <h2>Crowd mood</h2>
          <ul className="mood-bars">
            {MOODS.map((m) => {
              const n = state?.moods[m] ?? 0;
              const pct = totalMoods ? Math.round((n / totalMoods) * 100) : 0;
              return (
                <li key={m}>
                  <span>{m}</span>
                  <span className="quest-bar">
                    <div style={{ width: `${pct}%` }} />
                  </span>
                  <span>{n}</span>
                </li>
              );
            })}
          </ul>
          <p className="host-sub">
            Latest: {state?.latestEvent?.message ?? "no events yet"}
          </p>
        </div>

        <div className="host-block">
          <h2>Queue</h2>
          <p className="host-sub">
            Now playing: {state?.nowPlaying?.title ?? "—"}
          </p>
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
