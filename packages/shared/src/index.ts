export type VisualTheme =
  | "calm_waves"
  | "neon_pulse"
  | "sunset"
  | "electric_blue";

export type Mood = "chill" | "hyped" | "focused" | "wild";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "not_found";

export type VoteFeedback =
  | "idle"
  | "pending"
  | "accepted"
  | "rejected"
  | "duplicate";

export interface Track {
  id: string;
  title: string;
  artist: string;
  genre: string;
  bpm: number;
  /** Catalog energy, 0–1. */
  energy: number;
  votes: number;
  /** Verified Solana devnet boosts currently counting for this track (capped). */
  boosts: number;
  status: "open" | "queued" | "playing";
}

export interface QueueItem {
  trackId: string;
  title: string;
  artist: string;
  votes: number;
  boosts: number;
}

export interface VisualState {
  theme: VisualTheme;
  intensity: number;
}

/** "auto" follows crowd energy; "host" means the host pinned a theme/intensity. */
export type VisualMode = "auto" | "host";

export interface LatestEvent {
  type: string;
  message: string;
  at: string;
}

export interface SessionState {
  type: "session.state";
  sessionId: string;
  sessionName: string;
  /** Changes when the server restarts; clients accept a new epoch unconditionally. */
  epoch: string;
  /** Monotonic within an epoch; clients ignore older versions. */
  version: number;
  energyScore: number;
  participants: number;
  nowPlaying: QueueItem | null;
  queue: QueueItem[];
  tracks: Track[];
  moods: Record<Mood, number>;
  visualState: VisualState;
  visualMode: VisualMode;
  crowdQuest: {
    label: string;
    progress: number;
    goal: number;
  };
  latestEvent: LatestEvent | null;
  updatedAt: string;
}

export interface VoteSubmitMessage {
  type: "vote.submit";
  sessionId: string;
  trackId: string;
  eventId: string;
  participantId: string;
}

export interface JoinMessage {
  type: "session.join";
  sessionId: string;
  eventId: string;
  participantId: string;
  mood: Mood;
}

export interface TapMessage {
  type: "tap.batch";
  sessionId: string;
  eventId: string;
  participantId: string;
  count: number;
}

export interface ClientHelloMessage {
  type: "client.hello";
  role: "attendee" | "stage" | "host";
  sessionId: string;
}

export interface EventResultMessage {
  type: "event.result";
  eventId: string;
  status: "accepted" | "rejected" | "duplicate";
  reason?: string;
  /** True when the server couldn't save the event; resend with the same eventId. */
  retryable?: boolean;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export type ClientToServerMessage =
  | VoteSubmitMessage
  | JoinMessage
  | TapMessage
  | ClientHelloMessage;

export type ServerToClientMessage =
  | SessionState
  | EventResultMessage
  | ErrorMessage;

export const THEME_ALLOWLIST: VisualTheme[] = [
  "calm_waves",
  "neon_pulse",
  "sunset",
  "electric_blue",
];

export const MOODS: Mood[] = ["chill", "hyped", "focused", "wild"];

export const MAX_TAPS_PER_BATCH = 30;

/** What the host is aiming for; sent to Gemini as context. */
export type HostTarget = "raise_energy" | "hold_steady" | "cool_down";
export const HOST_TARGETS: HostTarget[] = ["raise_energy", "hold_steady", "cool_down"];

/** Server-validated AI DJ proposal (Doc 04 §3). */
export interface RecommendationProposal {
  reason: string;
  target_energy: number;
  recommended_track_id: string;
  visual_theme: VisualTheme;
  intensity: number;
  confidence: number;
}

export interface Recommendation {
  id: string;
  sessionId: string;
  createdAt: string;
  status: "pending" | "approved" | "rejected" | "invalid" | "failed";
  hostTarget: HostTarget;
  /** The compact summary actually sent to the model. */
  input: unknown;
  model: string;
  /** From the Gemini response, for proof the call was real. */
  responseId: string | null;
  modelVersion: string | null;
  latencyMs: number | null;
  /** Raw model text (truncated), kept for audit. */
  rawResponse: string | null;
  proposal: RecommendationProposal | null;
  /** Why the server rejected the proposal or the call failed. */
  validationErrors: string[];
  /** Majority-vote baseline under the same state, for comparison. */
  baseline: { trackId: string | null; reason: string };
  decidedAt: string | null;
}

export interface AiStatus {
  configured: boolean;
  model: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
}

/** Response of GET /api/auth/config. Only public values (the SPA client ID is not a secret). */
export type AuthConfig =
  | { mode: "dev-key" }
  | { mode: "auth0"; domain: string; clientId: string; audience: string };

// --- Solana devnet boosts (Doc 05) ---

/** Each verified boost counts as this many votes in queue order; a track holds at most MAX_BOOSTS_PER_TRACK. */
export const BOOST_VOTE_WEIGHT = 2;
export const MAX_BOOSTS_PER_TRACK = 3;

/** Server-issued, single-use instructions for one boost transaction. */
export interface BoostIntent {
  intentId: string;
  sessionId: string;
  trackId: string;
  cluster: "devnet";
  rpcUrl: string;
  recipient: string;
  lamports: number;
  /** Must be included verbatim as an SPL Memo instruction. Binds the tx to this session and track. */
  memo: string;
  expiresAt: string;
}

export type BoostStatus = "pending" | "verified" | "rejected" | "unknown";

export interface BoostVerifyResult {
  status: BoostStatus;
  signature: string;
  /** Why it is pending/rejected/unknown. */
  reason?: string;
  explorerUrl: string;
  state?: SessionState;
}

export interface BoostConfig {
  enabled: boolean;
  cluster: "devnet";
  lamports: number;
  recipient: string | null;
}

/** Response of GET /api/sessions/:id/metrics. */
export type SessionMetrics =
  | { persistence: "memory" }
  | {
      persistence: "tigerdata";
      generatedAt: string;
      queryMs: number;
      latestEventAt: string | null;
      eventsLast10s: number;
      totalEvents: number;
      votesByTrack: { trackId: string; votes: number }[];
      buckets: {
        bucket: string;
        eventCount: number;
        votes: number;
        taps: number;
        avgEnergy: number | null;
        source: "aggregate" | "raw";
      }[];
      aggregate: { latestBucket: string | null; lagSeconds: number | null };
    };

export const DEMO_SESSION_ID = "demo";
export const DEMO_SESSION_NAME = "SwampHacks Main Stage";

export const DEMO_TRACKS: Omit<Track, "votes" | "status" | "boosts">[] = [
  { id: "track_01", title: "Gator Glow", artist: "Orange & Blue", genre: "house", bpm: 122, energy: 0.6 },
  { id: "track_02", title: "Midnight Cypress", artist: "Lake Beat", genre: "lofi", bpm: 84, energy: 0.2 },
  { id: "track_03", title: "Hackathon Heat", artist: "Pulse Lab", genre: "techno", bpm: 130, energy: 0.85 },
  { id: "track_04", title: "Spanish Moss", artist: "Night Circuit", genre: "downtempo", bpm: 96, energy: 0.35 },
  { id: "track_05", title: "Voltage Swamp", artist: "Neon Bayou", genre: "electro", bpm: 126, energy: 0.75 },
  { id: "track_06", title: "Crowd Current", artist: "Signal Kids", genre: "synthwave", bpm: 110, energy: 0.5 },
  { id: "track_07", title: "Stage Lightning", artist: "DJ Hydra", genre: "drum & bass", bpm: 174, energy: 0.95 },
];
