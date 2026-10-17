import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DEMO_SESSION_ID,
  type ClientToServerMessage,
  type ServerToClientMessage,
} from "@crowdpulse/shared";
import { SessionStore } from "./session.js";

const PORT = Number(process.env.PORT ?? 8787);
const sessions = new Map<string, SessionStore>();
const socketsBySession = new Map<string, Set<WebSocket>>();

function getSession(sessionId: string): SessionStore {
  const id = sessionId || DEMO_SESSION_ID;
  let session = sessions.get(id);
  if (!session) {
    session = new SessionStore(id);
    sessions.set(id, session);
  }
  return session;
}

function trackSocket(sessionId: string, ws: WebSocket) {
  let set = socketsBySession.get(sessionId);
  if (!set) {
    set = new Set();
    socketsBySession.set(sessionId, set);
  }
  set.add(ws);
  ws.on("close", () => set?.delete(ws));
}

function send(ws: WebSocket, message: ServerToClientMessage) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(sessionId: string, message: ServerToClientMessage) {
  const set = socketsBySession.get(sessionId);
  if (!set) return;
  const payload = JSON.stringify(message);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "32kb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "crowdpulse-server",
    time: new Date().toISOString(),
  });
});

app.get("/api/sessions/:id/state", (req, res) => {
  const session = getSession(req.params.id);
  res.json(session.getState());
});

app.post("/api/sessions/:id/votes", (req, res) => {
  const session = getSession(req.params.id);
  const { trackId, eventId, mood } = req.body ?? {};
  const clientKey =
    (req.headers["x-client-id"] as string) ||
    req.ip ||
    "anonymous";

  if (!trackId || !eventId) {
    res.status(400).json({ error: "trackId and eventId are required" });
    return;
  }

  const result = session.submitVote({
    trackId,
    eventId,
    clientKey,
    mood,
  });

  if (result.status === "rejected") {
    const status = result.reason === "Rate limit exceeded" ? 429 : 400;
    res.status(status).json({ status: "rejected", reason: result.reason });
    return;
  }

  broadcast(session.sessionId, result.state);
  res.json(result);
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let boundSessionId: string | null = null;
  let clientKey = `ws-${Math.random().toString(36).slice(2)}`;

  ws.on("message", (raw) => {
    let msg: ClientToServerMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientToServerMessage;
    } catch {
      send(ws, {
        type: "error",
        code: "bad_json",
        message: "Could not parse message",
      });
      return;
    }

    if (msg.type === "client.hello" || msg.type === "session.join") {
      boundSessionId = msg.sessionId || DEMO_SESSION_ID;
      trackSocket(boundSessionId, ws);
      const session = getSession(boundSessionId);
      if (msg.type === "session.join" && "mood" in msg) {
        session.recordMood(msg.mood);
      }
      send(ws, session.getState());
      return;
    }

    if (msg.type === "vote.submit") {
      const sessionId = msg.sessionId || boundSessionId || DEMO_SESSION_ID;
      boundSessionId = sessionId;
      trackSocket(sessionId, ws);
      const session = getSession(sessionId);
      const result = session.submitVote({
        trackId: msg.trackId,
        eventId: msg.eventId,
        clientKey,
        mood: msg.mood,
      });

      if (result.status === "rejected") {
        send(ws, {
          type: "vote.result",
          eventId: msg.eventId,
          status: "rejected",
          reason: result.reason,
        });
        return;
      }

      send(ws, {
        type: "vote.result",
        eventId: msg.eventId,
        status: result.status,
      });
      broadcast(sessionId, result.state);
      return;
    }

    send(ws, {
      type: "error",
      code: "unknown_type",
      message: "Unsupported message type",
    });
  });
});

server.listen(PORT, () => {
  console.log(`CrowdPulse server listening on http://localhost:${PORT}`);
  console.log(`WebSocket path: ws://localhost:${PORT}/ws`);
  console.log(`Demo session: ${DEMO_SESSION_ID}`);
});
