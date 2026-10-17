import { useState } from "react";
import type { SessionMetrics, Track } from "@crowdpulse/shared";

type Tiger = Extract<SessionMetrics, { persistence: "tigerdata" }>;
type Bucket = Tiger["buckets"][number];

const BUCKET_MS = 5000;
const WINDOW_MS = 5 * 60_000;

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const ago = (iso: string | null) => {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${s % 60}s ago`;
};

/** Fills empty 5s slots between the window start and now so time reads evenly. */
function fillBuckets(buckets: Bucket[], generatedAt: string): (Bucket & { empty?: boolean })[] {
  const end = Math.floor(Date.parse(generatedAt) / BUCKET_MS) * BUCKET_MS;
  const start = end - WINDOW_MS + BUCKET_MS;
  const byTime = new Map(buckets.map((b) => [Date.parse(b.bucket), b]));
  const out: (Bucket & { empty?: boolean })[] = [];
  for (let t = start; t <= end; t += BUCKET_MS) {
    out.push(
      byTime.get(t) ?? {
        bucket: new Date(t).toISOString(),
        eventCount: 0,
        votes: 0,
        taps: 0,
        avgEnergy: null,
        source: "raw",
        empty: true,
      },
    );
  }
  return out;
}

const niceMax = (v: number) => {
  if (v <= 5) return 5;
  const step = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / step) * step;
};

export function AnalyticsPanel({
  metrics,
  error,
  tracks,
}: {
  metrics: SessionMetrics | null;
  error: string | null;
  tracks: Track[];
}) {
  if (!metrics) {
    return (
      <div className="host-block">
        <h2>Live analytics</h2>
        <p className="host-sub">{error ?? "Loading metrics…"}</p>
      </div>
    );
  }

  if (metrics.persistence === "memory") {
    return (
      <div className="host-block">
        <h2>Live analytics</h2>
        <p className="ai-status">Persistence off</p>
        <p className="host-sub">
          The server is running in memory. Set <code>DATABASE_URL</code> to a TigerData service to
          persist events and enable SQL-backed metrics.
        </p>
      </div>
    );
  }

  const filled = fillBuckets(metrics.buckets, metrics.generatedAt);
  const titles = new Map(tracks.map((t) => [t.id, t.title]));

  return (
    <div className="host-block analytics viz-root">
      <div className="analytics-head">
        <h2>Live analytics · TigerData</h2>
        <span className="analytics-meta">
          Query {metrics.queryMs} ms · polled {timeLabel(metrics.generatedAt)}
        </span>
      </div>
      {error && (
        <p className="feedback feedback-rejected" role="alert">
          {error} — showing the last good result.
        </p>
      )}

      <div className="stat-tiles">
        <div>
          <span className="metric-label">Events · last 10s</span>
          <strong>{metrics.eventsLast10s}</strong>
        </div>
        <div>
          <span className="metric-label">Events persisted</span>
          <strong>{metrics.totalEvents.toLocaleString()}</strong>
        </div>
        <div>
          <span className="metric-label">Latest persisted event</span>
          <strong>{metrics.latestEventAt ? timeLabel(metrics.latestEventAt) : "—"}</strong>
          <span className="stat-sub">{ago(metrics.latestEventAt)}</span>
        </div>
        <div>
          <span className="metric-label">Aggregate through</span>
          <strong>
            {metrics.aggregate.latestBucket ? timeLabel(metrics.aggregate.latestBucket) : "not yet"}
          </strong>
          <span className="stat-sub">
            {metrics.aggregate.lagSeconds != null
              ? `${metrics.aggregate.lagSeconds}s behind newest event`
              : "waiting for first refresh"}
          </span>
        </div>
      </div>

      <EventsChart buckets={filled} />
      <EnergyChart buckets={filled} />

      <h3 className="chart-title">Votes by track · all time (SQL)</h3>
      {metrics.votesByTrack.length ? (
        <VotesBars rows={metrics.votesByTrack.map((r) => ({ label: titles.get(r.trackId) ?? r.trackId, value: r.votes }))} />
      ) : (
        <p className="host-sub">No votes persisted yet.</p>
      )}

      <details className="chart-table">
        <summary>Show data table</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Bucket</th>
              <th scope="col">Events</th>
              <th scope="col">Votes</th>
              <th scope="col">Taps</th>
              <th scope="col">Avg energy</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {metrics.buckets
              .slice()
              .reverse()
              .map((b) => (
                <tr key={b.bucket}>
                  <td>{timeLabel(b.bucket)}</td>
                  <td>{b.eventCount}</td>
                  <td>{b.votes}</td>
                  <td>{b.taps}</td>
                  <td>{b.avgEnergy ?? "—"}</td>
                  <td>{b.source}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

// ---------- Charts (inline SVG, single series each) ----------

const W = 600;
const H = 140;
const PAD = { top: 10, right: 36, bottom: 20, left: 30 };
const plotW = W - PAD.left - PAD.right;
const plotH = H - PAD.top - PAD.bottom;

function useHover() {
  const [hover, setHover] = useState<number | null>(null);
  return { hover, setHover };
}

function Axis({ max, ticks }: { max: number; ticks: number[] }) {
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  return (
    <g className="axis">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
          <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end">
            {t}
          </text>
        </g>
      ))}
    </g>
  );
}

function EventsChart({ buckets }: { buckets: (Bucket & { empty?: boolean })[] }) {
  const { hover, setHover } = useHover();
  const max = niceMax(Math.max(...buckets.map((b) => b.eventCount)));
  const slot = plotW / buckets.length;
  const barW = Math.min(24, Math.max(1, slot - 2)); // 2px surface gap between neighbors
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const h = hover != null ? buckets[hover] : null;
  const hasRaw = buckets.some((b) => b.source === "raw" && !b.empty && b.eventCount > 0);

  return (
    <figure className="chart">
      <figcaption className="chart-title">
        Events per 5 seconds · last 5 min
        {hasRaw && (
          <span className="chart-legend">
            <span className="key key-solid" aria-hidden /> Aggregate
            <span className="key key-hatch" aria-hidden /> Raw (not yet aggregated)
          </span>
        )}
      </figcaption>
      <div className="chart-frame">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Events per 5-second bucket over the last 5 minutes">
          <defs>
            <pattern id="hatch-raw" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" className="hatch-bg" />
              <line x1="0" y1="0" x2="0" y2="6" className="hatch-line" />
            </pattern>
          </defs>
          <Axis max={max} ticks={[0, max / 2, max]} />
          {buckets.map((b, i) => {
            if (!b.eventCount) return null;
            const x = PAD.left + i * slot + (slot - barW) / 2;
            const top = y(b.eventCount);
            const height = PAD.top + plotH - top;
            const r = Math.min(4, barW / 2, height);
            // Rounded data-end, square at the baseline.
            const d = `M${x},${PAD.top + plotH} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${PAD.top + plotH} Z`;
            return (
              <path
                key={b.bucket}
                d={d}
                className={`bar ${b.source === "raw" ? "bar-raw" : ""} ${hover === i ? "is-hover" : ""}`}
              />
            );
          })}
          <text x={PAD.left} y={H - 4} className="axis-label">
            {timeLabel(buckets[0].bucket)}
          </text>
          <text x={W - PAD.right} y={H - 4} textAnchor="end" className="axis-label">
            now
          </text>
          {buckets.map((b, i) => (
            <rect
              key={`hit-${b.bucket}`}
              x={PAD.left + i * slot}
              y={PAD.top}
              width={slot}
              height={plotH}
              className="hit"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          ))}
        </svg>
        {h && (
          <div className="chart-tip" style={{ left: `${((PAD.left + (hover! + 0.5) * slot) / W) * 100}%` }}>
            <strong>{timeLabel(h.bucket)}</strong>
            <span>{h.eventCount} events · {h.votes} votes · {h.taps} taps</span>
            <span className="tip-muted">{h.empty ? "no events" : h.source === "raw" ? "from raw rows" : "from aggregate"}</span>
          </div>
        )}
      </div>
    </figure>
  );
}

function EnergyChart({ buckets }: { buckets: (Bucket & { empty?: boolean })[] }) {
  const { hover, setHover } = useHover();
  const slot = plotW / buckets.length;
  const x = (i: number) => PAD.left + (i + 0.5) * slot;
  const y = (v: number) => PAD.top + plotH - (v / 100) * plotH;
  const pts = buckets.map((b, i) => (b.avgEnergy == null ? null : { i, v: b.avgEnergy }));

  // Break the line where samples are missing rather than drawing across gaps.
  const segments: { i: number; v: number }[][] = [];
  let cur: { i: number; v: number }[] = [];
  for (const p of pts) {
    if (p) cur.push(p);
    else if (cur.length) {
      segments.push(cur);
      cur = [];
    }
  }
  if (cur.length) segments.push(cur);
  const last = [...pts].reverse().find(Boolean) ?? null;
  const h = hover != null ? buckets[hover] : null;

  return (
    <figure className="chart">
      <figcaption className="chart-title">Engagement score · 5s average</figcaption>
      <div className="chart-frame">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Engagement score trend over the last 5 minutes">
          <Axis max={100} ticks={[0, 50, 100]} />
          {segments.map((seg, k) =>
            seg.length > 1 ? (
              <polyline
                key={k}
                className="line"
                points={seg.map((p) => `${x(p.i)},${y(p.v)}`).join(" ")}
              />
            ) : (
              <circle key={k} className="dot" cx={x(seg[0].i)} cy={y(seg[0].v)} r={4} />
            ),
          )}
          {last && (
            <>
              <circle className="dot" cx={x(last.i)} cy={y(last.v)} r={4} />
              <text x={x(last.i) + 8} y={y(last.v)} dy="0.32em" className="end-label">
                {last.v}
              </text>
            </>
          )}
          {hover != null && <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} />}
          {buckets.map((b, i) => (
            <rect
              key={`hit-${b.bucket}`}
              x={PAD.left + i * slot}
              y={PAD.top}
              width={slot}
              height={plotH}
              className="hit"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          ))}
        </svg>
        {h && (
          <div className="chart-tip" style={{ left: `${(x(hover!) / W) * 100}%` }}>
            <strong>{timeLabel(h.bucket)}</strong>
            <span>{h.avgEnergy == null ? "no sample" : `energy ${h.avgEnergy}`}</span>
          </div>
        )}
      </div>
    </figure>
  );
}

function VotesBars({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(...rows.map((r) => r.value));
  return (
    <ul className="votes-bars">
      {rows.map((r) => (
        <li key={r.label} title={`${r.label}: ${r.value} votes`}>
          <span className="votes-label">{r.label}</span>
          <span className="votes-track">
            <span className="votes-fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="votes-value">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}
