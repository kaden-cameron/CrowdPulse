import { useState } from "react";
import { DEFAULT_STAGE_VIEW, type QueueItem, type SessionState, type StageView } from "@crowdpulse/shared";
import { hostPlayTrack, hostSetQueue, hostSetStageView } from "../lib/host";

// Host-page window: the queue. The host's picks play first, in the host's order (reorder, remove,
// clear); after them come the crowd's top-voted songs. Add picks with "+ Queue" or Shuffle in Songs.

export function QueueCard({
  sessionCode,
  state,
  ready,
  getHeaders,
  onState,
}: {
  sessionCode: string;
  state: SessionState | null;
  ready: boolean;
  getHeaders: () => Promise<Record<string, string>>;
  onState: (s: SessionState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queue = state?.queue ?? [];
  const picks = queue.filter((q) => q.hostPick);
  const voted = queue.filter((q) => !q.hostPick);
  const autoNext = state?.autoNext ?? [];
  const view = state?.stageView ?? DEFAULT_STAGE_VIEW;
  async function setView(next: StageView) {
    setBusy(true);
    setError(null);
    try {
      onState((await hostSetStageView(sessionCode, await getHeaders(), next)).state);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const ids = picks.map((q) => q.trackId);

  async function save(next: string[]) {
    setBusy(true);
    setError(null);
    try {
      onState((await hostSetQueue(sessionCode, await getHeaders(), next)).state);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  /** ▶ Play a queued song now (a host pick leaves the queue as it starts). */
  async function play(q: QueueItem) {
    setBusy(true);
    setError(null);
    try {
      onState((await hostPlayTrack(sessionCode, await getHeaders(), q.trackId)).state);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const playButton = (q: QueueItem) => (
    <button
      type="button"
      className="btn compact play-now"
      disabled={!ready || busy || state?.nowPlaying?.trackId === q.trackId}
      onClick={() => void play(q)}
      aria-label={`Play ${q.title} now`}
      title="Play now"
    >
      ▶
    </button>
  );

  const move = (i: number, by: -1 | 1) => {
    const next = [...ids];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    void save(next);
  };

  return (
    <div className="host-block queue-card">
      <div className="analytics-head">
        <h2>Queue</h2>
        <button type="button" className="btn ghost compact" disabled={!ready || busy || !picks.length} onClick={() => void save([])}>
          Clear queue
        </button>
      </div>
      {/* What the projector shows here: the queue or the vote count — or both, switching on its own. */}
      <div className="stage-view-row" role="group" aria-label="Projector shows">
        <span className="metric-label">Projector</span>
        {(["queue", "votes"] as const).map((p) => (
          <button
            key={p}
            type="button"
            className={`btn compact${!view.auto && view.panel === p ? " primary" : ""}`}
            aria-pressed={!view.auto && view.panel === p}
            disabled={!ready || busy}
            onClick={() => void setView({ panel: p, auto: false })}
          >
            {p === "queue" ? "Queue" : "Votes"}
          </button>
        ))}
        <button
          type="button"
          className={`btn compact${view.auto ? " primary" : ""}`}
          aria-pressed={view.auto}
          disabled={!ready || busy}
          onClick={() => void setView({ ...view, auto: !view.auto })}
          title="Switch between the queue and the vote count every 12 seconds"
        >
          ⟳ Auto
        </button>
      </div>
      <p className="host-sub">
        Your picks play first, in this order. Then the crowd&apos;s top votes.
        {!queue.length && autoNext.length > 0 && " Nothing queued — “auto” shows what plays next on its own."}
      </p>
      <ol className="panel host-queue-list">
        {picks.map((q, i) => (
          // A song can be queued more than once, so position is part of the key.
          <li key={`${q.trackId}-${i}`}>
            <span className="q-rank">{i + 1}</span>
            <span className="library-meta">
              <strong>{q.title}</strong>
              <em>
                {q.artist} · host pick
                {q.votes > 0 && ` · ${q.votes} vote${q.votes === 1 ? "" : "s"}`}
              </em>
            </span>
            <span className="queue-actions">
              {playButton(q)}
              <button type="button" className="btn ghost compact" disabled={!ready || busy || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${q.title} up`}>
                ↑
              </button>
              <button
                type="button"
                className="btn ghost compact"
                disabled={!ready || busy || i === picks.length - 1}
                onClick={() => move(i, 1)}
                aria-label={`Move ${q.title} down`}
              >
                ↓
              </button>
              <button
                type="button"
                className="btn ghost compact"
                disabled={!ready || busy}
                onClick={() => void save(ids.filter((_, k) => k !== i))}
                aria-label={`Take ${q.title} out of the queue`}
              >
                ✕
              </button>
            </span>
          </li>
        ))}
        {voted.map((q, i) => (
          <li key={q.trackId} className="queue-voted">
            <span className="q-rank">{picks.length + i + 1}</span>
            <span className="library-meta">
              <strong>{q.title}</strong>
              <em>
                {q.artist} · {q.votes} vote{q.votes === 1 ? "" : "s"}
                {q.boosts > 0 && ` · ⚡${q.boosts}`}
              </em>
            </span>
            {playButton(q)}
          </li>
        ))}
        {/* Nothing queued: what auto play would pick next on its own (least recently played). */}
        {!queue.length &&
          autoNext.map((q, i) => (
            <li key={q.trackId} className="queue-auto">
              <span className="q-rank">{i + 1}</span>
              <span className="library-meta">
                <strong>{q.title}</strong>
                <em>{q.artist}</em>
              </span>
              <span className="auto-tag">auto</span>
              {playButton(q)}
            </li>
          ))}
        {!queue.length && !autoNext.length && (
          <li className="host-sub">Empty — add songs with “+ Queue” or 🔀 Shuffle, or wait for votes.</li>
        )}
      </ol>
      {error && <p className="feedback feedback-rejected">{error}</p>}
    </div>
  );
}
