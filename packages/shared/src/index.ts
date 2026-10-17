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
  | "reconnecting";

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

export interface LatestEvent {
  type: string;
  message: string;
  at: string;
}

export interface SessionState {
  type: "session.state";
  sessionId: string;
  sessionName: string;
  energyScore: number;
  queue: QueueItem[];
  tracks: Track[];
  visualState: VisualState;
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
  mood?: Mood;
}

export interface JoinMessage {
  type: "session.join";
  sessionId: string;
  mood?: Mood;
}

export interface ClientHelloMessage {
  type: "client.hello";
  role: "attendee" | "stage" | "host";
  sessionId: string;
}

export interface VoteResultMessage {
  type: "vote.result";
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
  | ClientHelloMessage;

export type ServerToClientMessage =
  | SessionState
  | VoteResultMessage
  | ErrorMessage;

export const THEME_ALLOWLIST: VisualTheme[] = [
  "calm_waves",
  "neon_pulse",
  "sunset",
  "electric_blue",
];

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
