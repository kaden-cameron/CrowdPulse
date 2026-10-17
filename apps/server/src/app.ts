import cors from "cors";
import express, { type RequestHandler } from "express";
import { z } from "zod";
import {
  HOST_TARGETS,
  PLAYBACK_MODES,
  MAX_TAPS_PER_BATCH,
  MOODS,
  THEME_ALLOWLIST,
  type EventResultMessage,
  type HostTarget,
  type PlaybackMode,
  type VisualTheme,
  type Mood,
} from "@crowdpulse/shared";
import { log } from "./log.js";
import { RateLimiter } from "./rateLimit.js";
import { authErrorHandler, createDevKeyHostAuth, type HostAuth } from "./auth.js";
import { clientIp, originPolicy, pickLanIp, securityHeaders } from "./http.js";
import type { Database } from "./db.js";
import type { RecommendationService } from "./recommendation.js";
import { httpStatusFor, type BoostVerifier } from "./solana.js";
import type { EventOutcome, SessionStore } from "./session.js";

const sessionId = z.string().min(1).max(64);
const eventId = z.string().uuid();
const participantId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

// Strict schemas: unknown fields are rejected, so clients can't smuggle extra data.
const VoteSchema = z
  .object({
    type: z.literal("vote.submit"),
    sessionId,
    trackId: z.string().max(64),
    eventId,
    participantId,
  })
  .strict();
const JoinSchema = z
  .object({
    type: z.literal("session.join"),
    sessionId,
    eventId,
    participantId,
    mood: z.enum(MOODS as [Mood, ...Mood[]]),
  })
  .strict();
const TapSchema = z
  .object({
    type: z.literal("tap.batch"),
    sessionId,
    eventId,
    participantId,
    count: z.number().int().min(1).max(MAX_TAPS_PER_BATCH),
  })
  .strict();
const EventSchema = z.discriminatedUnion("type", [VoteSchema, JoinSchema, TapSchema]);
const VisualSchema = z
  .object({
    theme: z.enum(THEME_ALLOWLIST as [VisualTheme, ...VisualTheme[]]),
    intensity: z.number().finite(),
  })
  .strict()
  .nullable();

export type Sessions = Map<string, SessionStore>;

export interface AppOptions {
  sessions: Sessions;
  /** How host endpoints are protected (Auth0 in production). */
  hostAuth?: HostAuth;
  /** Shorthand for a dev-key HostAuth (local development and tests). */
  hostKey?: string;
  /** TigerData connection; omitted means in-memory only (no metrics). */
  db?: Database;
  /** Gemini recommendation service per session. */
  recommenders?: Map<string, RecommendationService>;
  /** Solana devnet boost verifier; omitted means boosts are disabled. */
  boosts?: BoostVerifier;
  /** Browser origins allowed to call the API (and open WebSockets). Empty = any (development). */
  corsOrigins?: string[];
  /** The address attendees should open (production). Used for the stage QR code. */
  publicUrl?: string;
  /**
   * Spotify app Client ID for the player page's Spotify login (PKCE). Public by design — the
   * Client Secret is never needed or used.
   */
  spotifyClientId?: string;
  /** Development only: share this machine's LAN IP so a stage opened at localhost gets a scannable QR. */
  exposeLanIp?: boolean;
  /** Per-IP backstop per minute. High on purpose: a whole venue can share one Wi-Fi IP. */
  ipLimitPerMinute?: number;
  now?: () => number;
}

