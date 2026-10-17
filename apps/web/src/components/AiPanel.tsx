import { useCallback, useEffect, useState } from "react";
import {
  HOST_TARGETS,
  type HostTarget,
  type Recommendation,
  type SessionState,
  type Track,
} from "@crowdpulse/shared";
import {
  decideRecommendation,
  fetchRecommendations,
  requestRecommendation,
  type AiSnapshot,
} from "../lib/host";

const TARGET_LABELS: Record<HostTarget, string> = {
  raise_energy: "Raise energy",
  hold_steady: "Hold steady",
  cool_down: "Cool down",
};

const STATUS_LABELS: Record<Recommendation["status"], string> = {
  pending: "Awaiting your decision",
  approved: "Approved",
  rejected: "Rejected",
  invalid: "Rejected by server validator",
  failed: "AI unavailable",
};

const POLL_MS = 5000;

export function AiPanel({
  sessionId,
  getHeaders,
  ready,
  tracks,
  onState,
}: {
  sessionId: string;
  getHeaders: () => Promise<Record<string, string>>;
  /** Host is signed in (or has a dev key). */
  ready: boolean;
  tracks: Track[];
  onState: (state: SessionState) => void;
}) {
  const [snapshot, setSnapshot] = useState<AiSnapshot | null>(null);
  const [target, setTarget] = useState<HostTarget>("raise_energy");
  const [busy, setBusy] = useState<"ask" | "decide" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!ready) return;
    try {
      setSnapshot(await fetchRecommendations(sessionId, await getHeaders()));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load recommendations");
    }
  }, [sessionId, ready, getHeaders]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  async function ask() {
    setBusy("ask");
    setError(null);
    try {
      const res = await requestRecommendation(sessionId, await getHeaders(), target);
      setSnapshot((s) => ({
        ai: res.ai,
        recommendations: [res.recommendation, ...(s?.recommendations ?? []).filter((r) => r.id !== res.recommendation.id)],
      }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  async function decide(id: string, decision: "approve" | "reject") {
    setBusy("decide");
    setError(null);
    try {
      const res = await decideRecommendation(sessionId, await getHeaders(), id, decision);
      if (res.state) onState(res.state);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  const title = (id: string | null) => (id ? tracks.find((t) => t.id === id)?.title ?? id : "—");
  const latest = snapshot?.recommendations[0] ?? null;
  const ai = snapshot?.ai;

  return (
    <div className="host-block ai-card">
      <div className="analytics-head">
        <h2>Gemini AI DJ</h2>
        <span className="analytics-meta">
          {!ready
            ? "Sign in as host to use AI"
            : !ai
              ? "Loading…"
              : ai.configured
                ? `${ai.model}${ai.lastError ? " · last call failed" : ""}`
                : "Not configured"}
        </span>
      </div>

      {ai && !ai.configured && (
        <p className="ai-status">Unavailable — set GEMINI_API_KEY on the server. Voting and stage controls still work.</p>
      )}
      {ai?.lastError && ai.configured && <p className="feedback feedback-rejected">{ai.lastError}</p>}
      {error && (
        <p className="feedback feedback-rejected" role="alert">
          {error}
        </p>
      )}

      <fieldset className="mood-field compact-field">
        <legend>Host target</legend>
        <div className="target-row">
          {HOST_TARGETS.map((t) => (
            <button
              key={t}
              type="button"
              className={`mood-chip ${target === t ? "selected" : ""}`}
              aria-pressed={target === t}
              onClick={() => setTarget(t)}
            >
              <span className="mood-label">{TARGET_LABELS[t]}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <button
        type="button"
        className="btn primary"
        disabled={!ready || !ai?.configured || busy !== null}
        onClick={ask}
      >
        {busy === "ask" ? "Asking Gemini…" : "Get recommendation"}
      </button>

      {latest && (
        <div className={`rec rec-${latest.status}`} aria-live="polite">
          <p className="rec-status">{STATUS_LABELS[latest.status]}</p>

          {latest.proposal ? (
            <>
              <p className="rec-reason">“{latest.proposal.reason}”</p>
              <dl className="rec-grid">
                <div>
                  <dt>Next track</dt>
                  <dd>{title(latest.proposal.recommended_track_id)}</dd>
                </div>
                <div>
                  <dt>Stage</dt>
                  <dd>
                    {latest.proposal.visual_theme.replaceAll("_", " ")} @ {Math.round(latest.proposal.intensity * 100)}%
                  </dd>
                </div>
                <div>
                  <dt>Target energy</dt>
                  <dd>{latest.proposal.target_energy}</dd>
                </div>
                <div>
                  <dt>Confidence (model-reported)</dt>
                  <dd>{Math.round(latest.proposal.confidence * 100)}%</dd>
                </div>
              </dl>
            </>
          ) : (
            <ul className="rec-errors">
              {latest.validationErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}

          <p className="rec-baseline">
            Baseline (majority vote): <strong>{title(latest.baseline.trackId)}</strong> — {latest.baseline.reason}
          </p>

          {latest.status === "pending" && (
            <div className="cta-row">
              <button
                type="button"
                className="btn primary"
                disabled={busy !== null}
                onClick={() => decide(latest.id, "approve")}
              >
                Approve &amp; apply
              </button>
              <button
                type="button"
                className="btn ghost"
                disabled={busy !== null}
                onClick={() => decide(latest.id, "reject")}
              >
                Reject
              </button>
            </div>
          )}

          <p className="rec-meta">
            {latest.model}
            {latest.modelVersion && ` (${latest.modelVersion})`}
            {latest.latencyMs != null && ` · ${latest.latencyMs} ms`}
            {latest.responseId && ` · response ${latest.responseId.slice(0, 12)}…`}
            {` · for “${TARGET_LABELS[latest.hostTarget]}”`}
          </p>

          <details className="chart-table">
            <summary>Show what was sent to Gemini</summary>
            <pre className="rec-input">{JSON.stringify(latest.input, null, 2)}</pre>
          </details>
        </div>
      )}

      {snapshot && snapshot.recommendations.length > 1 && (
        <details className="chart-table">
          <summary>History ({snapshot.recommendations.length - 1} earlier)</summary>
          <ul className="rec-history">
            {snapshot.recommendations.slice(1).map((r) => (
              <li key={r.id}>
                <span>{new Date(r.createdAt).toLocaleTimeString()}</span>
                <span>{r.proposal ? title(r.proposal.recommended_track_id) : "—"}</span>
                <span className={`rec-pill rec-${r.status}`}>{r.status}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
