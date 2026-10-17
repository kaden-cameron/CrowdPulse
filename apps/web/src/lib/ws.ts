import type {
  ClientToServerMessage,
  ConnectionStatus,
  ServerToClientMessage,
  SessionState,
} from "@crowdpulse/shared";

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

export type SessionSocketHandlers = {
  onState: (state: SessionState) => void;
  onVoteResult?: (result: {
    eventId: string;
    status: "accepted" | "rejected" | "duplicate";
    reason?: string;
  }) => void;
  onStatus: (status: ConnectionStatus) => void;
  onError?: (message: string) => void;
};

export class SessionSocket {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private intentionalClose = false;
  private attempt = 0;
  private sessionId: string;
  private role: "attendee" | "stage" | "host";
  private handlers: SessionSocketHandlers;

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
      this.send({
        type: "client.hello",
        role: this.role,
        sessionId: this.sessionId,
      });
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
        this.handlers.onState(msg);
        return;
      }
      if (msg.type === "vote.result") {
        this.handlers.onVoteResult?.(msg);
        return;
      }
      if (msg.type === "error") {
        this.handlers.onError?.(msg.message);
      }
    };

    ws.onclose = () => {
      this.handlers.onStatus("disconnected");
      if (!this.intentionalClose) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose handles reconnect
    };
  }

  send(message: ClientToServerMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
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
  const res = await fetch(`/api/sessions/${sessionId}/state`);
  if (!res.ok) throw new Error("Failed to load session state");
  return res.json() as Promise<SessionState>;
}

export function createEventId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
