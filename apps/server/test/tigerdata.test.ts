import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../src/db.js";
import { SessionStore } from "../src/session.js";

// Runs against the real TigerData service in DATABASE_URL, using throwaway session IDs.
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("TigerData integration (Doc 03)", () => {
  let db: Database;
  const sessionA = `test-a-${randomUUID().slice(0, 8)}`;
  const sessionB = `test-b-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    db = new Database(url!);
    await db.migrate();
  });

  afterAll(async () => {
    await db.deleteSession(sessionA);
    await db.deleteSession(sessionB);
    await db.close();
  });

  const rec = (sessionId: string, overrides: Record<string, unknown> = {}) => ({
    eventId: randomUUID(),
    sessionId,
    participantId: "participant_test",
    eventType: "vote" as const,
    value: 1,
    metadata: { trackId: "track_01" },
    ...overrides,
  });

  it("TD-01/02: inserts an event with the right timestamp, session, type, and ID", async () => {
    const r = rec(sessionA);
    expect(await db.persist(r)).toBe("stored");
    const rows = await db.loadEvents(sessionA);
    const row = rows.find((x) => x.eventId === r.eventId)!;
    expect(row).toMatchObject({ sessionId: sessionA, eventType: "vote", participantId: "participant_test" });
    expect(Math.abs(row.time.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("TD-03: the same event ID is stored once, even when retried later", async () => {
    const r = rec(sessionA);
    expect(await db.persist(r)).toBe("stored");
    expect(await db.persist({ ...r, time: new Date(Date.now() + 1000) })).toBe("duplicate");
    const rows = (await db.loadEvents(sessionA)).filter((x) => x.eventId === r.eventId);
    expect(rows).toHaveLength(1);
  });

  it("TD-04: continuous aggregate matches known events in one bucket", async () => {
    // Five-second-aligned bucket two minutes ago, inside the refresh window.
    const bucket = new Date(Math.floor((Date.now() - 120_000) / 5000) * 5000);
    const at = (ms: number) => new Date(bucket.getTime() + ms);
    await db.persist(rec(sessionB, { time: at(100) }));
    await db.persist(rec(sessionB, { time: at(200) }));
    await db.persist(rec(sessionB, { time: at(300), eventType: "tap", value: 7, metadata: {} }));
    await db.persist(rec(sessionB, { time: at(400), eventType: "energy_sample", value: 40, participantId: null, metadata: {} }));
    await db.persist(rec(sessionB, { time: at(500), eventType: "energy_sample", value: 60, participantId: null, metadata: {} }));

    await db.refreshAggregate(new Date(bucket.getTime() - 5000), new Date(bucket.getTime() + 10_000));
    const m = await db.metrics(sessionB, 10);
    const b = m.buckets.find((x) => x.bucket === bucket.toISOString())!;
    expect(b).toMatchObject({ source: "aggregate", eventCount: 3, votes: 2, taps: 7, avgEnergy: 50 });
  });

  it("TD-05: newest events show up from raw rows before the aggregate refreshes", async () => {
    const r = rec(sessionB);
    await db.persist(r);
    const m = await db.metrics(sessionB);
    expect(m.latestEventAt).not.toBeNull();
    expect(Date.now() - Date.parse(m.latestEventAt!)).toBeLessThan(10_000);
    expect(m.eventsLast10s).toBeGreaterThanOrEqual(1);
    expect(m.buckets.at(-1)?.source).toBe("raw");
  });

  it("TD-06: metrics for one session do not include another session's events", async () => {
    const a = await db.metrics(sessionA, 10);
    const b = await db.metrics(sessionB, 10);
    const aIds = new Set((await db.loadEvents(sessionA)).map((x) => x.eventId));
    const bIds = (await db.loadEvents(sessionB)).map((x) => x.eventId);
    expect(bIds.some((id) => aIds.has(id))).toBe(false);
    // Both test votes come from the same participant; one person counts once (as in the live queue).
    expect(a.votesByTrack).toEqual([{ trackId: "track_01", votes: 1 }]);
    expect(b.totalEvents).toBe(4); // 3 bucketed + 1 recent; energy samples excluded
  });

  it("a restart skips run-only events from before the last reset, but keeps the library", async () => {
    const id = `test-r-${randomUUID().slice(0, 8)}`;
    try {
      const live = new SessionStore(id, "Reset test", { persist: db.persist.bind(db) });
      await live.submitVote({ trackId: "track_03", eventId: randomUUID(), participantId: "participant_r1" });
      await live.addTrack({ id: "sp_4uLU6hMCjMI75M1A2tKUQC", title: "Kept", artist: "A", genre: "pop", bpm: 120, energy: 0.5, spotifyUri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC" });
      await live.reset();
      await live.submitVote({ trackId: "track_04", eventId: randomUUID(), participantId: "participant_r1" });
      const rows = await db.loadEvents(id);
      expect(rows.some((r) => r.eventType === "vote" && (r.metadata as { trackId?: string }).trackId === "track_03")).toBe(false);
      expect(rows.some((r) => r.eventType === "vote" && (r.metadata as { trackId?: string }).trackId === "track_04")).toBe(true);
      const restored = new SessionStore(id, "Reset test");
      restored.replay(rows);
      expect(restored.getState().tracks.some((t) => t.title === "Kept")).toBe(true);
      expect(restored.getState().tracks.filter((t) => t.votes).map((t) => t.id)).toEqual(live.getState().tracks.filter((t) => t.votes).map((t) => t.id));
      // Times are strictly increasing, so replay order is the order things happened.
      const times = rows.map((r) => r.time.getTime());
      expect(new Set(times).size).toBe(times.length);
    } finally {
      await db.deleteSession(id);
    }
  });

  it("open votes by track match the live queue: votes for a track that played are excluded", async () => {
    const id = `test-q-${randomUUID().slice(0, 8)}`;
    try {
      const live = new SessionStore(id, "Queue test", { persist: db.persist.bind(db) });
      await live.submitVote({ trackId: "track_02", eventId: randomUUID(), participantId: "participant_q1" });
      await live.submitVote({ trackId: "track_02", eventId: randomUUID(), participantId: "participant_q2" });
      await live.submitVote({ trackId: "track_05", eventId: randomUUID(), participantId: "participant_q1" });
      await live.advance("track_02"); // clears track_02's votes live
      await live.advance("track_07"); // track_02 finished; it can be voted for again
      await live.submitVote({ trackId: "track_02", eventId: randomUUID(), participantId: "participant_q3" }); // new round
      const m = await db.metrics(id);
      const fromSql = Object.fromEntries(m.votesByTrack.map((r) => [r.trackId, r.votes]));
      const fromLive = Object.fromEntries(live.getState().tracks.filter((t) => t.votes).map((t) => [t.id, t.votes]));
      expect(fromSql).toEqual(fromLive);
      expect(fromSql).toEqual({ track_02: 1, track_05: 1 });
    } finally {
      await db.deleteSession(id);
    }
  });

  it("restores a session from TigerData after a restart", async () => {
    const id = `test-r-${randomUUID().slice(0, 8)}`;
    try {
      const live = new SessionStore(id, "Restart test", { persist: db.persist.bind(db) });
      await live.submitVote({ trackId: "track_03", eventId: randomUUID(), participantId: "participant_x1" });
      await live.recordEnergy({ energy: 75, eventId: randomUUID(), participantId: "participant_x1" });
      const restored = new SessionStore(id, "Restart test");
      restored.replay(await db.loadEvents(id));
      expect(restored.getState().tracks).toEqual(live.getState().tracks);
      expect(restored.getState().crowdEnergy.average).toBe(live.getState().crowdEnergy.average);
      expect(restored.getState().crowdEnergy.count).toBe(live.getState().crowdEnergy.count);
    } finally {
      await db.deleteSession(id);
    }
  });

  it("TD-08: controlled burst — records insert rate and query latency", async () => {
    const id = `test-load-${randomUUID().slice(0, 8)}`;
    try {
      const N = 200;
      const t0 = performance.now();
      const results = await Promise.allSettled(
        Array.from({ length: N }, () => db.persist(rec(id))),
      );
      const insertMs = performance.now() - t0;
      const errors = results.filter((r) => r.status === "rejected").length;
      const q0 = performance.now();
      await db.metrics(id);
      const queryMs = performance.now() - q0;
      console.log(
        `TD-08: ${N} inserts (pool of 10) in ${insertMs.toFixed(0)} ms ≈ ${(N / (insertMs / 1000)).toFixed(0)}/s, ` +
          `errors ${errors}, metrics query ${queryMs.toFixed(0)} ms`,
      );
      expect(errors).toBe(0);
    } finally {
      await db.deleteSession(id);
    }
  });
});
