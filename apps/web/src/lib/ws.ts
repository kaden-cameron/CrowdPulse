import type {
  ClientToServerMessage,
  ConnectionStatus,
  EventResultMessage,
  ServerToClientMessage,
  SessionState,
} from "@crowdpulse/shared";

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

export type SessionSocketHandlers = {
  onState: (state: SessionState) => void;
  onEventResult?: (result: EventResultMessage) => void;
  onStatus: (status: ConnectionStatus) => void;
  onError?: (message: string) => void;
};

type EventMessage = Exclude<ClientToServerMessage, { type: "client.hello" }>;

const RESEND_DELAY_MS = 3000;

export class SessionSocket {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private intentionalClose = false;
  private attempt = 0;
  private sessionId: string;
  private role: "attendee" | "stage" | "host";
  private handlers: SessionSocketHandlers;
  // Events not yet acknowledged by the server. Resent on reconnect with the
  // same eventId; the server deduplicates, so a resend is never double-counted.
  private outbox = new Map<string, EventMessage>();

  constructor(
    sessionId: string,
    role: "attendee" | "stage" | "host",
    handlers: SessionSocketHandlers,
  ) {
    this.sessionId = sessionId;
    this.role = role;
    this.handlers = handlers;
  }

  connect() {
    this.intentionalClose = false;
    this.handlers.onStatus(
      this.attempt === 0 ? "connecting" : "reconnecting",
    );

    if (this.reconnectTimer != null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    // Replacing a socket (e.g. still closing after going offline): its late events must not
    // schedule another reconnect, or a second connection leaks.
    this.detach();

    const ws = new WebSocket(wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.attempt = 0;
      this.handlers.onStatus("connected");
      this.raw({
        type: "client.hello",
        role: this.role,
        sessionId: this.sessionId,
      });
      for (const msg of this.outbox.values()) this.raw(msg);
    };

    ws.onmessage = (event) => {
      if (ws !== this.ws) return;
      let msg: ServerToClientMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerToClientMessage;
      } catch {
        this.handlers.onError?.("Bad server payload");
        return;
      }

      if (msg.type === "session.state") {
        if (msg.sessionId === this.sessionId) this.handlers.onState(msg);
        return;
      }
      if (msg.type === "event.result") {
        if (msg.retryable) {
          // Server couldn't save it: keep it queued and resend the same eventId shortly.
          this.scheduleResend(msg.eventId);
        } else {
          this.outbox.delete(msg.eventId);
        }
        this.handlers.onEventResult?.(msg);
        return;
      }
      if (msg.type === "error") {
        if (msg.code === "unknown_session") {
          this.intentionalClose = true;
          this.handlers.onStatus("not_found");
        }
        this.handlers.onError?.(msg.message);
      }
    };

    ws.onclose = () => {
      if (ws !== this.ws || this.intentionalClose) return;
      this.handlers.onStatus("disconnected");
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose handles reconnect
    };
  }

  /** Queue an event; sent now if connected, otherwise on reconnect. */
  sendEvent(message: EventMessage) {
    this.outbox.set(message.eventId, message);
    this.raw(message);
  }

  /**
   * The device lost its network. Browsers don't close an open WebSocket when that happens,
   * so close it ourselves: the UI shows "Disconnected/Reconnecting" right away and the
   * normal reconnect loop takes over (queued events stay in the outbox).
   */
  dropForOffline() {
    if (this.intentionalClose) return;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close();
  }

  /**
   * Replace the connection with a fresh one now. Used when a phone wakes a backgrounded tab:
   * iOS may have silently killed the socket while the badge still says "Live". The new
   * connection gets a full snapshot and resends anything in the outbox.
   */
  refresh() {
    if (this.intentionalClose) return;
    this.attempt = 0;
    this.connect();
  }

