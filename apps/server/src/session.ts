import { randomUUID } from "node:crypto";
import {
  BOOST_VOTE_WEIGHT,
  MAX_CATALOG_TRACKS,
  MAX_PLAYLISTS,
  MAX_VOTES_PER_PERSON,
  type Playlist,
  type PlaylistSummary,
  type PlaylistTrack,
  DEFAULT_HIGHLIGHTS,
  HIGHLIGHT_CLIP_SECONDS,
  HIGHLIGHT_PARTS,
  type Highlight,
  type HighlightPart,
  type HighlightSettings,
  GENRE_PATTERN,
  type ParticipantState,
  DEMO_TRACKS,
  MAX_BOOSTS_PER_TRACK,
  MOODS,
  APPEARANCE_PRESETS,
  DEFAULT_APPEARANCE,
  DEFAULT_STAGE_VIEW,
  type StageView,
  type Appearance,
  type LatestEvent,
  type PlaybackMode,
  type PlaybackReportEvent,
  type PlaybackState,
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
/** A player page counts as online if it reported within this window. */
const PLAYER_ONLINE_MS = 15_000;

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

type CatalogTrack = import("./catalog.js").CatalogTrack;

/** Participant IDs from the demo crowd simulator start with this; the UI labels them "Demo data". */
export const SIMULATED_PREFIX = "sim_";
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

/** Auto mode stops skipping ahead after this many songs in a row fail to play. */
export const MAX_AUTO_FAILURES = 3;
const SEEK_GRACE_MS = 5_000;
const PRESET_LABEL: Record<string, string> = { sky: "Blue", flamingo: "Pink", mint: "Green", lemon: "Yellow", lavender: "Purple" };

/** ⏮ restarts the current song if it's further in than this; otherwise goes to the previous one. */
const RESTART_THRESHOLD_MS = 5_000;

/** Keep only valid highlight settings (unknown values fall back to the defaults). */
export function sanitizeHighlights(raw: unknown): HighlightSettings {
  const r = (raw ?? {}) as Partial<HighlightSettings>;
  return {
    enabled: r.enabled === true,
    clipSec: (HIGHLIGHT_CLIP_SECONDS as readonly number[]).includes(r.clipSec as number) ? (r.clipSec as HighlightSettings["clipSec"]) : DEFAULT_HIGHLIGHTS.clipSec,
    // The host no longer picks a part: Gemini finds each song's best section ("auto").
    part: "auto",
    transition: r.transition === "cut" ? "cut" : "fade",
  };
}

/** How many "auto" entries to show when the queue is empty. */
const AUTO_NEXT_SIZE = 5;

export class SessionStore {
  readonly sessionId: string;
  readonly sessionName: string;
  private catalog: CatalogTrack[];
  private votes = new Map<string, Set<string>>(); // trackId -> participantIds
  private boosts = new Map<string, number>(); // trackId -> verified boosts since it last played
  private lastPlayedAt = new Map<string, number>();
  private nowPlaying: CatalogTrack | null = null;
  private moods = new Map<string, Mood>(); // participantId -> latest mood
  private genres = new Map<string, string>(); // participantId -> genre picked when joining
  /** Phones that joined this run (kept when the host resets the crowd mood, so nobody is sent back). */
  private joined = new Set<string>();
  private participants = new Set<string>();
  private seenEventIds = new Set<string>();
  /** Events being saved right now, so a retry can wait for the real result. */
  private inflight = new Map<string, Promise<EventOutcome>>();
  private reservations = new Set<string>();
  private plays = new Map<string, number>(); // trackId -> times started playing this run
  private run = 1;
  // Concurrency gate: events run concurrently; host actions run alone (see exclusive()).
  private activeEvents = 0;
  private exclusiveLock: Promise<void> | null = null;
  private idleWaiters: (() => void)[] = [];
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
  private energyHistory: { at: number; score: number }[] = [];
  private playbackMode: PlaybackMode = "dj";
  private repeat = false;
  private highlightSettings: HighlightSettings = { ...DEFAULT_HIGHLIGHTS };
  /** Each song's highlight start, per part ("trackId|part"). Saved and replayed. */
  private highlightCache = new Map<string, Highlight>();
  /** The host's saved playlists (survive new runs and restarts). */
  private playlists = new Map<string, Playlist>();
  private appearance: Appearance = DEFAULT_APPEARANCE;
  private stageView: StageView = { ...DEFAULT_STAGE_VIEW };
  private playback: Omit<PlaybackState, "mode" | "repeat" | "highlights" | "playerOnline"> = {
    status: "idle",
    trackId: null,
    round: 0,
    startedAt: null,
    durationMs: null,
    source: null,
    message: null,
    seekSeq: 0,
    playerId: null,
    pausedPositionMs: null,
    clipStartMs: null,
    clipEndMs: null,
  };
  private playerLastSeen = 0;
  /** Songs played before the current one (newest last), for ⏮ Previous. Rebuilt on replay. */
  private playHistory: string[] = [];
  /** Host-ordered queue (track ids). Plays before voted songs. Saved and replayed. */
  private hostQueue: string[] = [];
  /** Songs in a row the player couldn't play; auto mode stops skipping at MAX_AUTO_FAILURES. */
  private autoFailures = 0;
  /** When the host last moved the song position (progress reports don't undo it right away). */
  private seekedAt = 0;
  private playerWasOnline = false;
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
      run: this.run,
      energyScore: this.energyScore,
      participants: this.participants.size,
      simulatedParticipants: [...this.participants].filter((p) => p.startsWith(SIMULATED_PREFIX)).length,
      nowPlaying: this.nowPlaying ? this.toQueueItem(this.nowPlaying) : null,
      queue,
      // Fill up to 5 entries: what auto play picks once the queue runs out.
      autoNext: this.upcomingAuto(Math.max(0, AUTO_NEXT_SIZE - queue.length), new Set(queue.map((q) => q.trackId))),
      tracks: this.catalog.map((t) => ({
        ...t,
        votes: this.voteCount(t.id),
        boosts: this.boostCount(t.id),
        round: this.plays.get(t.id) ?? 0,
        status:
          this.nowPlaying?.id === t.id
            ? "playing"
            : queued.has(t.id)
              ? "queued"
              : "open",
      })),
      moods: this.moodTally(),
      genres: this.genreTally(),
      maxVotesPerPerson: MAX_VOTES_PER_PERSON,
      visualState: this.hostVisual ?? {
        theme: themeForEnergy(this.energyScore, this.dominantMood()),
        intensity: intensityForEnergy(this.energyScore),
      },
      visualMode: this.hostVisual ? "host" : "auto",
      playback: { ...this.playback, mode: this.playbackMode, repeat: this.repeat, highlights: { ...this.highlightSettings }, playerOnline: this.playerOnline() },
      appearance: { ...this.appearance },
      stageView: { ...this.stageView },
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
      if (this.activeVotes(input.participantId) >= MAX_VOTES_PER_PERSON) {
        return this.reject(`You've used all ${MAX_VOTES_PER_PERSON} votes — take one back to vote for another song`, 409);
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

  /** Take back a vote, freeing one of the attendee's MAX_VOTES_PER_PERSON. */
  retractVote(input: { trackId: string; eventId: string; participantId: string }): Promise<EventOutcome> {
    return this.handleEvent(input, () => {
      const track = this.catalog.find((t) => t.id === input.trackId);
      if (!track) return this.reject("Unknown track ID", 400);
      if (!this.votes.get(track.id)?.has(input.participantId)) return this.reject("No vote to take back", 409);
      return {
        reservation: `vote:${input.participantId}:${track.id}`,
        record: { eventType: "unvote", value: -1, metadata: { trackId: track.id } },
        commit: () => {
          this.applyUnvote(track.id, input.participantId);
          return { weight: 0, event: { type: "vote.retracted", message: `Someone took back a vote for ${track.title}` } };
        },
      };
    });
  }

  /** One attendee's own view (their votes, mood, genre), for reloads and other tabs on the device. */
  participantState(participantId: string): ParticipantState {
    return {
      run: this.run,
      joined: this.joined.has(participantId),
      mood: this.moods.get(participantId) ?? null,
      genre: this.genres.get(participantId) ?? null,
      votes: this.catalog.filter((t) => this.votes.get(t.id)?.has(participantId)).map((t) => t.id),
    };
  }

  recordMood(input: {
    mood: Mood;
    genre?: string;
    eventId: string;
    participantId: string;
  }): Promise<EventOutcome> {
    return this.handleEvent(input, () => ({
      record: { eventType: "mood", value: null, metadata: { mood: input.mood, ...(input.genre ? { genre: input.genre } : {}) } },
      commit: () => {
        this.moods.set(input.participantId, input.mood);
        this.joined.add(input.participantId);
        if (input.genre) this.genres.set(input.participantId, input.genre);
        else this.genres.delete(input.participantId);
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

  /**
   * Applies a boost whose Solana devnet transaction the server already verified.
   * Callers must verify first; this never trusts a client-supplied amount or result.
   * Boosts beyond the per-track cap are recorded but add no further priority.
   */
  recordBoost(input: {
    trackId: string;
    eventId: string;
    participantId: string;
    signature: string;
    lamports: number;
  }): Promise<EventOutcome> {
    return this.handleEvent(input, () => {
      const track = this.catalog.find((t) => t.id === input.trackId);
      if (!track) return this.reject("Unknown track ID", 400);
      return {
        record: {
          eventType: "boost",
          value: input.lamports,
          metadata: { trackId: track.id, signature: input.signature },
        },
        commit: () => {
          // Paid and verified, so it's recorded either way — but a boost for the track that is
          // already playing must not put it back in the queue.
          if (this.nowPlaying?.id === track.id) {
            return {
              weight: ACTIVITY_WEIGHT.vote,
              event: { type: "boost.verified", message: `Boost verified for ${track.title} (already playing — no queue effect)` },
            };
          }
          const capped = this.applyBoost(track.id);
          return {
            weight: ACTIVITY_WEIGHT.vote,
            event: {
              type: "boost.verified",
              message: capped
                ? `Boost verified for ${track.title} (cap reached)`
                : `⚡ Verified devnet boost for ${track.title}`,
            },
          };
        },
      };
    });
  }

  /** Host action. `null` returns the stage to auto (energy-driven) mode. */
  setVisual(visual: VisualState | null): Promise<EventOutcome> {
    return this.exclusive(() => this.setVisualNow(visual));
  }

  private async setVisualNow(visual: VisualState | null): Promise<EventOutcome> {
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

  /**
   * Host action: add songs to the library (e.g. from a Spotify playlist import or search).
   * Songs already in the library (same id or Spotify URI) are skipped; the library is capped.
   * Saved with their estimated genre/BPM/energy, so a restart doesn't need Gemini again.
   */
  addTracks(tracks: CatalogTrack[]): Promise<EventOutcome & { added?: string[]; skipped?: number }> {
    return this.exclusive(async () => {
      const ids = new Set(this.catalog.map((t) => t.id));
      const uris = new Set(this.catalog.map((t) => t.spotifyUri).filter(Boolean));
      const fresh: CatalogTrack[] = [];
      for (const t of tracks) {
        if (ids.has(t.id) || (t.spotifyUri && uris.has(t.spotifyUri))) continue;
        if (this.catalog.length + fresh.length >= MAX_CATALOG_TRACKS) break;
        ids.add(t.id);
        if (t.spotifyUri) uris.add(t.spotifyUri);
        fresh.push(t);
      }
      const skipped = tracks.length - fresh.length;
      if (!fresh.length) {
        return {
          ...this.reject(
            this.catalog.length >= MAX_CATALOG_TRACKS
              ? `The library is full (${MAX_CATALOG_TRACKS} songs) — remove some first`
              : "Those songs are already in the library",
            409,
          ),
          skipped,
        };
      }
      const saved = await this.persistHostAction("catalog_add", { tracks: fresh });
      if (saved) return saved;
      this.catalog = [...this.catalog, ...fresh];
      this.change({
        type: "library.added",
        message: fresh.length === 1 ? `Added “${fresh[0].title}” to the library` : `Added ${fresh.length} songs to the library`,
      });
      return { status: "accepted", state: this.getState(), added: fresh.map((t) => t.id), skipped };
    });
  }

  /** Host action: remove a song from the library (not the one playing). Saved and replayed. */
  removeTrack(trackId: string): Promise<EventOutcome> {
    return this.exclusive(async () => {
      const track = this.catalog.find((t) => t.id === trackId);
      if (!track) return this.reject("Unknown track ID", 404);
      if (this.nowPlaying?.id === trackId) return this.reject("Can't remove the song that's playing", 409);
      if (this.catalog.length <= 2) return this.reject("The library needs at least 2 songs", 409);
      const saved = await this.persistHostAction("catalog_remove", { trackId });
      if (saved) return saved;
      this.applyRemove(trackId);
      this.change({ type: "library.removed", message: `Removed “${track.title}” from the library` });
      return { status: "accepted", state: this.getState() };
    });
  }

  /**
   * Host action: rename a local song (its title / artist in the library). The file on the laptop
   * isn't touched, and its id stays the same, so it still links. Saved and replayed.
   */
  renameTrack(trackId: string, title: string, artist: string): Promise<EventOutcome> {
    return this.exclusive(async () => {
      const track = this.catalog.find((t) => t.id === trackId);
      if (!track) return this.reject("Unknown track ID", 404);
      if (track.source !== "local") return this.reject("Only local songs can be renamed", 409);
      const saved = await this.persistHostAction("track_rename", { trackId, title, artist });
      if (saved) return saved;
      this.applyRename(trackId, title, artist);
      this.change({ type: "library.renamed", message: `Renamed to “${title}” by ${artist}` });
      return { status: "accepted", state: this.getState() };
    });
  }

  private applyRename(trackId: string, title: string, artist: string) {
    this.catalog = this.catalog.map((t) => (t.id === trackId ? { ...t, title, artist } : t));
    if (this.nowPlaying?.id === trackId) this.nowPlaying = { ...this.nowPlaying, title, artist };
  }

  /**
   * Host action: set the host's queue (ordered track ids). These play before voted songs. A song
   * can be in it more than once (and can be the one playing — it plays again later). Unknown ids
   * are refused. Saved and replayed.
   */
  setHostQueue(trackIds: string[]): Promise<EventOutcome> {
    return this.exclusive(async () => {
      const known = new Set(this.catalog.map((t) => t.id));
      const unknown = trackIds.find((id) => !known.has(id));
      if (unknown) return this.reject(`Unknown track ID ${unknown}`, 400);
      const next = trackIds.slice(0, MAX_CATALOG_TRACKS);
      const saved = await this.persistHostAction("host_queue", { trackIds: next });
      if (saved) return saved;
      this.hostQueue = next;
      this.change({
        type: "queue.host",
        message: next.length ? `Host queue: ${next.length} song${next.length === 1 ? "" : "s"}` : "Host queue cleared — votes decide",
      });
      return { status: "accepted", state: this.getState() };
    });
  }

  /**
   * Host action: remove every song from the library — including the one playing, which keeps
   * playing to its end (then the next song comes from the now-empty library / queue). Saved and replayed.
   */
  clearLibrary(): Promise<EventOutcome & { removed?: number }> {
    return this.exclusive(async () => {
      const ids = this.catalog.map((t) => t.id);
      if (!ids.length) return this.reject("The library is already empty", 409);
      const saved = await this.persistHostAction("catalog_clear", {});
      if (saved) return saved;
      this.applyClear();
      this.change({ type: "library.cleared", message: `Cleared ${ids.length} song${ids.length === 1 ? "" : "s"} from the library` });
      return { status: "accepted", state: this.getState(), removed: ids.length };
    });
  }

  /** Host action: pause the song (the player pauses; auto play waits). Not saved. */
  pause(): Promise<EventOutcome> {
    return this.exclusive(async () => {
      const pb = this.playback;
      if (!this.nowPlaying || (pb.status !== "playing" && pb.status !== "loading")) return this.reject("Nothing is playing", 409);
      const pos = pb.startedAt ? Math.max(0, this.now() - Date.parse(pb.startedAt)) : 0;
      this.playback = { ...pb, status: "paused", pausedPositionMs: pos };
      this.change({ type: "playback.paused", message: `Paused ${this.nowPlaying.title}` });
      return { status: "accepted", state: this.getState() };
    });
  }

  /** Host action: carry on from where the song was paused. */
  resume(): Promise<EventOutcome> {
    return this.exclusive(async () => {
      const pb = this.playback;
      if (!this.nowPlaying || pb.status !== "paused") return this.reject("Nothing is paused", 409);
      const pos = pb.pausedPositionMs ?? 0;
      this.seekedAt = this.now();
      this.playback = { ...pb, status: "playing", pausedPositionMs: null, startedAt: new Date(this.now() - pos).toISOString(), seekSeq: pb.seekSeq + 1 };
      this.change({ type: "playback.resumed", message: `Playing ${this.nowPlaying.title} again` });
      return { status: "accepted", state: this.getState() };
    });
  }

  /**
   * Host action ⏮: more than 5 s into the song → back to its start; otherwise the song before it
   * (and ⏭ returns to the one we left). With no earlier song, restarts this one.
   */
  previous(): Promise<EventOutcome> {
    return this.exclusive(async () => {
      const pb = this.playback;
      if (!this.nowPlaying) return this.reject("Nothing is playing", 409);
      const elapsed = pb.status === "paused" ? (pb.pausedPositionMs ?? 0) : pb.startedAt ? this.now() - Date.parse(pb.startedAt) : 0;
      const prevId = [...this.playHistory].reverse().find((id) => id !== this.nowPlaying!.id && this.catalog.some((t) => t.id === id));
      if (elapsed > RESTART_THRESHOLD_MS || !prevId) {
        if (pb.status !== "playing" && pb.status !== "paused") return this.reject("Nothing to go back to", 409);
        this.seekedAt = this.now();
        this.playback = { ...pb, status: "playing", pausedPositionMs: null, startedAt: new Date(this.now()).toISOString(), seekSeq: pb.seekSeq + 1 };
        this.change({ type: "playback.restart", message: `Restarted ${this.nowPlaying.title}` });
        return { status: "accepted", state: this.getState() };
      }
      // Drop history entries after the one we go back to (they were skipped past).
      while (this.playHistory.length && this.playHistory.at(-1) !== prevId) this.playHistory.pop();
      const saved = await this.persistHostAction("track_advance", { trackId: prevId, previous: true });
      if (saved) return saved;
      const title = this.applyAdvance(prevId, this.now(), true);
      this.change({ type: "track.playing", message: `Back to ${title}` });
      return { status: "accepted", state: this.getState() };
    });
  }

  /**
   * Host action: move the playing song to `positionMs`. The player follows (seekSeq). Not saved:
   * a restart picks the position up from the player's next progress report.
   */
  seek(positionMs: number): Promise<EventOutcome> {
    return this.exclusive(async () => {
      const pb = this.playback;
      if (!this.nowPlaying || pb.status !== "playing" || !pb.durationMs) return this.reject("Nothing is playing", 409);
      const pos = Math.max(0, Math.min(Math.round(positionMs), pb.durationMs - 1_000));
      this.seekedAt = this.now();
      this.playback = { ...pb, startedAt: new Date(this.now() - pos).toISOString(), seekSeq: pb.seekSeq + 1 };
      this.bump();
      return { status: "accepted", state: this.getState() };
    });
  }

  /** Recently played track ids, newest first (the playing song first). For Gemini's variety. */
  recentlyPlayed(n: number): string[] {
    const past = [...this.lastPlayedAt.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    return [...(this.nowPlaying ? [this.nowPlaying.id] : []), ...past.filter((id) => id !== this.nowPlaying?.id)].slice(0, n);
  }

  /**
   * Host action: reset the crowd mood — the mood tally, the genres people picked and the crowd
   * energy (back to neutral). Votes, queue, library and playback stay; phones stay joined.
   */
  resetCrowd(): Promise<EventOutcome> {
    return this.exclusive(async () => {
      const saved = await this.persistHostAction("crowd_reset", {});
      if (saved) return saved;
      this.applyCrowdReset();
      this.change({ type: "crowd.reset", message: "Crowd mood reset — waiting for fresh vibes" });
      return { status: "accepted", state: this.getState() };
    });
  }

  /** Host action: what the projector shows where the queue is (and whether it switches by itself). */
  setStageView(view: StageView): Promise<EventOutcome> {
    return this.exclusive(async () => {
      const next: StageView = { panel: view.panel === "votes" ? "votes" : "queue", auto: view.auto === true };
      const saved = await this.persistHostAction("stage_view", { ...next });
      if (saved) return saved;
      this.stageView = next;
      this.change({
        type: "stage.view",
        message: next.auto ? "Projector switches between the queue and the vote count" : next.panel === "votes" ? "Projector shows the vote count" : "Projector shows the queue",
      });
      return { status: "accepted", state: this.getState() };
    });
  }

  private applyCrowdReset() {
    this.moods.clear();
    this.genres.clear();
    this.activity = [];
    this.energyHistory = [];
    this.recomputeEnergy();
  }

  // --- Saved playlists ---

  /** The host's playlists, most recently changed first. */
  listPlaylists(): PlaylistSummary[] {
    return [...this.playlists.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((p) => ({ id: p.id, name: p.name, count: p.tracks.length, updatedAt: p.updatedAt }));
  }

  getPlaylist(id: string): Playlist | undefined {
    return this.playlists.get(id);
  }

  /**
   * Save the current library as a playlist: a new one (with `name`), or overwrite an existing one's
   * songs (`id`). Songs keep their genre/BPM/energy/cover, so loading needs no Gemini call.
   */
  savePlaylist(input: { id?: string; name?: string }): Promise<EventOutcome & { playlist?: PlaylistSummary }> {
    return this.exclusive(async () => {
      const existing = input.id ? this.playlists.get(input.id) : undefined;
      if (input.id && !existing) return this.reject("Unknown playlist", 404);
      if (!existing && this.playlists.size >= MAX_PLAYLISTS) return this.reject(`You can keep up to ${MAX_PLAYLISTS} playlists — delete one first`, 409);
      if (!this.catalog.length) return this.reject("The library is empty — add songs first", 409);
      const name = (input.name ?? existing?.name ?? "").trim();
      if (!name) return this.reject("Give the playlist a name", 400);
      const now = new Date(this.now()).toISOString();
      const playlist: Playlist = {
        id: existing?.id ?? `pl_${randomUUID().slice(0, 12)}`,
        name,
        tracks: this.catalog.slice(0, MAX_CATALOG_TRACKS).map((t) => ({ ...t })),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const saved = await this.persistHostAction("playlist_save", { playlist });
      if (saved) return saved;
      this.playlists.set(playlist.id, playlist);
      this.change({ type: "playlist.saved", message: `Saved playlist “${name}” (${playlist.tracks.length} songs)` });
      return { status: "accepted", state: this.getState(), playlist: { id: playlist.id, name, count: playlist.tracks.length, updatedAt: now } };
    });
  }

  renamePlaylist(id: string, name: string): Promise<EventOutcome> {
    return this.exclusive(async () => {
      const pl = this.playlists.get(id);
      if (!pl) return this.reject("Unknown playlist", 404);
      const next = { ...pl, name: name.trim(), updatedAt: new Date(this.now()).toISOString() };
      if (!next.name) return this.reject("Give the playlist a name", 400);
      const saved = await this.persistHostAction("playlist_save", { playlist: next });
      if (saved) return saved;
      this.playlists.set(id, next);
      return { status: "accepted", state: this.getState() };
    });
  }

  deletePlaylist(id: string): Promise<EventOutcome> {
    return this.exclusive(async () => {
      const pl = this.playlists.get(id);
      if (!pl) return this.reject("Unknown playlist", 404);
      const saved = await this.persistHostAction("playlist_delete", { id });
      if (saved) return saved;
      this.playlists.delete(id);
      this.change({ type: "playlist.deleted", message: `Deleted playlist “${pl.name}”` });
      return { status: "accepted", state: this.getState() };
    });
  }

  /**
   * Load a playlist into the library: `replace` clears the library first (the playing song keeps
   * playing), otherwise its songs are added. With `queue`, they also go into the host's queue in the
   * playlist's order. Saved as ordinary library / queue events, so a restart rebuilds it the same way.
   */
  loadPlaylist(id: string, opts: { replace: boolean; queue: boolean }): Promise<EventOutcome & { added?: number }> {
    return this.exclusive(async () => {
      const pl = this.playlists.get(id);
      if (!pl) return this.reject("Unknown playlist", 404);
      if (opts.replace && this.catalog.length) {
        const saved = await this.persistHostAction("catalog_clear", {});
        if (saved) return saved;
        this.applyClear();
      }
      const ids = new Set(this.catalog.map((t) => t.id));
      const uris = new Set(this.catalog.map((t) => t.spotifyUri).filter(Boolean));
      const fresh: CatalogTrack[] = [];
      for (const t of pl.tracks) {
        if (ids.has(t.id) || (t.spotifyUri && uris.has(t.spotifyUri))) continue;
        if (this.catalog.length + fresh.length >= MAX_CATALOG_TRACKS) break;
        ids.add(t.id);
        if (t.spotifyUri) uris.add(t.spotifyUri);
        fresh.push({ ...t });
      }
      if (fresh.length) {
        const saved = await this.persistHostAction("catalog_add", { tracks: fresh });
        if (saved) return saved;
        this.catalog = [...this.catalog, ...fresh];
      }
      if (opts.queue) {
        // The playlist's songs as they now sit in the library (matching by id or Spotify link).
        const libId = (t: PlaylistTrack) => this.catalog.find((c) => c.id === t.id || (t.spotifyUri && c.spotifyUri === t.spotifyUri))?.id;
        const order = pl.tracks.map(libId).filter((x): x is string => !!x);
        const next = [...(opts.replace ? [] : this.hostQueue), ...order].slice(0, MAX_CATALOG_TRACKS);
        const saved = await this.persistHostAction("host_queue", { trackIds: next });
        if (saved) return saved;
        this.hostQueue = next;
      }
      this.change({
        type: "playlist.loaded",
        message: `Loaded “${pl.name}”${opts.replace ? "" : ` (+${fresh.length} songs)`}${opts.queue ? " into the queue" : ""}`,
      });
      return { status: "accepted", state: this.getState(), added: fresh.length };
    });
  }

  /** Host action: the session's look. Stage and attendee screens follow it. Saved and replayed. */
  setAppearance(appearance: Appearance): Promise<EventOutcome> {
    return this.exclusive(async () => {
      const saved = await this.persistHostAction("appearance", { ...appearance });
      if (saved) return saved;
      this.appearance = { showEnergy: true, ...appearance };
      this.change({ type: "appearance", message: `New look: ${PRESET_LABEL[appearance.preset] ?? appearance.preset} · ${appearance.mode}` });
      return { status: "accepted", state: this.getState() };
    });
  }

  /** Host action: Highlights mode on/off and its options. Saved and replayed. */
  setHighlights(settings: HighlightSettings): Promise<EventOutcome> {
    return this.exclusive(async () => {
      const next = sanitizeHighlights(settings);
      const saved = await this.persistHostAction("playback_mode", { mode: this.playbackMode, repeat: this.repeat, highlights: next });
      if (saved) return saved;
      this.highlightSettings = next;
      this.change({
        type: "playback.highlights",
        message: next.enabled ? `Highlights mode on — ${next.clipSec}s of each song` : "Highlights mode off — full songs",
      });
      return { status: "accepted", state: this.getState() };
    });
  }

  highlightSettingsNow(): HighlightSettings {
    return { ...this.highlightSettings };
  }

  /** A song's saved highlight for a part, if worked out before. */
  getHighlight(trackId: string, part: HighlightPart): Highlight | undefined {
    return this.highlightCache.get(`${trackId}|${part}`);
  }

  /** Save a song's highlight (found from lyrics / Gemini, or nudged by the host). */
  async saveHighlight(trackId: string, part: HighlightPart, highlight: Highlight): Promise<boolean> {
    if (!this.catalog.some((t) => t.id === trackId)) return false;
    const saved = await this.persistHostAction("highlight", { trackId, part, highlight });
    if (saved) return false;
    this.highlightCache.set(`${trackId}|${part}`, { ...highlight });
    return true;
  }

  /** Host action 🔁: when a song finishes, play it again. Saved and replayed. */
  setRepeat(repeat: boolean): Promise<EventOutcome> {
    return this.exclusive(async () => {
      const saved = await this.persistHostAction("playback_mode", { mode: this.playbackMode, repeat });
      if (saved) return saved;
      this.repeat = repeat;
      this.change({ type: "playback.repeat", message: repeat ? "Repeat on — songs replay when they finish" : "Repeat off" });
      return { status: "accepted", state: this.getState() };
    });
  }

  /** Host action: auto (songs follow each other) or Host picks (host starts each song). Saved and replayed. */
  setPlaybackMode(mode: PlaybackMode): Promise<EventOutcome> {
    return this.exclusive(async () => {
      const saved = await this.persistHostAction("playback_mode", { mode });
      if (saved) return saved;
      this.playbackMode = mode;
      this.change({
        type: "playback.mode",
        message: mode === "auto" ? "Auto play on — songs follow the crowd's queue" : "Host picks — the host starts each song",
      });
      return { status: "accepted", state: this.getState() };
    });
  }

  /**
   * From the player page on the DJ laptop. Reports about anything other than the current track
   * and round are ignored (stale tab, duplicate report), so a song can only end once.
   * In auto mode, "ended" starts the next song.
   */
  async reportPlayback(input: {
    event: PlaybackReportEvent;
    trackId: string;
    round: number;
    positionMs?: number;
    durationMs?: number;
    source?: string;
    message?: string;
    playerId?: string;
    clipStartMs?: number;
    clipEndMs?: number;
  }): Promise<EventOutcome> {
    this.playerLastSeen = this.now();
    // One speaker at a time: the tab that last started a song is the player. Reports from any
    // other tab are ignored, and that tab sees playback.playerId change and stops itself.
    if (input.playerId && this.playback.playerId && input.playerId !== this.playback.playerId && input.event !== "started") {
      return this.reject("Another device is the player now", 409);
    }
    const current = this.nowPlaying;
    const currentRound = current ? (this.plays.get(current.id) ?? 0) : 0;
    if (!current || current.id !== input.trackId || currentRound !== input.round) {
      this.syncPlayerOnline();
      return this.reject("Not the current track — report ignored", 409);
    }
    const startedAt = new Date(this.now() - Math.max(0, input.positionMs ?? 0)).toISOString();
    switch (input.event) {
      case "started":
      case "progress": {
        this.autoFailures = 0;
        // Paused by the host: the player is just checking in; keep the paused position.
        if (this.playback.status === "paused") {
          this.syncPlayerOnline();
          return { status: "accepted", state: this.getState() };
        }
        if (input.event === "started" && input.playerId && input.playerId !== this.playback.playerId) {
          this.playback = { ...this.playback, playerId: input.playerId };
          this.bump();
        }
        const wasPlaying = this.playback.status === "playing";
        const drift = this.playback.startedAt ? Math.abs(Date.parse(this.playback.startedAt) - Date.parse(startedAt)) : Infinity;
        this.playback = {
          ...this.playback,
          status: "playing",
          // Right after a host seek the player hasn't jumped yet — keep the server's position.
          startedAt:
            wasPlaying && (drift < 2_000 || this.now() - this.seekedAt < SEEK_GRACE_MS) ? this.playback.startedAt : startedAt,
          durationMs: input.durationMs ?? this.playback.durationMs,
          // Highlights mode: the part of the song being played (null = the whole song).
          clipStartMs: input.clipStartMs ?? (input.event === "started" ? null : this.playback.clipStartMs),
          clipEndMs: input.clipEndMs ?? (input.event === "started" ? null : this.playback.clipEndMs),
          source: input.source ?? this.playback.source,
          message: null,
        };
        // Progress pings only broadcast when something visible changed.
        if (!wasPlaying || drift >= 2_000 || !this.playerWasOnline) {
          this.playerWasOnline = true;
          this.bump();
        }
        return { status: "accepted", state: this.getState() };
      }
      case "ended":
      case "error": {
        if (this.playback.status === "ended" || (this.playback.status === "paused" && input.event === "ended")) {
          return { status: "duplicate", state: this.getState() };
        }
        // 🔁 Repeat: the song finished — start it again from the top (same round, so votes stay put).
        if (input.event === "ended" && this.repeat) {
          this.playback = { ...this.playback, status: "loading", startedAt: null, pausedPositionMs: null, message: null };
          this.change({ type: "playback.repeat", message: `Repeating ${current.title}` });
          return { status: "accepted", state: this.getState() };
        }
        const failed = input.event === "error";
        this.autoFailures = failed ? this.autoFailures + 1 : 0;
        const tooManyFailures = this.autoFailures >= MAX_AUTO_FAILURES;
        if (this.playbackMode === "auto" && !tooManyFailures) {
          const next = await this.advanceAuto();
          if (next.status === "accepted") return next;
        }
        this.playback = {
          ...this.playback,
          status: failed ? "error" : "ended",
          message: failed
            ? (tooManyFailures && this.playbackMode === "auto"
                ? `Auto play paused: ${this.autoFailures} songs in a row couldn't play. Last error: `
                : "") + (input.message ?? "Playback failed").slice(0, 200)
            : null,
        };
        this.change({
          type: failed ? "playback.error" : "playback.ended",
          message: failed ? `Couldn't play ${current.title}` : `${current.title} finished — host picks the next song`,
        });
        return { status: "accepted", state: this.getState() };
      }
    }
  }

  /** Auto mode: the top of the queue, or else the least-recently-played other track. */
  private advanceAuto(): Promise<EventOutcome> {
    return this.exclusive(() => {
      const nextId = this.nextTrackId();
      if (!nextId) return Promise.resolve(this.reject("Nothing to play", 409));
      return this.advanceNow(nextId);
    });
  }

  /**
   * Add a Spotify (or catalog) track to the live session so the crowd can vote on it.
   * Idempotent when the same id is already present. Survives "Start new run" and restarts
   * (persisted as track_add).
   */
  addTrack(track: CatalogTrack): Promise<EventOutcome> {
    return this.exclusive(() => this.addTrackNow(track));
  }

  private async addTrackNow(track: CatalogTrack): Promise<EventOutcome> {
    if (this.catalog.some((t) => t.id === track.id)) {
      return { status: "accepted", state: this.getState() };
    }
    if (this.catalog.some((t) => t.spotifyUri && track.spotifyUri && t.spotifyUri === track.spotifyUri)) {
      return { status: "accepted", state: this.getState() };
    }
    if (this.catalog.length >= 100) {
      return this.reject("Song list is full (100 max) — start a new session or remove songs", 409);
    }
    const saved = await this.persistHostAction("track_add", { track });
    if (saved) return saved;
    this.catalog = [...this.catalog, track];
    this.change({ type: "track.added", message: `Added ${track.title} by ${track.artist}` });
    return { status: "accepted", state: this.getState() };
  }

  /** Host action: play the top-voted track next, or a specific catalog track. */
  advance(trackId?: string): Promise<EventOutcome> {
    return this.exclusive(() => this.advanceNow(trackId));
  }

  private async advanceNow(trackId?: string): Promise<EventOutcome> {
    let nextId: string;
    if (trackId) {
      if (!this.catalog.some((t) => t.id === trackId)) return this.reject("Unknown track ID", 400);
      if (this.nowPlaying?.id === trackId) return this.reject("Track is already playing", 409);
      nextId = trackId;
    } else {
      // Skip: the host's queue, then the top-voted song, then the least recently played one.
      const next = this.nextTrackId();
      if (!next) return this.reject("Nothing else to play — add more songs", 409);
      nextId = next;
    }
    const saved = await this.persistHostAction("track_advance", { trackId: nextId });
    if (saved) return saved;
    const title = this.applyAdvance(nextId, this.now());
    this.change({ type: "track.playing", message: `Now playing ${title}` });
    return { status: "accepted", state: this.getState() };
  }

  /** Periodic tick so energy decays as activity ages out. Returns true if state changed. */
  tick(): boolean {
    const before = this.energyScore;
    this.recomputeEnergy();
    const now = this.now();
    this.energyHistory.push({ at: now, score: this.energyScore });
    this.energyHistory = this.energyHistory.filter((e) => now - e.at <= 120_000);
    const playerFlipped = this.playerOnline() !== this.playerWasOnline;
    if (playerFlipped) {
      this.playerWasOnline = !this.playerWasOnline;
      if (this.energyScore === before) {
        this.bump();
        return true;
      }
    }
    if (this.energyScore === before) return false;
    this.bump();
    return true;
  }

  /**
   * Host action: start a fresh run of the demo. Saved as a `session_reset` event so a
   * restart (replay) and the dashboard metrics also start from here. Old rows stay in the
   * database for audit — no manual database edits needed between rehearsals.
   */
  reset(): Promise<EventOutcome> {
    return this.exclusive(() => this.resetNow());
  }

  private async resetNow(): Promise<EventOutcome> {
    const saved = await this.persistHostAction("session_reset", {});
    if (saved) return saved;
    this.clearRunState();
    this.change({ type: "session.reset", message: "New run started — waiting for the crowd" });
    return { status: "accepted", state: this.getState() };
  }

  isPlaying(trackId: string): boolean {
    return this.nowPlaying?.id === trackId;
  }

  catalogTracks(): readonly CatalogTrack[] {
    return this.catalog;
  }

  /** Change in energy score over roughly the last `windowMs` (0 if no history yet). */
  energyChange(windowMs = 30_000): number {
    const cutoff = this.now() - windowMs;
    const past = this.energyHistory.find((e) => e.at >= cutoff);
    return past ? this.energyScore - past.score : 0;
  }

  /** Audit-only record (e.g. AI recommendations and decisions). Never replayed into state. */
  async recordAudit(eventType: "ai_recommendation" | "ai_decision", metadata: Record<string, unknown>): Promise<void> {
    await this.persist({
      eventId: randomUUID(),
      sessionId: this.sessionId,
      participantId: null,
      eventType,
      value: null,
      metadata,
    });
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
            this.joined.add(r.participantId);
            if (typeof meta.genre === "string" && GENRE_PATTERN.test(meta.genre)) this.genres.set(r.participantId, meta.genre);
            else this.genres.delete(r.participantId);
            this.activity.push({ at, weight: ACTIVITY_WEIGHT.mood });
          }
          break;
        case "unvote":
          if (typeof meta.trackId === "string" && r.participantId) this.applyUnvote(meta.trackId, r.participantId);
          break;
        case "tap":
          this.applyTaps(Number(r.value) || 0);
          this.activity.push({ at, weight: ACTIVITY_WEIGHT.tap * (Number(r.value) || 0) });
          break;
        case "boost":
          if (typeof meta.trackId === "string" && this.nowPlaying?.id !== meta.trackId) {
            this.applyBoost(meta.trackId);
            this.activity.push({ at, weight: ACTIVITY_WEIGHT.vote });
          }
          break;
        case "catalog_add":
          if (Array.isArray(meta.tracks)) {
            const ids = new Set(this.catalog.map((t) => t.id));
            for (const t of meta.tracks as CatalogTrack[]) {
              if (t && typeof t.id === "string" && !ids.has(t.id) && this.catalog.length < MAX_CATALOG_TRACKS) {
                this.catalog = [...this.catalog, t];
                ids.add(t.id);
              }
            }
          }
          break;
        case "catalog_remove":
          if (typeof meta.trackId === "string" && this.nowPlaying?.id !== meta.trackId) this.applyRemove(meta.trackId);
          break;
        case "appearance":
          if (
            APPEARANCE_PRESETS.includes(meta.preset as Appearance["preset"]) &&
            (meta.mode === "light" || meta.mode === "dark")
          ) {
            this.appearance = {
              preset: meta.preset as Appearance["preset"],
              mode: meta.mode,
              showEnergy: typeof meta.showEnergy === "boolean" ? meta.showEnergy : this.appearance.showEnergy ?? true,
            };
          }
          break;
        case "host_queue":
          if (Array.isArray(meta.trackIds)) {
            const known = new Set(this.catalog.map((t) => t.id));
            this.hostQueue = (meta.trackIds as unknown[]).filter((id): id is string => typeof id === "string" && known.has(id));
          }
          break;
        case "catalog_clear":
          this.applyClear();
          break;
        case "playlist_save": {
          const pl = meta.playlist as Playlist | undefined;
          if (pl && typeof pl.id === "string" && typeof pl.name === "string" && Array.isArray(pl.tracks)) this.playlists.set(pl.id, pl);
          break;
        }
        case "stage_view":
          if (meta.panel === "queue" || meta.panel === "votes") this.stageView = { panel: meta.panel, auto: meta.auto === true };
          break;
        case "crowd_reset":
          this.applyCrowdReset();
          break;
        case "playlist_delete":
          if (typeof meta.id === "string") this.playlists.delete(meta.id);
          break;
        case "playback_mode":
          if (meta.mode === "auto" || meta.mode === "dj") this.playbackMode = meta.mode;
          if (typeof meta.repeat === "boolean") this.repeat = meta.repeat;
          if (meta.highlights && typeof meta.highlights === "object") this.highlightSettings = sanitizeHighlights(meta.highlights);
          break;
        case "track_rename":
          if (typeof meta.trackId === "string" && typeof meta.title === "string" && typeof meta.artist === "string") {
            this.applyRename(meta.trackId, meta.title.slice(0, 120), meta.artist.slice(0, 120));
          }
          break;

        case "highlight":
          if (typeof meta.trackId === "string" && HIGHLIGHT_PARTS.includes(meta.part as HighlightPart)) {
            const h = meta.highlight as Highlight | undefined;
            if (h && (h.startMs === null || (typeof h.startMs === "number" && h.startMs >= 0))) {
              this.highlightCache.set(`${meta.trackId}|${meta.part}`, {
                startMs: h.startMs,
                endMs: typeof h.endMs === "number" ? h.endMs : null,
                source: h.source,
              });
            }
          }
          break;
        case "session_reset":
          this.clearRunState();
          applied = 0;
          continue;
        case "host_visual":
          this.hostVisual = (meta.visual as VisualState | null) ?? null;
          break;
        case "track_advance":
          if (typeof meta.trackId === "string") this.applyAdvance(meta.trackId, at, meta.previous === true);
          break;
        case "track_add": {
          const t = meta.track as CatalogTrack | undefined;
          if (t?.id && t.title && t.artist && !this.catalog.some((c) => c.id === t.id)) {
            this.catalog = [...this.catalog, t];
          }
          break;
        }
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
  private handleEvent(
    input: { eventId: string; participantId: string },
    plan: () => Plan | Rejection,
  ): Promise<EventOutcome> {
    // Idempotency: a retried event ID returns current state without being counted again.
    if (this.seenEventIds.has(input.eventId)) {
      return Promise.resolve({ status: "duplicate", state: this.getState() });
    }
    // A retry of an event that is still being saved waits for that save and gets its answer.
    // Replying "duplicate" straight away would make the client drop it — and if the original
    // save then failed, the event would be lost.
    const pending = this.inflight.get(input.eventId);
    if (pending) {
      return pending.then((o) => (o.status === "accepted" ? { status: "duplicate", state: this.getState() } : o));
    }
    const outcome = this.runEvent(input, plan);
    this.inflight.set(input.eventId, outcome);
    const done = () => this.inflight.delete(input.eventId);
    outcome.then(done, done);
    return outcome;
  }

  private async runEvent(
    input: { eventId: string; participantId: string },
    plan: () => Plan | Rejection,
  ): Promise<EventOutcome> {
    await this.enterShared();
    try {
      if (!this.allowRequest(input.participantId)) {
        return this.reject("Rate limit exceeded", 429);
      }
      // Host actions can't run between plan() and commit(), so the checks made here still hold
      // when the event is applied, and the database order matches the order state changed.
      const p = plan();
      if ("status" in p) return p;
      if (p.reservation && this.reservations.has(p.reservation)) {
        return this.reject("Already voted for this track", 409);
      }

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
        if (p.reservation) this.reservations.delete(p.reservation);
      }

      this.markSeen(input.eventId);
      if (result === "duplicate") return { status: "duplicate", state: this.getState() };

      const { weight, event } = p.commit();
      this.participants.add(input.participantId);
      this.activity.push({ at: this.now(), weight });
      this.change(event);
      return { status: "accepted", state: this.getState() };
    } finally {
      this.leaveShared();
    }
  }

  private async enterShared() {
    while (this.exclusiveLock) await this.exclusiveLock;
    this.activeEvents++;
  }

  private leaveShared() {
    this.activeEvents--;
    if (this.activeEvents === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  /**
   * Runs a host action alone: waits for in-flight events to finish saving and holds new ones
   * until it's done. Host actions are rare, so ordinary events still run fully in parallel.
   */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.exclusiveLock) await this.exclusiveLock;
    let release!: () => void;
    this.exclusiveLock = new Promise<void>((r) => (release = r));
    try {
      if (this.activeEvents > 0) await new Promise<void>((r) => this.idleWaiters.push(r));
      return await fn();
    } finally {
      this.exclusiveLock = null;
      release();
    }
  }

  /** Returns a rejection if the host action could not be saved; otherwise null. */
  private async persistHostAction(
    eventType:
      | "host_visual"
      | "track_advance"
      | "track_add"
      | "session_reset"
      | "track_rename"
      | "playback_mode"
      | "appearance"
      | "catalog_add"
      | "catalog_remove"
      | "catalog_clear"
      | "host_queue"
      | "highlight"
      | "playlist_save"
      | "playlist_delete"
      | "crowd_reset"
      | "stage_view",
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

  private applyUnvote(trackId: string, participantId: string) {
    const voters = this.votes.get(trackId);
    voters?.delete(participantId);
    if (voters && !voters.size) this.votes.delete(trackId);
  }

  /** Songs this person has a vote on now, plus votes still being saved (so a burst can't exceed the cap). */
  private activeVotes(participantId: string): number {
    let n = 0;
    for (const voters of this.votes.values()) if (voters.has(participantId)) n++;
    const prefix = `vote:${participantId}:`;
    for (const r of this.reservations) if (r.startsWith(prefix)) n++;
    return n;
  }

  private genreTally(): Record<string, number> {
    const tally: Record<string, number> = {};
    for (const g of this.genres.values()) tally[g] = (tally[g] ?? 0) + 1;
    return tally;
  }

  private applyVote(trackId: string, participantId: string) {
    const voters = this.votes.get(trackId) ?? new Set<string>();
    voters.add(participantId);
    this.votes.set(trackId, voters);
  }

  private applyClear() {
    for (const t of this.catalog) {
      if (t.id !== this.nowPlaying?.id) {
        this.applyRemove(t.id);
        continue;
      }
      // The playing song leaves the library but keeps playing: keep its play count so the player's
      // "ended" report still matches, and nowPlaying keeps its details (title, cover, Spotify link).
      this.catalog = this.catalog.filter((c) => c.id !== t.id);
      this.votes.delete(t.id);
      this.boosts.delete(t.id);
      this.hostQueue = this.hostQueue.filter((id) => id !== t.id);
      for (const part of HIGHLIGHT_PARTS) this.highlightCache.delete(`${t.id}|${part}`);
    }
  }

  private applyRemove(trackId: string) {
    this.catalog = this.catalog.filter((t) => t.id !== trackId);
    for (const part of HIGHLIGHT_PARTS) this.highlightCache.delete(`${trackId}|${part}`);
    this.hostQueue = this.hostQueue.filter((id) => id !== trackId);
    this.votes.delete(trackId);
    this.boosts.delete(trackId);
    this.plays.delete(trackId);
    this.lastPlayedAt.delete(trackId);
  }

  /** Returns true if the track was already at the boost cap. */
  private applyBoost(trackId: string): boolean {
    const n = this.boosts.get(trackId) ?? 0;
    this.boosts.set(trackId, n + 1);
    return n >= MAX_BOOSTS_PER_TRACK;
  }

  /** Returns the last quest these taps completed, if any. Taps past a goal carry into the next quest. */
  private applyTaps(count: number): { level: number; goal: number } | null {
    this.questProgress += count;
    let completed: { level: number; goal: number } | null = null;
    while (this.questProgress >= this.questGoal()) {
      const goal = this.questGoal();
      completed = { level: this.questLevel, goal };
      this.questProgress -= goal;
      this.questLevel += 1;
    }
    return completed;
  }

  /** Returns the new track's title. */
  /**
   * `previous`: going back (⏮). The song we leave goes to the front of the host queue (so ⏭ comes
   * back to it) and the history steps back, instead of growing.
   */
  private applyAdvance(trackId: string, at: number, previous = false): string {
    const track = this.catalog.find((t) => t.id === trackId);
    if (!track) return trackId;
    const leaving = this.nowPlaying;
    if (leaving) this.lastPlayedAt.set(leaving.id, at);
    this.nowPlaying = track;
    // The song came off the queue: drop its first queued copy only (later copies play again later).
    const at1 = this.hostQueue.indexOf(track.id);
    if (at1 >= 0) this.hostQueue = [...this.hostQueue.slice(0, at1), ...this.hostQueue.slice(at1 + 1)];
    if (previous) {
      if (this.playHistory.at(-1) === track.id) this.playHistory.pop();
      if (leaving && leaving.id !== track.id) this.hostQueue = [leaving.id, ...this.hostQueue];
    } else if (leaving && leaving.id !== track.id) {
      this.playHistory = [...this.playHistory, leaving.id].slice(-50);
    }
    this.votes.delete(track.id);
    this.boosts.delete(track.id);
    this.plays.set(track.id, (this.plays.get(track.id) ?? 0) + 1);
    // The player page sees the new nowPlaying and starts it, then reports "started".
    this.playback = {
      status: "loading",
      trackId: track.id,
      round: this.plays.get(track.id)!,
      startedAt: null,
      durationMs: null,
      source: null,
      message: null,
      seekSeq: this.playback.seekSeq,
      playerId: this.playback.playerId,
      pausedPositionMs: null,
      clipStartMs: null,
      clipEndMs: null,
    };
    return track.title;
  }

  /** Clears everything a demo run builds up. Seen event IDs are kept so dedupe still holds. */
  private clearRunState() {
    this.run += 1;
    this.plays.clear();
    this.votes.clear();
    this.boosts.clear();
    this.lastPlayedAt.clear();
    this.nowPlaying = null;
    this.moods.clear();
    this.genres.clear();
    this.joined.clear();
    this.participants.clear();
    this.activity = [];
    this.energyHistory = [];
    this.questLevel = 1;
    this.questProgress = 0;
    this.hostVisual = null;
    this.playback = { status: "idle", trackId: null, round: 0, startedAt: null, durationMs: null, source: null, message: null, seekSeq: this.playback.seekSeq, playerId: this.playback.playerId, pausedPositionMs: null, clipStartMs: null, clipEndMs: null };
    this.playHistory = [];
    this.hostQueue = [];
  }

  private playerOnline(): boolean {
    return this.now() - this.playerLastSeen < PLAYER_ONLINE_MS;
  }

  /** Broadcast when the player page appears or disappears. */
  private syncPlayerOnline() {
    const online = this.playerOnline();
    if (online !== this.playerWasOnline) {
      this.playerWasOnline = online;
      this.bump();
    }
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

  // Tracks with votes or boosts, ordered by score (votes + capped boost bonus) desc,
  // then least-recently-played, then catalog order.
  /** The host's queue first (in order), then the top-voted songs. */
  private buildQueue(): QueueItem[] {
    const byId = new Map(this.catalog.map((t) => [t.id, t]));
    const picked = this.hostQueue
      .map((id) => byId.get(id))
      .filter((t): t is CatalogTrack => !!t)
      .map((t) => ({ ...this.toQueueItem(t), hostPick: true }));
    const hostIds = new Set(this.hostQueue);
    const voted = this.catalog
      .map((t, idx) => ({ t, idx, score: this.voteCount(t.id) + BOOST_VOTE_WEIGHT * this.boostCount(t.id) }))
      .filter(({ t, score }) => score > 0 && t.id !== this.nowPlaying?.id && !hostIds.has(t.id))
      .sort(
        (a, b) =>
          b.score - a.score ||
          (this.lastPlayedAt.get(a.t.id) ?? 0) - (this.lastPlayedAt.get(b.t.id) ?? 0) ||
          a.idx - b.idx,
      )
      .slice(0, 5)
      .map(({ t }) => this.toQueueItem(t));
    return [...picked, ...voted];
  }

  /** What plays next: the queue's first song, else the least recently played other song. */
  private nextTrackId(): string | null {
    const [top] = this.buildQueue();
    if (top) return top.trackId;
    return this.upcomingAuto(1)[0]?.trackId ?? null;
  }

  /**
   * What auto play picks with nothing queued: least recently played first (never-played songs in
   * library order). Each pick then becomes the most recent, so the next `n` are simply this order.
   * `skip`: songs already queued (they'll have just played by the time auto play takes over).
   */
  private upcomingAuto(n: number, skip: Set<string> = new Set()): QueueItem[] {
    if (n <= 0) return [];
    return this.catalog
      .map((t, idx) => ({ t, idx, played: this.lastPlayedAt.get(t.id) ?? 0 }))
      .filter(({ t }) => t.id !== this.nowPlaying?.id && !skip.has(t.id))
      .sort((a, b) => a.played - b.played || a.idx - b.idx)
      .slice(0, n)
      .map(({ t }) => this.toQueueItem(t));
  }

  private voteCount(trackId: string): number {
    return this.votes.get(trackId)?.size ?? 0;
  }

  /** Boosts that count toward priority (capped). */
  private boostCount(trackId: string): number {
    return Math.min(MAX_BOOSTS_PER_TRACK, this.boosts.get(trackId) ?? 0);
  }

  private toQueueItem(t: CatalogTrack): QueueItem {
    return {
      trackId: t.id,
      title: t.title,
      artist: t.artist,
      votes: this.voteCount(t.id),
      boosts: this.boostCount(t.id),
      ...(t.spotifyUri ? { spotifyUri: t.spotifyUri } : {}),
      ...(t.imageUrl ? { imageUrl: t.imageUrl } : {}),
    };
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
