import pg from "pg";
import type { SessionMetrics } from "@crowdpulse/shared";
import { log } from "./log.js";

// TigerData (TimescaleDB) persistence. The database is part of the event flow:
// an event is only applied and broadcast after its row is written here.

export interface EventRecord {
  eventId: string;
  sessionId: string;
  participantId: string | null;
  eventType: PersistedEventType;
  value: number | null;
  metadata: Record<string, unknown>;
  time?: Date;
}

export type PersistedEventType =
  | "vote"
  | "track_analysis"
  | "track_rename"
  | "mood"
  | "tap"
  | "host_visual"
  | "track_advance"
  | "track_add"
  | "energy_sample"
  | "ai_recommendation"
  | "ai_decision"
  | "boost"
  | "session_reset"
  | "playback_mode"
  | "appearance"
  | "catalog_add"
  | "catalog_remove"
  | "catalog_clear"
  | "host_queue"
  | "unvote"
  | "highlight"
  | "playlist_save"
  | "playlist_delete"
  | "crowd_reset"
  | "stage_view";

export type PersistResult = "stored" | "duplicate";

type TigerMetrics = Extract<SessionMetrics, { persistence: "tigerdata" }>;
type MetricsBucket = TigerMetrics["buckets"][number];

const MIGRATIONS: { name: string; sql: string; optional?: boolean }[] = [
  {
    name: "extension",
    sql: "CREATE EXTENSION IF NOT EXISTS timescaledb",
    optional: true,
  },
  {
    // Matches Doc 03 §3, except session_id is TEXT because session codes are short slugs ("demo").
    name: "crowd_events",
    sql: `CREATE TABLE IF NOT EXISTS crowd_events (
      time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      event_id UUID NOT NULL,
      session_id TEXT NOT NULL,
      participant_id TEXT,
      event_type TEXT NOT NULL,
      value DOUBLE PRECISION,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (time, event_id)
    )`,
  },
  {
    // Hypertable unique keys must include the time column, so (time, event_id) cannot stop a
    // retry that arrives at a different time. This small table is the real dedup key.
    name: "event_ids",
    sql: `CREATE TABLE IF NOT EXISTS event_ids (
      event_id UUID PRIMARY KEY,
      session_id TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  },
  {
    // Global (cross-session) replay protection for Solana boost signatures.
    name: "boost_signatures",
    sql: `CREATE TABLE IF NOT EXISTS boost_signatures (
      signature TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      payer TEXT,
      lamports BIGINT NOT NULL,
      slot BIGINT,
      verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  },
  {
    name: "hypertable",
    sql: `SELECT create_hypertable('crowd_events', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE)`,
  },
  {
    name: "session_time_index",
    sql: "CREATE INDEX IF NOT EXISTS crowd_events_session_time_idx ON crowd_events (session_id, time DESC)",
  },
  {
    name: "crowd_metrics_5s",
    sql: `CREATE MATERIALIZED VIEW IF NOT EXISTS crowd_metrics_5s
      WITH (timescaledb.continuous, timescaledb.materialized_only = true) AS
      SELECT
        session_id,
        time_bucket(INTERVAL '5 seconds', time) AS bucket,
        COUNT(*) FILTER (WHERE event_type IN ('vote', 'mood', 'tap', 'boost')) AS event_count,
        COUNT(*) FILTER (WHERE event_type = 'vote') AS votes,
        COALESCE(SUM(value) FILTER (WHERE event_type = 'tap'), 0) AS taps,
        AVG(value) FILTER (WHERE event_type = 'energy_sample') AS avg_energy
      FROM crowd_events
      GROUP BY session_id, bucket
      WITH NO DATA`,
  },
  {
    name: "crowd_metrics_5s_policy",
    sql: `SELECT add_continuous_aggregate_policy('crowd_metrics_5s',
      start_offset => INTERVAL '1 hour',
      end_offset => INTERVAL '5 seconds',
      schedule_interval => INTERVAL '10 seconds',
      if_not_exists => TRUE)`,
  },
];

export class Database {
  private pool: pg.Pool;
  private healthy = false;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 5_000,
      query_timeout: 6_000,
      application_name: "crowdpulse-server",
    });
    this.pool.on("error", (err) => {
      this.healthy = false;
      log({ kind: "db.pool_error", message: err.message });
    });
  }

  get isHealthy(): boolean {
    return this.healthy;
  }

  async migrate(): Promise<void> {
    for (const m of MIGRATIONS) {
      try {
        await this.pool.query(m.sql);
      } catch (err) {
        const message = (err as Error).message;
        if (m.optional) {
          log({ kind: "db.migrate", step: m.name, outcome: "skipped", message });
          continue;
        }
        log({ kind: "db.migrate", step: m.name, outcome: "failed", message });
        throw err;
      }
    }
    this.healthy = true;
    log({ kind: "db.migrate", outcome: "ok" });
  }

  /**
   * Writes one event. Dedup and insert run in one transaction, so a retried
   * event ID is reported as "duplicate" and never produces a second row.
   */
  async persist(rec: EventRecord): Promise<PersistResult> {
    const client = await this.connect();
    // A checked-out client isn't covered by the pool's "error" handler. Without this, a dropped
    // network (Wi-Fi change, sleep) mid-write throws an unhandled error and kills the server.
    let broken: Error | undefined;
    const onError = (err: Error) => {
      broken = err;
      this.healthy = false;
      log({ kind: "db.client_error", message: err.message });
    };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      const fresh = await client.query(
        "INSERT INTO event_ids (event_id, session_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [rec.eventId, rec.sessionId],
      );
      if (fresh.rowCount === 0) {
        await client.query("ROLLBACK");
        return "duplicate";
      }
      await client.query(
        `INSERT INTO crowd_events (time, event_id, session_id, participant_id, event_type, value, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          rec.time ?? new Date(),
          rec.eventId,
          rec.sessionId,
          rec.participantId,
          rec.eventType,
          rec.value,
          rec.metadata,
        ],
      );
      await client.query("COMMIT");
      this.healthy = true;
      return "stored";
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      this.healthy = false;
      broken ??= err as Error;
      throw err;
    } finally {
      client.off("error", onError);
      // A connection that failed is discarded (release(err)) instead of going back to the pool.
      client.release(broken);
    }
  }

  /**
   * Claims a verified boost signature. Returns the existing claim if the signature
   * was already used (by any session), so replays never create a second boost.
   */
  async claimBoostSignature(claim: {
    signature: string;
    sessionId: string;
    trackId: string;
    intentId: string;
    payer: string | null;
    lamports: number;
    slot: number | null;
  }): Promise<{ claimed: true } | { claimed: false; sessionId: string; intentId: string }> {
    const ins = await this.pool.query(
      `INSERT INTO boost_signatures (signature, session_id, track_id, intent_id, payer, lamports, slot)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (signature) DO NOTHING`,
      [claim.signature, claim.sessionId, claim.trackId, claim.intentId, claim.payer, claim.lamports, claim.slot],
    );
    if (ins.rowCount === 1) return { claimed: true };
    const { rows } = await this.pool.query(
      "SELECT session_id, intent_id FROM boost_signatures WHERE signature = $1",
      [claim.signature],
    );
    return { claimed: false, sessionId: rows[0]?.session_id ?? "", intentId: rows[0]?.intent_id ?? "" };
  }

  /** Releases a claim if applying the boost failed afterwards. */
  async releaseBoostSignature(signature: string): Promise<void> {
    await this.pool.query("DELETE FROM boost_signatures WHERE signature = $1", [signature]);
  }

  /** All replayable events for a session, oldest first (energy samples are metrics only). */
  async loadEvents(sessionId: string): Promise<Required<EventRecord>[]> {
    const { rows } = await this.pool.query(
      `SELECT time, event_id, session_id, participant_id, event_type, value, metadata
       FROM crowd_events
       WHERE session_id = $1 AND event_type NOT IN ('energy_sample', 'ai_recommendation', 'ai_decision')
       ORDER BY time, event_id`,
      [sessionId],
    );
    return rows.map((r) => ({
      time: r.time,
      eventId: r.event_id,
      sessionId: r.session_id,
      participantId: r.participant_id,
      eventType: r.event_type,
      value: r.value,
      metadata: r.metadata,
    }));
  }

  async metrics(sessionId: string, windowMinutes = 5): Promise<TigerMetrics> {
    const t0 = performance.now();
    const window = `${Math.max(1, Math.min(60, windowMinutes))} minutes`;

    // Counts cover the current run only (since the last host reset); time buckets use the window.
    const since: Date = await this.pool
      .query(
        `SELECT COALESCE(MAX(time), '-infinity'::timestamptz) AS since
         FROM crowd_events WHERE session_id = $1 AND event_type = 'session_reset'`,
        [sessionId],
      )
      .then((r) => r.rows[0].since);

    const [summary, byTrack, agg] = await Promise.all([
      this.pool.query(
        `SELECT
           MAX(time) AS latest,
           COUNT(*) FILTER (WHERE time > NOW() - INTERVAL '10 seconds') AS last10s,
           COUNT(*) AS total
         FROM crowd_events
         WHERE session_id = $1 AND event_type IN ('vote', 'mood', 'tap', 'boost') AND time > $2`,
        [sessionId, since],
      ),
      // Open votes per track, matching the live queue: votes since the last reset and since the
      // track last started playing (playing a track clears its votes).
      this.pool.query(
        `WITH plays AS (
           SELECT metadata->>'trackId' AS track_id, MAX(time) AS played_at
           FROM crowd_events
           WHERE session_id = $1 AND event_type = 'track_advance' AND time > $2
           GROUP BY 1
         ),
         -- Each person's latest vote / unvote per track decides whether their vote still counts.
         latest AS (
           SELECT DISTINCT ON (v.participant_id, v.metadata->>'trackId')
             v.metadata->>'trackId' AS track_id, v.event_type
           FROM crowd_events v
           LEFT JOIN plays p ON p.track_id = v.metadata->>'trackId'
           WHERE v.session_id = $1 AND v.event_type IN ('vote', 'unvote') AND v.time > $2
             AND (p.played_at IS NULL OR v.time > p.played_at)
           ORDER BY v.participant_id, v.metadata->>'trackId', v.time DESC
         )
         SELECT track_id, COUNT(*)::int AS votes
         FROM latest WHERE event_type = 'vote'
         GROUP BY 1 ORDER BY votes DESC, track_id`,
        [sessionId, since],
      ),
      this.pool.query(
        `SELECT bucket, event_count, votes, taps, avg_energy
         FROM crowd_metrics_5s
         WHERE session_id = $1 AND bucket > NOW() - $2::interval
         ORDER BY bucket`,
        [sessionId, window],
      ),
    ]);

    const latestMaterialized: Date | null = await this.pool
      .query(`SELECT MAX(bucket) AS b FROM crowd_metrics_5s WHERE session_id = $1`, [sessionId])
      .then((r) => r.rows[0]?.b ?? null);

    // Buckets newer than the aggregate's last materialized bucket come from raw rows.
    const raw = await this.pool.query(
      `SELECT
         time_bucket(INTERVAL '5 seconds', time) AS bucket,
         COUNT(*) FILTER (WHERE event_type IN ('vote', 'mood', 'tap', 'boost')) AS event_count,
         COUNT(*) FILTER (WHERE event_type = 'vote') AS votes,
         COALESCE(SUM(value) FILTER (WHERE event_type = 'tap'), 0) AS taps,
         AVG(value) FILTER (WHERE event_type = 'energy_sample') AS avg_energy
       FROM crowd_events
       WHERE session_id = $1
         AND time > NOW() - $2::interval
         AND ($3::timestamptz IS NULL OR time >= $3::timestamptz + INTERVAL '5 seconds')
       GROUP BY 1 ORDER BY 1`,
      [sessionId, window, latestMaterialized],
    );

    const toBucket = (source: MetricsBucket["source"]) => (r: Record<string, unknown>): MetricsBucket => ({
      bucket: (r.bucket as Date).toISOString(),
      eventCount: Number(r.event_count),
      votes: Number(r.votes),
      taps: Number(r.taps),
      avgEnergy: r.avg_energy == null ? null : Math.round(Number(r.avg_energy)),
      source,
    });

    const latest: Date | null = summary.rows[0]?.latest ?? null;
    const lagSeconds =
      latest && latestMaterialized
        ? Math.max(0, Math.round((latest.getTime() - (latestMaterialized.getTime() + 5_000)) / 1000))
        : null;

    return {
      persistence: "tigerdata",
      generatedAt: new Date().toISOString(),
      queryMs: +(performance.now() - t0).toFixed(1),
      latestEventAt: latest?.toISOString() ?? null,
      eventsLast10s: Number(summary.rows[0]?.last10s ?? 0),
      totalEvents: Number(summary.rows[0]?.total ?? 0),
      votesByTrack: byTrack.rows.map((r) => ({ trackId: r.track_id, votes: r.votes })),
      buckets: [...agg.rows.map(toBucket("aggregate")), ...raw.rows.map(toBucket("raw"))],
      aggregate: {
        latestBucket: latestMaterialized?.toISOString() ?? null,
        lagSeconds,
      },
    };
  }

  /** Test helper: force-refresh the aggregate for a window (CALL cannot run in a transaction). */
  async refreshAggregate(from: Date, to: Date): Promise<void> {
    await this.pool.query("CALL refresh_continuous_aggregate('crowd_metrics_5s', $1, $2)", [from, to]);
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      this.healthy = true;
    } catch {
      this.healthy = false;
    }
    return this.healthy;
  }

  /** Test helper: remove a session's rows. */
  async deleteSession(sessionId: string): Promise<void> {
    await this.pool.query("DELETE FROM crowd_events WHERE session_id = $1", [sessionId]);
    await this.pool.query("DELETE FROM event_ids WHERE session_id = $1", [sessionId]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async connect() {
    try {
      return await this.pool.connect();
    } catch (err) {
      this.healthy = false;
      throw err;
    }
  }
}
