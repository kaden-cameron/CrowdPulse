import { useCallback, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  DEFAULT_STAGE_VIEW,
  THEME_ALLOWLIST,
  type SessionState,
  type StageView,
  type VisualTheme,
} from "@crowdpulse/shared";
import { AiPanel } from "../components/AiPanel";
import { AnalyticsPanel } from "../components/AnalyticsPanel";
import { Dock } from "../components/Dock";
import { MenuBar } from "../components/MenuBar";
import { DevKeySignIn, useHostAccess } from "../components/HostAccess";
import { useMetrics } from "../hooks/useMetrics";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { useSessionAppearance } from "../lib/theme";
import { AppearanceCard } from "../components/AppearanceCard";
import { LibraryCard } from "../components/LibraryCard";
import { QueueCard } from "../components/QueueCard";
import { PlaylistsCard } from "../components/PlaylistsCard";
import { SettingsPanel } from "../components/SettingsPanel";
import { ProfileIcon } from "../components/Icons";
import { hostReset, hostResetCrowd, hostSetAppearance, hostSetStageView, hostSetVisual } from "../lib/host";
import { presetLabel } from "../lib/theme";
import { PlayerCard } from "../components/PlayerCard";
import { useAutoHide } from "../hooks/useAutoHide";

function crowdTrendLabel(trend: number): string {
  if (trend >= 3) return "Rising";
  if (trend <= -3) return "Falling";
  return "Steady";
}


