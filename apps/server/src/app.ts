import cors from "cors";
import express, { type RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  MAX_TAPS_PER_BATCH,
  MOODS,
  THEME_ALLOWLIST,
  type EventResultMessage,
  type VisualTheme,
  type Mood,
} from "@crowdpulse/shared";
import { log } from "./log.js";
import { RateLimiter } from "./rateLimit.js";
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
  /** Temporary shared secret for host actions until Auth0 lands (Doc 06). */
  hostKey: string;
  corsOrigins?: string[];
  now?: () => number;
}

export function createEventHandler({ sessions, now = Date.now }: AppOptions) {
  // Per-participant limits live in SessionStore; this IP limit is generous because venue Wi-Fi shares IPs.
  const ipLimiter = new RateLimiter(600, 60_000, now);

  /** Validates and applies one client event from either HTTP or WebSocket. */
  return function handleEvent(
    raw: unknown,
    ip: string,
    transport: "http" | "ws",
  ): { result: EventResultMessage; httpStatus: number; outcome?: EventOutcome } {
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
      return { result: { type: "event.result" as const, eventId: rawEventId, status, reason }, httpStatus, outcome };
    };

    const parsed = EventSchema.safeParse(raw);
    if (!parsed.success) return done("rejected", 400, "Invalid event");
    const event = parsed.data;
    const session = sessions.get(event.sessionId);
    if (!session) return done("rejected", 404, "Unknown session");
    if (!ipLimiter.allow(ip)) return done("rejected", 429, "Rate limit exceeded");

    const outcome =
      event.type === "vote.submit"
        ? session.submitVote(event)
        : event.type === "session.join"
          ? session.recordMood(event)
          : session.recordTaps(event);

    if (outcome.status === "rejected") {
      return done("rejected", outcome.httpStatus, outcome.reason, outcome);
    }
    return done(outcome.status, 200, undefined, outcome);
  };
}

export function createApp(options: AppOptions) {
  const { sessions, hostKey, corsOrigins } = options;
  const handleEvent = createEventHandler(options);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(cors(corsOrigins?.length ? { origin: corsOrigins } : undefined));
  app.use(express.json({ limit: "4kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "crowdpulse-server", time: new Date().toISOString() });
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
    (req, res) => {
      const body = { ...(req.body ?? {}), type };
      if (body.sessionId !== req.params.id) {
        res.status(400).json({ status: "rejected", reason: "Session mismatch" });
        return;
      }
      const { result, httpStatus, outcome } = handleEvent(body, req.ip ?? "unknown", "http");
      res.status(httpStatus).json(
        outcome && outcome.status !== "rejected"
          ? { status: outcome.status, state: outcome.state }
          : { status: result.status, reason: result.reason },
      );
    };
  app.post("/api/sessions/:id/votes", eventRoute("vote.submit"));
  app.post("/api/sessions/:id/moods", eventRoute("session.join"));
  app.post("/api/sessions/:id/taps", eventRoute("tap.batch"));

  // --- Host actions (temporary shared-key gate; replaced by Auth0 roles in Doc 06) ---
  const requireHost: RequestHandler = (req, res, next) => {
    const given = Buffer.from(req.get("x-host-key") ?? "");
    const expected = Buffer.from(hostKey);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      log({ kind: "host", path: req.path, outcome: "unauthorized", httpStatus: 401 });
      res.status(401).json({ error: "Host key required" });
      return;
    }
    next();
  };

  const hostSession: RequestHandler<{ id: string }> = (req, res, next) => {
    if (!sessions.has(req.params.id)) {
      res.status(404).json({ error: "Unknown session" });
      return;
    }
    next();
  };

  app.post("/api/host/sessions/:id/visual", requireHost, hostSession, (req, res) => {
    const parsed = VisualSchema.safeParse(req.body?.visual);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid visual state" });
      return;
    }
    const state = sessions.get(req.params.id)!.setVisual(parsed.data);
    log({ kind: "host.visual", sessionId: req.params.id, outcome: "accepted", visual: parsed.data });
    res.json({ status: "accepted", state });
  });

  app.post("/api/host/sessions/:id/advance", requireHost, hostSession, (req, res) => {
    const outcome = sessions.get(req.params.id)!.advance();
    if (outcome.status === "rejected") {
      res.status(outcome.httpStatus).json({ error: outcome.reason });
      return;
    }
    log({ kind: "host.advance", sessionId: req.params.id, outcome: "accepted" });
    res.json(outcome);
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return { app, handleEvent };
}
