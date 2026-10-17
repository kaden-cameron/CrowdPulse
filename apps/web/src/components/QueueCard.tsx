import { useState } from "react";
import type { SessionState } from "@crowdpulse/shared";
import { hostSetQueue } from "../lib/host";

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
      <p className="host-sub">Your picks play first, in this order. Then the crowd&apos;s top votes.</p>
      <ol className="panel host-queue-list">
        {picks.map((q, i) => (
          <li key={q.trackId}>
            <span className="q-rank">{i + 1}</span>
            <span className="library-meta">
              <strong>{q.title}</strong>
              <em>
                {q.artist} · host pick
                {q.votes > 0 && ` · ${q.votes} vote${q.votes === 1 ? "" : "s"}`}
              </em>
            </span>
            <span className="queue-actions">
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
                onClick={() => void save(ids.filter((id) => id !== q.trackId))}
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
          </li>
        ))}
        {!queue.length && <li className="host-sub">Empty — add songs with “+ Queue” or 🔀 Shuffle, or wait for votes.</li>}
      </ol>
      {error && <p className="feedback feedback-rejected">{error}</p>}
    </div>
  );
}
