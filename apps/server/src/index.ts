import express from "express";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DEMO_SESSION_ID,
  DEMO_SESSION_NAME,
  type ServerToClientMessage,
} from "@crowdpulse/shared";
import { createApp, type Sessions } from "./app.js";
import { log } from "./log.js";
import { SessionStore } from "./session.js";

const PORT = Number(process.env.PORT ?? 8787);
const isProd = process.env.NODE_ENV === "production";
const hostKey = process.env.HOST_DEV_KEY ?? (isProd ? "" : "local-dev-host-key");
if (!hostKey) {
  console.error("HOST_DEV_KEY must be set in production");
  process.exit(1);
}
const corsOrigins = process.env.CORS_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean);

// Only known sessions exist; unknown codes get 404 instead of silently creating state.
const sessions: Sessions = new Map([
  [DEMO_SESSION_ID, new SessionStore(DEMO_SESSION_ID, DEMO_SESSION_NAME)],
]);
const socketsBySession = new Map<string, Set<WebSocket>>();

const { app, handleEvent } = createApp({ sessions, hostKey, corsOrigins });

// In production, serve the built web app and fall back to index.html for SPA routes.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

function send(ws: WebSocket, message: ServerToClientMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function broadcast(sessionId: string) {
  const set = socketsBySession.get(sessionId);
  const session = sessions.get(sessionId);
  if (!set?.size || !session) return;
  const payload = JSON.stringify(session.getState());
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

for (const [id, session] of sessions) session.onChange(() => broadcast(id));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 2048 });
const alive = new WeakSet<WebSocket>();

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress ?? "unknown";
  let boundSessionId: string | null = null;
  alive.add(ws);
  ws.on("pong", () => alive.add(ws));
  ws.on("close", () => {
    if (boundSessionId) socketsBySession.get(boundSessionId)?.delete(ws);
  });

  ws.on("message", (raw) => {
    let msg: { type?: unknown; sessionId?: unknown };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      send(ws, { type: "error", code: "bad_json", message: "Could not parse message" });
      return;
    }

    if (msg?.type === "client.hello") {
      const id = typeof msg.sessionId === "string" ? msg.sessionId : "";
      const session = sessions.get(id);
      if (!session) {
        send(ws, { type: "error", code: "unknown_session", message: "Session not found" });
        ws.close(4404, "unknown_session");
        return;
      }
      if (boundSessionId) socketsBySession.get(boundSessionId)?.delete(ws);
      boundSessionId = id;
      const set = socketsBySession.get(id) ?? new Set();
      set.add(ws);
      socketsBySession.set(id, set);
      // Full snapshot on every (re)connect so clients never assume they saw every event.
      send(ws, session.getState());
      return;
    }

    // Events are applied via the same validated path as HTTP; state broadcasts via onChange.
    const { result } = handleEvent(msg, ip, "ws");
    send(ws, result);
  });
});

// Heartbeat: drop clients that miss a ping.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) {
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
}, 15_000);

// Energy decays as activity ages out; tick() broadcasts only when the score moves.
setInterval(() => {
  for (const session of sessions.values()) session.tick();
}, 2_000);

server.listen(PORT, () => {
  log({ kind: "startup", port: PORT, sessions: [...sessions.keys()], servingWeb: existsSync(webDist) });
});
