import { createHash, randomBytes } from "node:crypto";
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
import { ParticipantIds } from "./participants.js";
import { createApp, type Sessions } from "./app.js";
import { clientIp } from "./http.js";
import { createAuth0HostAuth, createDevKeyHostAuth } from "./auth.js";
import { loadCatalog } from "./catalog.js";
import { createSpotifySearch } from "./spotify.js";
import { Database } from "./db.js";
import { DEFAULT_GEMINI_MODEL, GeminiClient } from "./gemini.js";
import { RecommendationService } from "./recommendation.js";
import { BoostVerifier, DEFAULT_DEVNET_RPC } from "./solana.js";
import { log } from "./log.js";
import { SessionStore } from "./session.js";

// Load the repo-root .env if present (real values never live in the repo).
try {
  process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env"));
} catch {
  /* no .env file — rely on the real environment */
}

const PORT = Number(process.env.PORT || 8787);
const isProd = process.env.NODE_ENV === "production";
// Host auth: Auth0 when configured (required in production); otherwise a local dev key.
const auth0Domain =
  process.env.AUTH0_DOMAIN ?? process.env.AUTH0_ISSUER_BASE_URL?.replace(/^https?:\/\//, "").replace(/\/+$/, "");
/**
 * Without Auth0 (local development): HOST_DEV_KEY, or else a random key printed at startup. Never a
 * fixed, publicly known default — any web page could otherwise call host actions on this server.
 */
function devHostKey(): string {
  const set = process.env.HOST_DEV_KEY?.trim();
  if (set) return set;
  const key = randomBytes(9).toString("base64url");
  console.log(`Dev host key (set HOST_DEV_KEY to choose your own): ${key}`);
  return key;
}
const hostAuth =
  auth0Domain && process.env.AUTH0_AUDIENCE
    ? createAuth0HostAuth({
        domain: auth0Domain,
        audience: process.env.AUTH0_AUDIENCE,
        clientId: process.env.AUTH0_CLIENT_ID ?? "",
      })
    : isProd
      ? undefined
      : createDevKeyHostAuth(devHostKey());
if (!hostAuth) {
  console.error("Production requires Auth0: set AUTH0_DOMAIN, AUTH0_AUDIENCE and AUTH0_CLIENT_ID");
  process.exit(1);
}
if (hostAuth.mode === "auth0" && !process.env.AUTH0_CLIENT_ID) {
  console.error("AUTH0_CLIENT_ID (the SPA application's client ID) is required for host login");
  process.exit(1);
}
// Browser origins allowed in production: the public URL plus any extras. Development allows any.
const publicUrl = process.env.PUBLIC_URL?.trim();
// Optional: QR / join link origin when developing locally (does not lock CORS the way PUBLIC_URL does).
const joinPublicUrl = (process.env.JOIN_PUBLIC_URL?.trim() || publicUrl) || undefined;
const corsOrigins = [
  ...(publicUrl ? [new URL(publicUrl).origin] : []),
  ...(process.env.CORS_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
];
if (isProd && !corsOrigins.length) {
  console.error("Production requires PUBLIC_URL (e.g. https://203-0-113-7.sslip.io) to lock down allowed origins");
  process.exit(1);
}

// With DATABASE_URL set, every accepted event is written to TigerData before it is applied.
const db = process.env.DATABASE_URL ? new Database(process.env.DATABASE_URL) : undefined;
/** Retries a startup step a few times (the database may be briefly unreachable at boot). */
async function withRetries<T>(what: string, fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      log({ kind: "startup.retry", what, attempt: i, message: (err as Error).message });
      await new Promise((r) => setTimeout(r, 2_000 * 2 ** (i - 1)));
    }
  }
}

if (db) {
  try {
    await withRetries("db.migrate", () => db.migrate());
  } catch (err) {
    console.error(`TigerData setup failed: ${(err as Error).message}`);
    process.exit(1);
  }
} else {
  log({ kind: "startup", warning: "DATABASE_URL not set — running in memory, nothing is persisted" });
}
const persist = db ? db.persist.bind(db) : undefined;