export function HostPage() {
  const { sessionCode = "demo" } = useParams();
  const { state, status, lastMessageAt, applyState } = useSessionSocket(
    sessionCode,
    "host",
  );
  useSessionAppearance(sessionCode, state?.appearance);
  const access = useHostAccess();
  const { metrics, error: metricsError } = useMetrics(sessionCode, access.ready, access.getHeaders);
  const [theme, setTheme] = useState<VisualTheme>("calm_waves");
  const [intensity, setIntensity] = useState(0.5);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const [profileOpen, setProfileOpen] = useState(false);
  const closeProfile = useCallback(() => setProfileOpen(false), []);
  const [message, setMessage] = useState<{
    kind: "accepted" | "rejected";
    text: string;
  } | null>(null);
  useAutoHide(message, () => setMessage(null));
  const [crowdMsg, setCrowdMsg] = useState<{ kind: "accepted" | "rejected"; text: string } | null>(null);
  useAutoHide(crowdMsg, () => setCrowdMsg(null));


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

  const crowd = state?.crowdEnergy;
  const stageView = state?.stageView ?? DEFAULT_STAGE_VIEW;

  async function setProjector(next: StageView) {
    setBusy(true);
    setMessage(null);
    try {
      applyState((await hostSetStageView(sessionCode, await access.getHeaders(), next)).state);
      setMessage({
        kind: "accepted",
        text: next.auto
          ? "Projector switches between queue and votes"
          : next.panel === "votes"
            ? "Projector shows the vote count"
            : "Projector shows the queue",
      });
    } catch (err) {
      setMessage({ kind: "rejected", text: err instanceof Error ? err.message : "Request failed" });
    } finally {
      setBusy(false);
    }
  }

  // Nothing about the session (songs, queue, Gemini, numbers) is shown until a host signs in.
  if (!access.ready) {
    return (
      <main className="host-page host-locked">
        <MenuBar title="Host" status={status} lastMessageAt={lastMessageAt} />
        <section className="signin-screen">
          <div className="host-block signin-card">
            <h1>Host sign in</h1>
            <p className="signin-lead">
              <ProfileIcon size={22} />
              <span>
                Sign in to run <strong>{state?.sessionName ?? "the session"}</strong>: music, the queue, the stage and Gemini.
              </span>
            </p>
            <HostSignIn />
            <p className="host-sub">Only hosts can see this page. Attendees vote at the join link on the big screen.</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="host-page">
      <MenuBar
        title="Host"
        status={status}
        lastMessageAt={lastMessageAt}
        actions={
          <>
          <button
            type="button"
            className={`menubar-tab menubar-action menubar-profile${access.ready ? " signed-in" : ""}`}
            aria-expanded={profileOpen}
            aria-controls="host-profile"
            aria-label={access.ready ? `Profile: signed in${access.userLabel ? ` as ${access.userLabel}` : ""}` : "Sign in"}
            title={access.ready ? (access.userLabel ?? "Signed in") : "Sign in as host"}
            onClick={() => (setSettingsOpen(false), setProfileOpen((o) => !o))}
          >
            <ProfileIcon size={17} />
            {!access.ready && <span className="menubar-profile-label">Sign in</span>}
          </button>
          <button
            type="button"
            className="menubar-tab menubar-action"
            aria-expanded={settingsOpen}
            aria-controls="host-settings"
            aria-label="Settings: appearance and stage"
            title="Settings"
            onClick={() => (setProfileOpen(false), setSettingsOpen((o) => !o))}
          >
            <span aria-hidden>⚙︎</span>
          </button>
          </>
        }
      />
      <SettingsPanel id="host-profile" title="Profile" open={profileOpen} onClose={closeProfile}>
        <section className="settings-section">
          <h3>Host · {state?.sessionName ?? sessionCode}</h3>
          {!access.ready && (
            <p className="host-sub">Sign in to control music, the stage and Gemini — the server checks every request.</p>
          )}
          <HostSignIn />
          <div className="cta-row">
            <Link className="btn ghost compact" to={`/stage/${sessionCode}`}>
              Open stage
            </Link>
            <Link className="btn ghost compact" to={`/join/${sessionCode}`}>
              Attendee link
            </Link>
          </div>
        </section>
      </SettingsPanel>
      <SettingsPanel open={settingsOpen} onClose={closeSettings}>
        <AppearanceCard
          compact
          appearance={state?.appearance}
          disabled={busy || !access.ready}
          onChange={(next) =>
            run(
              (next.showEnergy !== false) !== (state?.appearance.showEnergy !== false)
                ? next.showEnergy === false
                  ? "Crowd energy hidden"
                  : "Crowd energy shown"
                : `Look changed to ${presetLabel(next.preset)} · ${next.mode}`,
              async () => hostSetAppearance(sessionCode, await access.getHeaders(), next),
            )
          }
        />
        <section className="settings-section">
          <h3>Stage</h3>
          {!access.ready && (
            <p className="host-sub">Sign in as host to use stage controls.</p>
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
              onClick={() => {
                if (
                  window.confirm(
                    "Start a new run? Votes, crowd energy, the queue and stage settings reset. Saved history is kept.",
                  )
                ) {
                  run("New run started", async () =>
                    hostReset(sessionCode, await access.getHeaders()),
                  );
                }
              }}
            >
              Start new run
            </button>
          </div>

          <fieldset className="mood-field">
            <legend>Projector</legend>
            <p className="host-sub">What the stage shows where the queue is.</p>
            <div className="stage-view-row" role="group" aria-label="Projector shows">
              {(["queue", "votes"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`btn compact${!stageView.auto && stageView.panel === p ? " primary" : ""}`}
                  aria-pressed={!stageView.auto && stageView.panel === p}
                  disabled={busy || !access.ready}
                  onClick={() => void setProjector({ panel: p, auto: false })}
                >
                  {p === "queue" ? "Queue" : "Votes"}
                </button>
              ))}
              <button
                type="button"
                className={`btn compact${stageView.auto ? " primary" : ""}`}
                aria-pressed={stageView.auto}
                disabled={busy || !access.ready}
                onClick={() => void setProjector({ ...stageView, auto: !stageView.auto })}
                title="Switch between the queue and the vote count every 12 seconds"
              >
                Auto
              </button>
            </div>
          </fieldset>

          <div role="status" aria-live="polite">
            {message && (
              <p className={`feedback feedback-${message.kind}`}>
                {message.text}
              </p>
            )}
          </div>
        </section>
      </SettingsPanel>

      <section className="host-grid">

        {/* Now playing, with the Gemini DJ beside it */}
        <PlayerCard
          sessionCode={sessionCode}
          state={state}
          ready={access.ready}
          getHeaders={access.getHeaders}
          onState={applyState}
        />
        <AiPanel
          sessionId={sessionCode}
          getHeaders={access.getHeaders}
          ready={access.ready}
          tracks={state?.tracks ?? []}
          onState={applyState}
        />

        {/* Picking songs */}
        <LibraryCard
          sessionCode={sessionCode}
          state={state}
          ready={access.ready}
          getHeaders={access.getHeaders}
          onState={applyState}
        />
        <QueueCard
          sessionCode={sessionCode}
          state={state}
          ready={access.ready}
          getHeaders={access.getHeaders}
          onState={applyState}
        />
        <PlaylistsCard
          sessionCode={sessionCode}
          state={state}
          ready={access.ready}
          getHeaders={access.getHeaders}
          onState={applyState}
        />

        {/* Crowd energy, beside Playlists */}
        <div className="host-block crowd-card">
          <div className="analytics-head">
            <h2>Crowd energy</h2>
            <button
              type="button"
              className="btn ghost compact"
              disabled={busy || !access.ready}
              onClick={() => {
                if (window.confirm("Reset crowd energy? Clears attendee energy levels and genre picks. Votes, the queue and the library stay.")) {
                  void (async () => {
                    try {
                      applyState((await hostResetCrowd(sessionCode, await access.getHeaders())).state);
                      setCrowdMsg({ kind: "accepted", text: "Crowd energy reset." });
                    } catch (err) {
                      setCrowdMsg({ kind: "rejected", text: (err as Error).message });
                    }
                  })();
                }
              }}
              title="Clear crowd energy and genre picks (votes, queue and library stay)"
            >
              Reset energy
            </button>
          </div>
          <div className="crowd-energy-gauge" aria-live="polite">
            <div className="crowd-energy-readout">
              <strong>{crowd?.average ?? 50}</strong>
              <span className="metric-label">average · {crowd?.count ?? 0} set</span>
            </div>
            <span className="quest-bar crowd-energy-bar" aria-hidden>
              <div style={{ width: `${crowd?.average ?? 50}%` }} />
            </span>
            <p className="crowd-energy-trend">
              Trend: <strong>{crowdTrendLabel(crowd?.trend ?? 0)}</strong>
              {(crowd?.trend ?? 0) !== 0 && (
                <span className="host-sub"> ({crowd!.trend > 0 ? "+" : ""}{crowd!.trend})</span>
              )}
            </p>
            <p className="host-sub">Low → high from attendee sliders. Feeds the energy score and Gemini.</p>
          </div>
          {crowdMsg && <p className={`feedback feedback-${crowdMsg.kind}`}>{crowdMsg.text}</p>}
          <h3 className="metric-label">Genres people want</h3>
          <ul className="genre-tally">
            {Object.entries(state?.genres ?? {})
              .sort((x, y) => y[1] - x[1])
              .map(([g, n]) => (
                <li key={g}>
                  <span>{g}</span>
                  <strong>{n}</strong>
                </li>
              ))}
            {!Object.keys(state?.genres ?? {}).length && <li className="host-sub">No genre picks yet</li>}
          </ul>
          <p className="host-sub">
            Latest: {state?.latestEvent?.message ?? "no events yet"}
          </p>
        </div>


      </section>

      {/* Numbers and charts: their own section so the controls above can pack tightly without
          pulling these up between them. */}
      <section className="host-grid metrics-grid" aria-label="Session numbers">
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
      </section>
      <Dock sessionCode={sessionCode} />
    </main>
  );
}

export function HostSignIn() {
  const access = useHostAccess();

  if (access.mode === "loading") return <p className="host-sub">Loading sign-in…</p>;
  if (access.mode === "error") {
    return <p className="feedback feedback-rejected">{access.error}</p>;
  }

  if (access.mode === "dev-key") return <DevKeySignIn />;

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
