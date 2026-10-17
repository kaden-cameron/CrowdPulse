import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  MOODS,
  THEME_ALLOWLIST,
  type SessionState,
  type VisualTheme,
} from "@crowdpulse/shared";
import { AiPanel } from "../components/AiPanel";
import { AnalyticsPanel } from "../components/AnalyticsPanel";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { useHostAccess } from "../components/HostAccess";
import { useMetrics } from "../hooks/useMetrics";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { hostAdvance, hostReset, hostSetVisual } from "../lib/host";


export function HostPage() {
  const { sessionCode = "demo" } = useParams();
  const { state, status, lastMessageAt, applyState } = useSessionSocket(
    sessionCode,
    "host",
  );
  const { metrics, error: metricsError } = useMetrics(sessionCode);
  const access = useHostAccess();
  const [theme, setTheme] = useState<VisualTheme>("calm_waves");
  const [intensity, setIntensity] = useState(0.5);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    kind: "accepted" | "rejected";
    text: string;
  } | null>(null);


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
            Live metrics are server-owned. Stage controls and AI decisions
            require a signed-in host — the server checks every request.
          </p>
          <HostSignIn />
        </div>

        <div className="metric-strip" role="group" aria-label="Session metrics">
          <div>
            <span className="metric-label">Energy</span>
            <strong>{state?.energyScore ?? "—"}</strong>
          </div>
          <div>
            <span className="metric-label">Crowd</span>
            <strong>{state?.participants ?? "—"}</strong>
            {!!state?.simulatedParticipants && (
              <span className="demo-data-badge small">
                Demo data · {state.simulatedParticipants} simulated
              </span>
            )}
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

        <AnalyticsPanel
          metrics={metrics}
          error={metricsError}
          tracks={state?.tracks ?? []}
        />

        <div className="host-block">
          <h2>Stage controls</h2>
          {!access.ready && (
            <p className="host-sub">Sign in as host (above) to use stage controls.</p>
          )}

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
              disabled={busy || !access.ready}
              onClick={() =>
                run("Stage updated", async () =>
                  hostSetVisual(sessionCode, await access.getHeaders(), { theme, intensity }),
                )
              }
            >
              Apply to stage
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busy || !access.ready || state?.visualMode === "auto"}
              onClick={() =>
                run("Stage follows the crowd", async () =>
                  hostSetVisual(sessionCode, await access.getHeaders(), null),
                )
              }
            >
              Back to auto
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busy || !access.ready}
              onClick={() =>
                run("Playing the top-voted track", async () =>
                  hostAdvance(sessionCode, await access.getHeaders()),
                )
              }
            >
              Play next ▶
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={busy || !access.ready}
              onClick={() => {
                if (
                  window.confirm(
                    "Start a new run? Votes, moods, the queue and stage settings reset. Saved history is kept.",
                  )
                ) {
                  run("New run started", async () =>
                    hostReset(sessionCode, await access.getHeaders()),
                  );
                }
              }}
            >
              Start new run ↺
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

        <AiPanel
          sessionId={sessionCode}
          getHeaders={access.getHeaders}
          ready={access.ready}
          tracks={state?.tracks ?? []}
          onState={applyState}
        />

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
                {item.title} — {item.artist} ({item.votes}
                {item.boosts > 0 && ` · ⚡${item.boosts} devnet`})
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

function HostSignIn() {
  const access = useHostAccess();

  if (access.mode === "loading") return <p className="host-sub">Loading sign-in…</p>;
  if (access.mode === "error") {
    return <p className="feedback feedback-rejected">{access.error}</p>;
  }

  if (access.mode === "dev-key") {
    return (
      <div className="host-auth">
        <label className="host-field">
          <span className="metric-label">Dev host key (Auth0 not configured on this server)</span>
          <input
            type="password"
            autoComplete="off"
            value={access.devKey}
            onChange={(e) => access.setDevKey(e.target.value)}
            placeholder="local-dev-host-key"
          />
        </label>
      </div>
    );
  }

  return (
    <div className="host-auth">
      {access.ready ? (
        <>
          <span className="host-user">
            Signed in as <strong>{access.userLabel}</strong>
          </span>
          <button type="button" className="btn ghost compact" onClick={access.logout}>
            Sign out
          </button>
        </>
      ) : (
        <button type="button" className="btn primary" onClick={access.login}>
          Sign in as host
        </button>
      )}
      {access.error && <p className="feedback feedback-rejected">{access.error}</p>}
    </div>
  );
}
