import { randomUUID } from "node:crypto";
import {
  DEMO_TRACKS,
  MOODS,
  type LatestEvent,
  type Mood,
  type QueueItem,
  type SessionState,
  type Track,
  type VisualState,
  type VisualTheme,
} from "@crowdpulse/shared";
import type { EventRecord, PersistResult } from "./db.js";
import { log } from "./log.js";

const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 30;
const ACTIVITY_WINDOW_MS = 30_000;
const MAX_SEEN_EVENTS = 20_000;
const QUEST_BASE_GOAL = 100;

// Weights feeding the activity half of the energy score.
const ACTIVITY_WEIGHT = { vote: 3, mood: 2, tap: 1 } as const;
// Mood energies feeding the mood half of the energy score.
const MOOD_ENERGY: Record<Mood, number> = {
  chill: 20,
  focused: 45,
  hyped: 80,
  wild: 100,
};

// Shared by every session so the server restart is visible to clients.
const EPOCH = randomUUID();

function themeForEnergy(energy: number, mood?: Mood): VisualTheme {
  if (mood === "chill" || energy < 25) return "calm_waves";
  if (mood === "focused" || energy < 50) return "electric_blue";
  if (mood === "wild" || energy >= 80) return "neon_pulse";
  return "sunset";
}

function intensityForEnergy(energy: number): number {
  return Math.max(0.15, Math.min(1, energy / 100));
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export type EventOutcome =
  | { status: "accepted" | "duplicate"; state: SessionState }
  | { status: "rejected"; reason: string; httpStatus: number };

type CatalogTrack = Omit<Track, "votes" | "status">;
type Rejection = Extract<EventOutcome, { status: "rejected" }>;
type Plan = {
  record: Pick<EventRecord, "eventType" | "value" | "metadata">;
  reservation?: string;
  commit: () => { weight: number; event: Omit<LatestEvent, "at"> };
};

/** Writes one event durably. The default (no database) accepts everything in memory. */
export type Persist = (rec: EventRecord) => Promise<PersistResult>;
const memoryOnly: Persist = async () => "stored";

export interface SessionOptions {
  catalog?: CatalogTrack[];
  now?: () => number;
  persist?: Persist;
}

export class SessionStore {
  readonly sessionId: string;
  readonly sessionName: string;
  private catalog: CatalogTrack[];
  private votes = new Map<string, Set<string>>(); // trackId -> participantIds
  private lastPlayedAt = new Map<string, number>();
  private nowPlaying: CatalogTrack | null = null;
  private moods = new Map<string, Mood>(); // participantId -> latest mood
  private participants = new Set<string>();
  private seenEventIds = new Set<string>();
  private inflight = new Set<string>();
  private reservations = new Set<string>();
  private clientHits = new Map<string, number[]>();
  private activity: { at: number; weight: number }[] = [];
  private questLevel = 1;
  private questProgress = 0;
  private hostVisual: VisualState | null = null;
  private energyScore = 0;
  private version = 0;
  private updatedAt: number;
  private latestEvent: LatestEvent | null;
  private listeners = new Set<() => void>();
  private now: () => number;
  private persist: Persist;

  constructor(sessionId: string, sessionName: string, options: SessionOptions = {}) {
    const now = options.now ?? Date.now;
    this.sessionId = sessionId;
    this.sessionName = sessionName;
    this.catalog = options.catalog ?? DEMO_TRACKS;
    this.persist = options.persist ?? memoryOnly;
    this.now = now;
    this.updatedAt = now();
    this.latestEvent = {
      type: "session.ready",
      message: "Session live — waiting for the crowd",
      at: new Date(now()).toISOString(),
    };
    this.recomputeEnergy();
  }

  /** Called after every accepted state change (used for WebSocket broadcast). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): SessionState {
    const queue = this.buildQueue();
    const queued = new Set(queue.map((q) => q.trackId));
    return {
      type: "session.state",
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      epoch: EPOCH,
      version: this.version,
      energyScore: this.energyScore,
      participants: this.participants.size,
      nowPlaying: this.nowPlaying ? this.toQueueItem(this.nowPlaying) : null,
      queue,
      tracks: this.catalog.map((t) => ({
        ...t,
        votes: this.voteCount(t.id),
        status:
          this.nowPlaying?.id === t.id
            ? "playing"
            : queued.has(t.id)
              ? "queued"
              : "open",
      })),
      moods: this.moodTally(),
      visualState: this.hostVisual ?? {
        theme: themeForEnergy(this.energyScore, this.dominantMood()),
        intensity: intensityForEnergy(this.energyScore),
      },
      visualMode: this.hostVisual ? "host" : "auto",
      crowdQuest: {
        label: `Quest ${this.questLevel}: send ${this.questGoal()} hype taps`,
        progress: this.questProgress,
        goal: this.questGoal(),
      },
      latestEvent: this.latestEvent,
      updatedAt: new Date(this.updatedAt).toISOString(),
    };
  }

  submitVote(input: {
    trackId: string;
    eventId: string;
    participantId: string;
  }): Promise<EventOutcome> {
    return this.handleEvent(input, () => {
      const track = this.catalog.find((t) => t.id === input.trackId);
      if (!track) return this.reject("Unknown track ID", 400);
      if (this.nowPlaying?.id === track.id) {
        return this.reject("Track is already playing", 409);
      }
      if (this.votes.get(track.id)?.has(input.participantId)) {
        return this.reject("Already voted for this track", 409);
      }
      return {
        // Held while the write is in flight so a concurrent double-vote can't slip through.
        reservation: `vote:${input.participantId}:${track.id}`,
        record: { eventType: "vote", value: 1, metadata: { trackId: track.id } },
        commit: () => {
          this.applyVote(track.id, input.participantId);
          return {
            weight: ACTIVITY_WEIGHT.vote,
            event: { type: "vote.accepted", message: `Vote locked for ${track.title}` },
          };
        },
      };
    });
  }

  recordMood(input: {
    mood: Mood;
    eventId: string;
    participantId: string;
  }): Promise<EventOutcome> {
    return this.handleEvent(input, () => ({
      record: { eventType: "mood", value: null, metadata: { mood: input.mood } },
      commit: () => {
        this.moods.set(input.participantId, input.mood);
        return {
          weight: ACTIVITY_WEIGHT.mood,
          event: { type: "mood.selected", message: `Someone is feeling ${input.mood}` },
        };
      },
    }));
  }

  recordTaps(input: {
    count: number;
    eventId: string;
    participantId: string;
  }): Promise<EventOutcome> {
    return this.handleEvent(input, () => ({
      record: { eventType: "tap", value: input.count, metadata: {} },
      commit: () => {
        const completed = this.applyTaps(input.count);
        return {
          weight: ACTIVITY_WEIGHT.tap * input.count,
          event: completed
            ? { type: "quest.complete", message: `Quest ${completed.level} complete! ${completed.goal} hype taps` }
            : { type: "tap.batch", message: `+${input.count} hype` },
        };
      },
    }));
  }

  /** Host action. `null` returns the stage to auto (energy-driven) mode. */
  async setVisual(visual: VisualState | null): Promise<EventOutcome> {
    const next = visual
      ? { theme: visual.theme, intensity: clamp(visual.intensity, 0, 1) }
      : null;
    const saved = await this.persistHostAction("host_visual", { visual: next });
    if (saved) return saved;
    this.hostVisual = next;
    this.change({
      type: "visual.set",
      message: next
        ? `Host set ${next.theme.replaceAll("_", " ")} @ ${Math.round(next.intensity * 100)}%`
        : "Stage visuals follow the crowd again",
    });
    return { status: "accepted", state: this.getState() };
  }

  /** Host action: play the top-voted track next. */
  async advance(): Promise<EventOutcome> {
    const [next] = this.buildQueue();
    if (!next) return this.reject("Queue is empty — no votes yet", 409);
    const saved = await this.persistHostAction("track_advance", { trackId: next.trackId });
    if (saved) return saved;
    const title = this.applyAdvance(next.trackId, this.now());
    this.change({ type: "track.playing", message: `Now playing ${title}` });
    return { status: "accepted", state: this.getState() };
  }

  /** Periodic tick so energy decays as activity ages out. Returns true if state changed. */
  tick(): boolean {
    const before = this.energyScore;
    this.recomputeEnergy();
    if (this.energyScore === before) return false;
    this.bump();
    return true;
  }

  /** Writes the current energy score as a metrics-only sample (not replayed). */
  async sampleEnergy(): Promise<void> {
    await this.persist({
      eventId: randomUUID(),
      sessionId: this.sessionId,
      participantId: null,
      eventType: "energy_sample",
      value: this.energyScore,
      metadata: {},
    });
  }

  /** Rebuilds state from persisted events (oldest first) after a restart. */
  replay(records: Required<EventRecord>[]): number {
    let applied = 0;
    for (const r of records) {
      const at = r.time.getTime();
      const meta = r.metadata as Record<string, unknown>;
      this.markSeen(r.eventId);
      if (r.participantId) this.participants.add(r.participantId);
      switch (r.eventType) {
        case "vote":
          if (typeof meta.trackId === "string" && r.participantId) {
            this.applyVote(meta.trackId, r.participantId);
            this.activity.push({ at, weight: ACTIVITY_WEIGHT.vote });
          }
          break;
        case "mood":
          if (r.participantId && MOODS.includes(meta.mood as Mood)) {
            this.moods.set(r.participantId, meta.mood as Mood);
            this.activity.push({ at, weight: ACTIVITY_WEIGHT.mood });
          }
          break;
        case "tap":
          this.applyTaps(Number(r.value) || 0);
          this.activity.push({ at, weight: ACTIVITY_WEIGHT.tap * (Number(r.value) || 0) });
          break;
        case "host_visual":
          this.hostVisual = (meta.visual as VisualState | null) ?? null;
          break;
        case "track_advance":
          if (typeof meta.trackId === "string") this.applyAdvance(meta.trackId, at);
          break;
        default:
          continue;
      }
      applied += 1;
    }
    if (applied) {
      this.change({
        type: "session.restored",
        message: `Restored ${applied} events from TigerData`,
      });
    }
    return applied;
  }

  /**
   * Validate → dedupe → rate-limit → plan → persist → apply → broadcast.
   * State only changes after the database confirms the write.
   */
  private async handleEvent(
    input: { eventId: string; participantId: string },
    plan: () => Plan | Rejection,
  ): Promise<EventOutcome> {
    // Idempotency: a retried event ID returns current state without being counted again.
    if (this.seenEventIds.has(input.eventId) || this.inflight.has(input.eventId)) {
      return { status: "duplicate", state: this.getState() };
    }
    if (!this.allowRequest(input.participantId)) {
      return this.reject("Rate limit exceeded", 429);
    }
    const p = plan();
    if ("status" in p) return p;
    if (p.reservation && this.reservations.has(p.reservation)) {
      return this.reject("Already voted for this track", 409);
    }

    this.inflight.add(input.eventId);
    if (p.reservation) this.reservations.add(p.reservation);
    let result: PersistResult;
    try {
      result = await this.persist({
        eventId: input.eventId,
        sessionId: this.sessionId,
        participantId: input.participantId,
        ...p.record,
      });
    } catch (err) {
      log({ kind: "db.persist_failed", sessionId: this.sessionId, eventId: input.eventId, message: (err as Error).message });
      return this.reject("Could not save event — please retry", 503);
    } finally {
      this.inflight.delete(input.eventId);
      if (p.reservation) this.reservations.delete(p.reservation);
    }

    this.markSeen(input.eventId);
    if (result === "duplicate") return { status: "duplicate", state: this.getState() };

    const { weight, event } = p.commit();
    this.participants.add(input.participantId);
    this.activity.push({ at: this.now(), weight });
    this.change(event);
    return { status: "accepted", state: this.getState() };
  }

  /** Returns a rejection if the host action could not be saved; otherwise null. */
  private async persistHostAction(
    eventType: "host_visual" | "track_advance",
    metadata: Record<string, unknown>,
  ): Promise<Rejection | null> {
    try {
      await this.persist({
        eventId: randomUUID(),
        sessionId: this.sessionId,
        participantId: null,
        eventType,
        value: null,
        metadata,
      });
      return null;
    } catch (err) {
      log({ kind: "db.persist_failed", sessionId: this.sessionId, eventType, message: (err as Error).message });
      return this.reject("Could not save host action — please retry", 503);
    }
  }

  private applyVote(trackId: string, participantId: string) {
    const voters = this.votes.get(trackId) ?? new Set<string>();
    voters.add(participantId);
    this.votes.set(trackId, voters);
  }

  /** Returns the completed quest, if these taps finished one. */
  private applyTaps(count: number): { level: number; goal: number } | null {
    this.questProgress += count;
    const goal = this.questGoal();
    if (this.questProgress < goal) return null;
    const level = this.questLevel;
    this.questLevel += 1;
    this.questProgress = 0;
    return { level, goal };
  }

  /** Returns the new track's title. */
  private applyAdvance(trackId: string, at: number): string {
    const track = this.catalog.find((t) => t.id === trackId);
    if (!track) return trackId;
    if (this.nowPlaying) this.lastPlayedAt.set(this.nowPlaying.id, at);
    this.nowPlaying = track;
    this.votes.delete(track.id);
    return track.title;
  }

  private markSeen(eventId: string) {
    this.seenEventIds.add(eventId);
    if (this.seenEventIds.size > MAX_SEEN_EVENTS) {
      // Sets iterate in insertion order, so this evicts the oldest event ID.
      this.seenEventIds.delete(this.seenEventIds.values().next().value!);
    }
  }

  private reject(reason: string, httpStatus: number): Rejection {
    return { status: "rejected", reason, httpStatus };
  }

  private change(event: Omit<LatestEvent, "at">) {
    this.latestEvent = { ...event, at: new Date(this.now()).toISOString() };
    this.recomputeEnergy();
    this.bump();
  }

  private bump() {
    this.version += 1;
    this.updatedAt = this.now();
    for (const listener of this.listeners) listener();
  }

  // Energy = 60% recent activity (last 30s, saturating) + 40% crowd mood (neutral 50 if none).
  private recomputeEnergy() {
    const cutoff = this.now() - ACTIVITY_WINDOW_MS;
    this.activity = this.activity.filter((a) => a.at >= cutoff);
    const weighted = this.activity.reduce((sum, a) => sum + a.weight, 0);
    const activityScore = Math.min(100, weighted * 2);
    const moods = [...this.moods.values()];
    const moodScore = moods.length
      ? moods.reduce((sum, m) => sum + MOOD_ENERGY[m], 0) / moods.length
      : 50;
    this.energyScore = Math.round(0.6 * activityScore + 0.4 * moodScore);
  }

  private allowRequest(clientKey: string): boolean {
    const now = this.now();
    const hits = (this.clientHits.get(clientKey) ?? []).filter(
      (t) => now - t < RATE_WINDOW_MS,
    );
    if (hits.length >= RATE_LIMIT) {
      this.clientHits.set(clientKey, hits);
      return false;
    }
    hits.push(now);
    this.clientHits.set(clientKey, hits);
    return true;
  }

  // Tracks with votes, ordered by votes desc, then least-recently-played, then catalog order.
  private buildQueue(): QueueItem[] {
    return this.catalog
      .map((t, idx) => ({ t, idx, votes: this.voteCount(t.id) }))
      .filter(({ t, votes }) => votes > 0 && t.id !== this.nowPlaying?.id)
      .sort(
        (a, b) =>
          b.votes - a.votes ||
          (this.lastPlayedAt.get(a.t.id) ?? 0) - (this.lastPlayedAt.get(b.t.id) ?? 0) ||
          a.idx - b.idx,
      )
      .slice(0, 5)
      .map(({ t }) => this.toQueueItem(t));
  }

  private voteCount(trackId: string): number {
    return this.votes.get(trackId)?.size ?? 0;
  }

  private toQueueItem(t: CatalogTrack): QueueItem {
    return { trackId: t.id, title: t.title, artist: t.artist, votes: this.voteCount(t.id) };
  }

  private questGoal(): number {
    return QUEST_BASE_GOAL * this.questLevel;
  }

  private dominantMood(): Mood | undefined {
    const tally = this.moodTally();
    const top = (Object.entries(tally) as [Mood, number][]).sort(
      (a, b) => b[1] - a[1],
    )[0];
    if (!top || top[1] === 0) return undefined;
    return top[0];
  }

  private moodTally(): Record<Mood, number> {
    const tally = Object.fromEntries(MOODS.map((m) => [m, 0])) as Record<Mood, number>;
    for (const m of this.moods.values()) tally[m] += 1;
    return tally;
  }
}