// Song list: CATALOG_FILE, empty (Spotify search mode), or built-in demo tracks.
const spotifyClientId = process.env.SPOTIFY_CLIENT_ID?.trim() || undefined;
const spotifySearch = createSpotifySearch(spotifyClientId, process.env.SPOTIFY_CLIENT_SECRET);
let catalog;
try {
  // Relative paths are from the repo root, so the same value works for `npm run dev` and the service.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  catalog = loadCatalog(process.env.CATALOG_FILE ? path.resolve(repoRoot, process.env.CATALOG_FILE) : undefined, {
    emptyWhenSpotify: Boolean(spotifyClientId),
  });
} catch (err) {
  console.error(`CATALOG_FILE: ${(err as Error).message}`);
  process.exit(1);
}

// Only known sessions exist; unknown codes get 404 instead of silently creating state.
const sessions: Sessions = new Map([
  [DEMO_SESSION_ID, new SessionStore(DEMO_SESSION_ID, DEMO_SESSION_NAME, { persist, catalog })],
]);

// Solana devnet boosts are optional: they need a public recipient address. Mainnet is refused.
if ((process.env.SOLANA_CLUSTER ?? "devnet") !== "devnet") {
  console.error("SOLANA_CLUSTER must be devnet — CrowdPulse never uses real funds");
  process.exit(1);
}
const boosts = process.env.BOOST_RECIPIENT
  ? new BoostVerifier({
      rpcUrl: process.env.SOLANA_RPC_URL || DEFAULT_DEVNET_RPC,
      publicRpcUrl: process.env.SOLANA_PUBLIC_RPC_URL || DEFAULT_DEVNET_RPC,
      recipient: process.env.BOOST_RECIPIENT,
      lamports: Number(process.env.BOOST_LAMPORTS ?? 1_000_000),
      sessions,
      db,
    })
  : undefined;

// Rebuild state from TigerData so a restart doesn't lose votes, moods, or the queue.
if (db) {
  for (const [id, session] of sessions) {
    const t0 = performance.now();
    let records;
    try {
      records = await withRetries("db.replay", () => db.loadEvents(id));
      for (const sig of await withRetries("db.boosts", () => db.boostSignatures(id))) boosts?.markUsed(sig);
    } catch (err) {
      console.error(`Couldn't load saved events for ${id}: ${(err as Error).message}`);
      process.exit(1);
    }
    const applied = session.replay(records);
    log({ kind: "db.replay", sessionId: id, events: applied, ms: +(performance.now() - t0).toFixed(1) });
  }
}
const socketsBySession = new Map<string, Set<WebSocket>>();

// Gemini is optional: without a key the host sees "AI unavailable" and everything else works.
const gemini = process.env.GEMINI_API_KEY
  ? new GeminiClient(process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL)
  : undefined;
// A second client for song estimates: batches need more time and output than recommendations.
const trackEstimator = process.env.GEMINI_API_KEY
  ? new GeminiClient(process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, 25_000, 2_048)
  : undefined;
// And one for Find songs: up to 50 songs per answer.
const songFinder = process.env.GEMINI_API_KEY
  ? new GeminiClient(process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, 40_000, 8_192)
  : undefined;
// And one for Highlights mode: the larger Flash model is much better at telling a chorus from a verse.
// Falls back to the everyday model when it's busy.
const highlightModel = process.env.GEMINI_API_KEY
  ? new GeminiClient(process.env.GEMINI_API_KEY, process.env.GEMINI_HIGHLIGHT_MODEL || "gemini-3.5-flash", 30_000, 2_048)
  : undefined;
const recommenders = new Map([...sessions].map(([id, s]) => [id, new RecommendationService(s, gemini)]));

// Signed attendee ids. The secret must stay the same across restarts (saved votes belong to these
// ids): PARTICIPANT_SECRET, or one derived from the database / Auth0 settings. In memory-only
// development a random one is fine (nothing survives a restart anyway).
const participantSecret =
  process.env.PARTICIPANT_SECRET?.trim() ||
  (process.env.DATABASE_URL || process.env.AUTH0_CLIENT_ID
    ? createHash("sha256").update(`crowdpulse-participants|${process.env.DATABASE_URL ?? ""}|${process.env.AUTH0_CLIENT_ID ?? ""}`).digest("hex")
    : randomBytes(32).toString("hex"));
const participantIds = new ParticipantIds(participantSecret);