export function createEventHandler({ sessions, now = Date.now, ipLimitPerMinute = 6000 }: AppOptions) {
  // Per-participant limits live in SessionStore. This per-IP limit is only an abuse backstop:
  // every attendee on venue Wi-Fi can share one public IP, so it must stay far above real use.
  const ipLimiter = new RateLimiter(ipLimitPerMinute, 60_000, now);

  /** Validates and applies one client event from either HTTP or WebSocket. */
  return async function handleEvent(
    raw: unknown,
    ip: string,
    transport: "http" | "ws",
  ): Promise<{ result: EventResultMessage; httpStatus: number; outcome?: EventOutcome }> {
    const t0 = performance.now();
    const rawEventId =
      typeof (raw as { eventId?: unknown })?.eventId === "string"
        ? (raw as { eventId: string }).eventId.slice(0, 64)
        : "";
    const done = (status: EventResultMessage["status"], httpStatus: number, reason?: string, outcome?: EventOutcome) => {
      const parsedType = (raw as { type?: unknown })?.type;
      log({
        kind: typeof parsedType === "string" ? parsedType.slice(0, 32) : "unknown",
        transport,
        sessionId: (raw as { sessionId?: unknown })?.sessionId,
        eventId: rawEventId,
        outcome: status,
        reason,
        httpStatus,
        latencyMs: +(performance.now() - t0).toFixed(1),
      });
      // 503 = the database didn't confirm the write; the client should resend the same eventId.
      const retryable = httpStatus === 503 || undefined;
      return {
        result: { type: "event.result" as const, eventId: rawEventId, status, reason, retryable },
        httpStatus,
        outcome,
      };
    };

    const parsed = EventSchema.safeParse(raw);
    if (!parsed.success) return done("rejected", 400, "Invalid event");
    const event = parsed.data;
    const session = sessions.get(event.sessionId);
    if (!session) return done("rejected", 404, "Unknown session");
    if (!ipLimiter.allow(ip)) return done("rejected", 429, "Rate limit exceeded");

    const outcome = await (event.type === "vote.submit"
      ? session.submitVote(event)
      : event.type === "session.join"
        ? session.recordMood(event)
        : session.recordTaps(event));

    if (outcome.status === "rejected") {
      return done("rejected", outcome.httpStatus, outcome.reason, outcome);
    }
    return done(outcome.status, 200, undefined, outcome);
  };
}

