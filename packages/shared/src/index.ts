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
  votes: number;
  status: "open" | "queued" | "playing";
}

export interface QueueItem {
  trackId: string;
  title: string;
  artist: string;
  votes: number;
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

export const DEMO_SESSION_ID = "demo";
export const DEMO_SESSION_NAME = "SwampHacks Main Stage";

export const DEMO_TRACKS: Omit<Track, "votes" | "status">[] = [
  { id: "track_01", title: "Gator Glow", artist: "Orange & Blue" },
  { id: "track_02", title: "Midnight Cypress", artist: "Lake Beat" },
  { id: "track_03", title: "Hackathon Heat", artist: "Pulse Lab" },
  { id: "track_04", title: "Spanish Moss", artist: "Night Circuit" },
  { id: "track_05", title: "Voltage Swamp", artist: "Neon Bayou" },
  { id: "track_06", title: "Crowd Current", artist: "Signal Kids" },
  { id: "track_07", title: "Stage Lightning", artist: "DJ Hydra" },
];