const { app, handleEvent, isOriginAllowed } = createApp({
  sessions,
  hostAuth,
  corsOrigins,
  db,
  recommenders,
  boosts,
  trackEstimator,
  songFinder,
  highlightModel,
  ipLimitPerMinute: Number(process.env.RATE_LIMIT_IP_PER_MIN || 6000),
  publicUrl: joinPublicUrl ? new URL(joinPublicUrl).origin : undefined,
  spotifyClientId,
  spotifySearch,
  exposeLanIp: !isProd,
  participantIds,
  participantsPerIpHour: Number(process.env.PARTICIPANTS_PER_IP_HOUR || 600),
});

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
const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: 2048,
  // CORS doesn't cover WebSockets, so check the browser's Origin here too (VU-08).
  verifyClient: ({ origin }: { origin?: string }) => isOriginAllowed(origin),
});
const alive = new WeakSet<WebSocket>();
/** Open sockets per address (generous: a venue's phones may share one Wi-Fi address). */
const MAX_SOCKETS_PER_IP = 400;
/** A hello sends the whole session state back, so one socket may only ask a few times. */
const MAX_HELLOS_PER_SOCKET = 20;
const socketsPerIp = new Map<string, number>();

wss.on("connection", (ws, req) => {
  const ip = clientIp(req);
  const open = (socketsPerIp.get(ip) ?? 0) + 1;
  if (open > MAX_SOCKETS_PER_IP) {
    ws.close(4429, "too_many_connections");
    return;
  }
  socketsPerIp.set(ip, open);
  let hellos = 0;
  let boundSessionId: string | null = null;
  alive.add(ws);
  ws.on("pong", () => alive.add(ws));
  ws.on("close", () => {
    if (boundSessionId) socketsBySession.get(boundSessionId)?.delete(ws);
    const n = (socketsPerIp.get(ip) ?? 1) - 1;
    if (n > 0) socketsPerIp.set(ip, n);
    else socketsPerIp.delete(ip);
  });

  ws.on("message", async (raw) => {
    let msg: { type?: unknown; sessionId?: unknown };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      send(ws, { type: "error", code: "bad_json", message: "Could not parse message" });
      return;
    }

    if (msg?.type === "client.hello") {
      if (++hellos > MAX_HELLOS_PER_SOCKET) {
        ws.close(4429, "too_many_hellos");
        return;
      }
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
    // A bug here must not take the whole server (and every connected screen) down.
    try {
      const { result } = await handleEvent(msg, ip, "ws");
      send(ws, result);
    } catch (err) {
      log({ kind: "ws.handler_error", message: (err as Error).message });
      send(ws, { type: "error", code: "server_error", message: "Could not process that event — please retry" });
    }
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

// Engagement-score samples feed the dashboard trend (metrics only; never replayed).
if (db) {
  setInterval(() => {
    for (const session of sessions.values()) {
      session.sampleEnergy().catch((err) =>
        log({ kind: "db.energy_sample_failed", sessionId: session.sessionId, message: (err as Error).message }),
      );
    }
  }, 5_000);
}

// Clean shutdown for restarts and deploys (VU-04): tell clients to reconnect, finish in-flight
// requests, close the database pool. systemd restarts the process; clients reload state on reconnect.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log({ kind: "shutdown", signal, clients: wss.clients.size });
  for (const ws of wss.clients) ws.close(1012, "server restarting");
  server.close();
  const force = setTimeout(() => process.exit(0), 5_000);
  force.unref();
  await db?.close().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
// Log stray async errors instead of crashing mid-demo (Node's default is to exit).
process.on("unhandledRejection", (reason) => {
  log({ kind: "unhandled_rejection", message: reason instanceof Error ? reason.message : String(reason) });
});
process.on("SIGINT", () => void shutdown("SIGINT"));

server.listen(PORT, () => {
  log({
    kind: "startup",
    port: PORT,
    sessions: [...sessions.keys()],
    persistence: db ? "tigerdata" : "memory",
    gemini: gemini ? gemini.model : "off",
    catalog: process.env.CATALOG_FILE
      ? `${catalog.length} tracks from CATALOG_FILE`
      : spotifyClientId
        ? "empty (Spotify search)"
        : "demo tracks",
    spotify: spotifyClientId ? (spotifySearch.configured ? "playback+search" : "playback only") : "off",
    boosts: boosts ? "devnet" : "off",
    hostAuth: hostAuth.mode,
    allowedOrigins: corsOrigins.length ? corsOrigins : "any (development)",
    servingWeb: existsSync(webDist),
  });
});
