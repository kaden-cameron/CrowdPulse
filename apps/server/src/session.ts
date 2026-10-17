import {
  DEMO_SESSION_ID,
  DEMO_SESSION_NAME,
  DEMO_TRACKS,
  type Mood,
  type QueueItem,
  type SessionState,
  type Track,
  type VisualTheme,
} from "@crowdpulse/shared";

const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 8;

function themeForEnergy(energy: number, mood?: Mood): VisualTheme {
  if (mood === "chill" || energy < 25) return "calm_waves";
  if (mood === "focused" || energy < 50) return "electric_blue";
  if (mood === "wild" || energy >= 80) return "neon_pulse";
  return "sunset";
}

function intensityForEnergy(energy: number): number {
  return Math.max(0.15, Math.min(1, energy / 100));
}

export class SessionStore {
  readonly sessionId: string;
  readonly sessionName: string;
  private tracks: Track[];
  private seenEventIds = new Set<string>();
  private clientHits = new Map<string, number[]>();
  private energyScore = 18;
  private moodTally: Record<Mood, number> = {
    chill: 0,
    hyped: 0,
    focused: 0,
    wild: 0,
  };
  private latestEvent: SessionState["latestEvent"] = {
    type: "session.ready",
    message: "Session live — waiting for the crowd",
    at: new Date().toISOString(),
  };

  constructor(sessionId = DEMO_SESSION_ID, sessionName = DEMO_SESSION_NAME) {
    this.sessionId = sessionId;
    this.sessionName = sessionName;
    this.tracks = DEMO_TRACKS.map((t) => ({
      ...t,
      votes: 0,
      status: "open" as const,
    }));
  }

  getState(): SessionState {
    const queue = this.buildQueue();
    const dominantMood = this.dominantMood();
    return {
      type: "session.state",
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      energyScore: this.energyScore,
      queue,
      tracks: this.tracks.map((t) => ({ ...t })),
      visualState: {
        theme: themeForEnergy(this.energyScore, dominantMood),
        intensity: intensityForEnergy(this.energyScore),
      },
      crowdQuest: {
        label: "Fill the energy meter",
        progress: Math.min(this.energyScore, 100),
        goal: 100,
      },
      latestEvent: this.latestEvent,
      updatedAt: new Date().toISOString(),
    };
  }

  recordMood(mood?: Mood) {
    if (!mood) return;
    this.moodTally[mood] += 1;
  }

  submitVote(input: {
    trackId: string;
    eventId: string;
    clientKey: string;
    mood?: Mood;
  }):
    | { status: "accepted"; state: SessionState }
    | { status: "rejected"; reason: string }
    | { status: "duplicate"; state: SessionState } {
    const { trackId, eventId, clientKey, mood } = input;

    if (!eventId || eventId.length < 8) {
      return { status: "rejected", reason: "Invalid event ID" };
    }

    if (this.seenEventIds.has(eventId)) {
      return { status: "duplicate", state: this.getState() };
    }

    if (!this.allowRequest(clientKey)) {
      return { status: "rejected", reason: "Rate limit exceeded" };
    }

    const track = this.tracks.find((t) => t.id === trackId);
    if (!track) {
      return { status: "rejected", reason: "Unknown track ID" };
    }

    this.seenEventIds.add(eventId);
    track.votes += 1;
    this.energyScore = Math.min(100, this.energyScore + 6);
    this.recordMood(mood);
    this.recomputeQueueStatuses();
    this.latestEvent = {
      type: "vote.accepted",
      message: `Vote locked for ${track.title}`,
      at: new Date().toISOString(),
    };

    return { status: "accepted", state: this.getState() };
  }

  private allowRequest(clientKey: string): boolean {
    const now = Date.now();
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

  private buildQueue(): QueueItem[] {
    return [...this.tracks]
      .filter((t) => t.votes > 0)
      .sort((a, b) => b.votes - a.votes)
      .slice(0, 5)
      .map((t) => ({
        trackId: t.id,
        title: t.title,
        artist: t.artist,
        votes: t.votes,
      }));
  }

  private recomputeQueueStatuses() {
    const ranked = [...this.tracks].sort((a, b) => b.votes - a.votes);
    this.tracks = this.tracks.map((track) => {
      const rank = ranked.findIndex((t) => t.id === track.id);
      if (track.votes === 0) return { ...track, status: "open" };
      if (rank === 0) return { ...track, status: "playing" };
      if (rank > 0 && rank < 5) return { ...track, status: "queued" };
      return { ...track, status: "open" };
    });
  }

  private dominantMood(): Mood | undefined {
    const entries = Object.entries(this.moodTally) as [Mood, number][];
    const top = entries.sort((a, b) => b[1] - a[1])[0];
    if (!top || top[1] === 0) return undefined;
    return top[0];
  }
}