  /** Reconnect immediately (e.g. when the device comes back online). */
  reconnectNow() {
    if (this.intentionalClose) return;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    if (this.reconnectTimer != null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connect();
  }

  close() {
    this.intentionalClose = true;
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  /** Drop the current socket's handlers and close it (it's being replaced). */
  private detach() {
    const old = this.ws;
    if (!old) return;
    old.onopen = null;
    old.onclose = null;
    old.onmessage = null;
    old.onerror = null;
    if (old.readyState <= WebSocket.OPEN) old.close();
    this.ws = null;
  }

  private scheduleResend(eventId: string) {
    window.setTimeout(() => {
      const msg = this.outbox.get(eventId);
      if (msg) this.raw(msg);
    }, RESEND_DELAY_MS);
  }

  private raw(message: ClientToServerMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private scheduleReconnect() {
    this.attempt += 1;
    const delay = Math.min(8000, 500 * 2 ** Math.min(this.attempt, 4));
    this.handlers.onStatus("reconnecting");
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }
}

export async function fetchSessionState(
  sessionId: string,
): Promise<SessionState> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/state`);
  if (!res.ok) throw new Error("Failed to load session state");
  return res.json() as Promise<SessionState>;
}

/** RFC 4122 v4 UUID. crypto.randomUUID needs a secure context, which phones on LAN http:// lack. */
export function createEventId(): string {
  if (window.isSecureContext && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Kept in memory too: if storage is blocked (private mode, some in-app QR browsers), the ID must
// still be stable for this page, or every request would count as a new attendee.
let participantIdCache: string | null = null;

const PARTICIPANT_KEY = "crowdpulse.participant";
/** Ids the server hands out (signed); older made-up ids are replaced. */
const SIGNED_ID = /^ps_[0-9a-f]{24}_[0-9a-f]{16}$/;
let participantRequest: Promise<string> | null = null;

/**
 * This browser's attendee id, from the server (it signs ids so they can't be made up). Asked for
 * once and kept; if the server doesn't hand out ids (older server), the local id is used.
 */
export function ensureParticipantId(): Promise<string> {
  const have = getParticipantId();
  if (SIGNED_ID.test(have)) return Promise.resolve(have);
  participantRequest ??= (async () => {
    try {
      const res = await fetch("/api/participants", { method: "POST" });
      if (!res.ok) return getParticipantId();
      const { participantId } = (await res.json()) as { participantId?: string };
      if (!participantId || !SIGNED_ID.test(participantId)) return getParticipantId();
      participantIdCache = participantId;
      try {
        localStorage.setItem(PARTICIPANT_KEY, participantId);
      } catch {
        /* storage blocked — the in-memory id still holds for this page */
      }
      return participantId;
    } catch {
      return getParticipantId();
    } finally {
      participantRequest = null;
    }
  })();
  return participantRequest;
}

/** The server didn't accept this id (e.g. it was made before ids were signed): get a new one. */
export function resetParticipantId(): Promise<string> {
  participantIdCache = `p_${createEventId().replaceAll("-", "")}`;
  try {
    localStorage.removeItem(PARTICIPANT_KEY);
  } catch {
    /* storage blocked */
  }
  return ensureParticipantId();
}

/** Anonymous, random per-browser participant token. No personal data. */
export function getParticipantId(): string {
  if (participantIdCache) return participantIdCache;
  const key = PARTICIPANT_KEY;
  try {
    participantIdCache = localStorage.getItem(key);
  } catch {
    /* storage blocked */
  }
  if (!participantIdCache) {
    participantIdCache = `p_${createEventId().replaceAll("-", "")}`;
    try {
      localStorage.setItem(key, participantIdCache);
    } catch {
      /* storage blocked — the in-memory ID still holds for this page */
    }
  }
  return participantIdCache;
}

/** Accept newer state only, unless the server restarted (new epoch). */
export function isNewer(prev: SessionState | null, next: SessionState): boolean {
  return !prev || next.epoch !== prev.epoch || next.version >= prev.version;
}
