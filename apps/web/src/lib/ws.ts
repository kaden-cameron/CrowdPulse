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

    const ws = new WebSocket(wsUrl());
    this.ws = ws;

    ws.onopen = () => {
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
      if (this.intentionalClose) return;
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

/** Anonymous, random per-browser participant token. No personal data. */
export function getParticipantId(): string {
  const key = "crowdpulse.participant";
  const fresh = () => `p_${createEventId().replaceAll("-", "")}`;
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const id = fresh();
    localStorage.setItem(key, id);
    return id;
  } catch {
    return fresh();
  }
}

/** Accept newer state only, unless the server restarted (new epoch). */
export function isNewer(prev: SessionState | null, next: SessionState): boolean {
  return !prev || next.epoch !== prev.epoch || next.version >= prev.version;
}