export function createApp(options: AppOptions) {
  const { sessions, corsOrigins, db, recommenders = new Map(), boosts } = options;
  const hostAuth = options.hostAuth ?? createDevKeyHostAuth(options.hostKey ?? "");
  if (!options.hostAuth && !options.hostKey) throw new Error("createApp needs hostAuth or hostKey");
  const intentLimiter = new RateLimiter(10, 60_000, options.now);
  const handleEvent = createEventHandler(options);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  const origins = originPolicy(corsOrigins ?? []);
  app.use(securityHeaders);
  app.use("/api", origins.middleware);
  app.use(cors(origins.list.length ? { origin: origins.list } : undefined));
  app.use(express.json({ limit: "4kb" }));

  // Where the stage QR code should send phones. Prefer PUBLIC_URL / JOIN_PUBLIC_URL; in
  // development fall back to a real Wi‑Fi LAN IP (never the first VPN adapter).
  app.get("/api/public-config", (_req, res) => {
    res.json({
      publicUrl: options.publicUrl ?? null,
      lanIp: options.exposeLanIp ? pickLanIp() : null,
      spotifyClientId: options.spotifyClientId ?? null,
    });
  });

  app.get("/api/health", async (_req, res) => {
    // Status only — never connection strings or other configuration.
    const database = db ? ((await db.ping()) ? "up" : "down") : "off";
    const anyRec = recommenders.values().next().value as RecommendationService | undefined;
    const gemini = anyRec?.status().configured ? "configured" : "off";
    res.json({ ok: true, service: "crowdpulse-server", database, gemini, time: new Date().toISOString() });
  });

  app.get("/api/sessions/:id/metrics", async (req, res) => {
    if (!sessions.has(req.params.id)) {
      res.status(404).json({ error: "Unknown session" });
      return;
    }
    if (!db) {
      res.json({ persistence: "memory" });
      return;
    }
    try {
      res.json(await db.metrics(req.params.id));
    } catch (err) {
      log({ kind: "db.metrics_failed", sessionId: req.params.id, message: (err as Error).message });
      res.status(503).json({ error: "Metrics unavailable — database query failed" });
    }
  });

  app.get("/api/sessions/:id/state", (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Unknown session" });
      return;
    }
    res.json(session.getState());
  });

  // HTTP mirrors of the WebSocket events (same validation path).
  const eventRoute =
    (type: string): RequestHandler<{ id: string }> =>
    async (req, res) => {
      const body = { ...(req.body ?? {}), type };
      if (body.sessionId !== req.params.id) {
        res.status(400).json({ status: "rejected", reason: "Session mismatch" });
        return;
      }
      const { result, httpStatus, outcome } = await handleEvent(body, req.ip ?? clientIp(req), "http");
      res.status(httpStatus).json(
        outcome && outcome.status !== "rejected"
          ? { status: outcome.status, state: outcome.state }
          : { status: result.status, reason: result.reason },
      );
    };
  app.post("/api/sessions/:id/votes", eventRoute("vote.submit"));
  app.post("/api/sessions/:id/moods", eventRoute("session.join"));
  app.post("/api/sessions/:id/taps", eventRoute("tap.batch"));

  // --- Host actions: Auth0 access token with a host permission (Doc 06), or the dev key locally ---
  const requireHost = hostAuth.require;

  app.get("/api/auth/config", (_req, res) => {
    res.json(hostAuth.publicConfig());
  });

  const hostSession: RequestHandler<{ id: string }> = (req, res, next) => {
    if (!sessions.has(req.params.id)) {
      res.status(404).json({ error: "Unknown session" });
      return;
    }
    next();
  };

  app.post("/api/host/sessions/:id/visual", ...requireHost, hostSession, async (req, res) => {
    const parsed = VisualSchema.safeParse(req.body?.visual);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid visual state" });
      return;
    }
    const outcome = await sessions.get(req.params.id)!.setVisual(parsed.data);
    if (outcome.status === "rejected") {
      res.status(outcome.httpStatus).json({ error: outcome.reason });
      return;
    }
    log({ kind: "host.visual", sessionId: req.params.id, outcome: "accepted", visual: parsed.data });
    res.json(outcome);
  });

  app.post("/api/host/sessions/:id/reset", ...requireHost, hostSession, async (req, res) => {
    const outcome = await sessions.get(req.params.id)!.reset();
    if (outcome.status === "rejected") {
      res.status(outcome.httpStatus).json({ error: outcome.reason });
      return;
    }
    recommenders.get(req.params.id)?.clear();
    log({ kind: "host.reset", sessionId: req.params.id, outcome: "accepted" });
    res.json(outcome);
  });

  // --- Playback: the player page on the DJ laptop reports; the host picks auto vs DJ mode ---
  const ModeSchema = z.object({ mode: z.enum(PLAYBACK_MODES as [PlaybackMode, ...PlaybackMode[]]) }).strict();
  const ReportSchema = z
    .object({
      event: z.enum(["started", "progress", "ended", "error"]),
      trackId: z.string().max(64),
      round: z.number().int().min(0),
      positionMs: z.number().min(0).max(24 * 3_600_000).optional(),
      durationMs: z.number().min(0).max(24 * 3_600_000).optional(),
      source: z.enum(["file", "generated", "spotify"]).optional(),
      message: z.string().max(200).optional(),
    })
    .strict();

  app.post("/api/host/sessions/:id/playback/mode", ...requireHost, hostSession, async (req, res) => {
    const parsed = ModeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid playback mode" });
      return;
    }
    const outcome = await sessions.get(req.params.id)!.setPlaybackMode(parsed.data.mode);
    if (outcome.status === "rejected") {
      res.status(outcome.httpStatus).json({ error: outcome.reason });
      return;
    }
    log({ kind: "host.playback_mode", sessionId: req.params.id, mode: parsed.data.mode });
    res.json(outcome);
  });

  app.post("/api/host/sessions/:id/playback/report", ...requireHost, hostSession, async (req, res) => {
    const parsed = ReportSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid playback report" });
      return;
    }
    const outcome = await sessions.get(req.params.id)!.reportPlayback(parsed.data);
    if (outcome.status === "rejected") {
      res.status(outcome.httpStatus).json({ error: outcome.reason });
      return;
    }
    if (parsed.data.event !== "progress") {
      log({ kind: "playback", sessionId: req.params.id, event: parsed.data.event, trackId: parsed.data.trackId });
    }
    res.json({ status: outcome.status, playback: outcome.state.playback, nowPlaying: outcome.state.nowPlaying });
  });

  app.post("/api/host/sessions/:id/advance", ...requireHost, hostSession, async (req, res) => {
    const outcome = await sessions.get(req.params.id)!.advance();
    if (outcome.status === "rejected") {
      res.status(outcome.httpStatus).json({ error: outcome.reason });
      return;
    }
    log({ kind: "host.advance", sessionId: req.params.id, outcome: "accepted" });
    res.json(outcome);
  });

  // --- Solana devnet boosts (Doc 05): optional, verified server-side before any effect ---
  const IntentSchema = z.object({ trackId: z.string().max(64), participantId }).strict();
  const VerifySchema = z
    .object({ sessionId, intentId: z.string().uuid(), signature: z.string().min(1).max(100) })
    .strict();

  app.get("/api/solana/config", (_req, res) => {
    res.json(boosts?.config() ?? { enabled: false, cluster: "devnet", lamports: 0, recipient: null });
  });

  app.post("/api/sessions/:id/boosts/intents", (req, res) => {
    const parsed = IntentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid boost request" });
      return;
    }
    if (!boosts) {
      res.status(503).json({ error: "Boosts are disabled on this server" });
      return;
    }
    if (!intentLimiter.allow(parsed.data.participantId)) {
      res.status(429).json({ error: "Too many boost requests — try again shortly" });
      return;
    }
    const intent = boosts.createIntent(req.params.id, parsed.data.trackId, parsed.data.participantId);
    if ("error" in intent) {
      res.status(intent.status).json({ error: intent.error });
      return;
    }
    res.status(201).json(intent);
  });

  app.post("/api/solana/boost/verify", async (req, res) => {
    const parsed = VerifySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ status: "rejected", reason: "Invalid verification request" });
      return;
    }
    if (!boosts) {
      res.status(503).json({ status: "rejected", reason: "Boosts are disabled on this server" });
      return;
    }
    const result = await boosts.verify(parsed.data);
    res.status(httpStatusFor(result.status)).json(result);
  });

  // --- AI DJ (Doc 04): Gemini proposes, server validates, host approves/rejects ---
  const TargetSchema = z.object({ hostTarget: z.enum(HOST_TARGETS as [HostTarget, ...HostTarget[]]) }).strict();

  app.get("/api/host/sessions/:id/recommendations", ...requireHost, hostSession, (req, res) => {
    const svc = recommenders.get(req.params.id);
    res.json({
      ai: svc?.status() ?? { configured: false, model: null, lastError: null, lastSuccessAt: null },
      recommendations: svc?.list() ?? [],
    });
  });

  app.post("/api/host/sessions/:id/recommendations", ...requireHost, hostSession, async (req, res) => {
    const svc = recommenders.get(req.params.id);
    const parsed = TargetSchema.safeParse(req.body ?? {});
    if (!svc || !parsed.success) {
      res.status(400).json({ error: "Invalid recommendation request" });
      return;
    }
    const result = await svc.recommend(parsed.data.hostTarget);
    if ("busy" in result) {
      res.status(409).json({ error: "A recommendation is already being generated" });
      return;
    }
    res.status(201).json({ ai: svc.status(), recommendation: result.recommendation });
  });

  app.post(
    "/api/host/sessions/:id/recommendations/:recId/:decision",
    ...requireHost,
    hostSession,
    async (req: express.Request<{ id: string; recId: string; decision: string }>, res: express.Response) => {
      const svc = recommenders.get(req.params.id);
      const { recId, decision } = req.params;
      if (!svc || (decision !== "approve" && decision !== "reject")) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      const result = decision === "approve" ? await svc.approve(recId) : await svc.reject(recId);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json(result);
    },
  );

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(authErrorHandler);

  return { app, handleEvent, isOriginAllowed: origins.isAllowed };
}
