import cors from "cors";
import express, { type RequestHandler } from "express";
import { z } from "zod";
import {
  APPEARANCE_PRESETS,
  HOST_TARGETS,
  MAX_CATALOG_TRACKS,
  MAX_TRACKS_PER_ADD,
  PLAYLIST_NAME_MAX,
  HIGHLIGHT_CLIP_SECONDS,
  HIGHLIGHT_PARTS,
  type Highlight,
  type HighlightPart,
  type HighlightSettings,
  GENRE_PATTERN,
  SONG_REQUEST_LIMITS,
  SPOTIFY_IMAGE_URL,
  PLAYBACK_MODES,
  MAX_TAPS_PER_BATCH,
  MOODS,
  THEME_ALLOWLIST,
  type EventResultMessage,
  type AppearancePreset,
  type HostTarget,
  type LibraryAddResult,
  type PlaybackMode,
  type VisualTheme,
  type Mood,
} from "@crowdpulse/shared";
import { log } from "./log.js";
import { RateLimiter } from "./rateLimit.js";
import { authErrorHandler, createDevKeyHostAuth, type HostAuth } from "./auth.js";
import { clientIp, originPolicy, pickLanIp, securityHeaders } from "./http.js";
import type { Database } from "./db.js";
import { parseLiveTrack, spotifyTrackId, toSpotifyUri, type CatalogTrack } from "./catalog.js";
import type { RecommendationModel } from "./gemini.js";
import type { RecommendationService } from "./recommendation.js";
import { estimateSongs } from "./trackEstimator.js";
import { findSongs } from "./songFinder.js";
import { fetchSyncedLyrics, findHighlight, type SongInfo } from "./highlightFinder.js";
import { httpStatusFor, type BoostVerifier } from "./solana.js";
import type { EventOutcome, SessionStore } from "./session.js";
import { catalogTrackFromSpotify, type SpotifySearchClient } from "./spotify.js";

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
    genre: z.string().regex(GENRE_PATTERN).optional(),
  })
  .strict();
const RetractSchema = z
  .object({
    type: z.literal("vote.retract"),
    sessionId,
    trackId: z.string().max(64),
    eventId,
    participantId,
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
const EventSchema = z.discriminatedUnion("type", [VoteSchema, RetractSchema, JoinSchema, TapSchema]);
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
  /** Gemini model used to estimate genre/BPM/energy for imported songs; omitted → neutral defaults. */
  trackEstimator?: RecommendationModel;
  /** Gemini client for Find songs / Surprise me (needs room for up to 50 songs). */
  songFinder?: RecommendationModel;
  /** Gemini client for Highlights mode (a stronger model: finding a chorus takes real judgment). */
  highlightModel?: RecommendationModel;
  /** Time-synced lyrics lookup for Highlights mode (LRCLIB by default; tests pass a fake). */
  lyrics?: (title: string, artist: string) => Promise<SongInfo | null>;
  /** Solana devnet boost verifier; omitted means boosts are disabled. */
  boosts?: BoostVerifier;
  /** Browser origins allowed to call the API (and open WebSockets). Empty = any (development). */
  corsOrigins?: string[];
  /** The address attendees should open (production). Used for the stage QR code. */
  publicUrl?: string;
  /**
   * Spotify app Client ID for the player page's Spotify login (PKCE). Public by design.
   * Song search uses Client Credentials separately (see spotifySearch).
   */
  spotifyClientId?: string;
  /** Server-side Spotify search (Client Credentials). When set, phones can search real songs. */
  spotifySearch?: SpotifySearchClient;
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
      : event.type === "vote.retract"
        ? session.retractVote(event)
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
  const { sessions, corsOrigins, db, recommenders = new Map(), boosts, trackEstimator, spotifySearch } = options;
  const hostAuth = options.hostAuth ?? createDevKeyHostAuth(options.hostKey ?? "");
  if (!options.hostAuth && !options.hostKey) throw new Error("createApp needs hostAuth or hostKey");
  const intentLimiter = new RateLimiter(10, 60_000, options.now);
  const trackAddLimiter = new RateLimiter(30, 60_000, options.now);
  const handleEvent = createEventHandler(options);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  const origins = originPolicy(corsOrigins ?? []);
  app.use(securityHeaders);
  app.use("/api", origins.middleware);
  app.use(cors(origins.list.length ? { origin: origins.list } : undefined));
  // Small bodies everywhere (attendee events are tiny); the host's library import gets more room
  // because a 100-song playlist page is ~10 KB.
  const smallJson = express.json({ limit: "4kb" });
  const libraryJson = express.json({ limit: "64kb" });
  app.use((req, res, next) =>
    (req.method === "POST" && /^\/api\/host\/sessions\/[^/]+\/library$/.test(req.path)) ||
    (req.method === "PUT" && /^\/api\/host\/sessions\/[^/]+\/queue$/.test(req.path))
      ? libraryJson(req, res, next)
      : smallJson(req, res, next),
  );

  // Where the stage QR code should send phones. Prefer PUBLIC_URL / JOIN_PUBLIC_URL; in
  // development fall back to a real Wi‑Fi LAN IP (never the first VPN adapter).
  app.get("/api/public-config", (_req, res) => {
    res.json({
      publicUrl: options.publicUrl ?? null,
      lanIp: options.exposeLanIp ? pickLanIp() : null,
      spotifyClientId: options.spotifyClientId ?? null,
      spotifySearch: Boolean(spotifySearch?.configured),
    });
  });

  // Real-song search for the join/host UIs (Client Credentials). Playback still uses PKCE on /player.
  app.get("/api/spotify/search", async (req, res) => {
    if (!spotifySearch?.configured) {
      res.status(503).json({
        error:
          "Spotify search isn't configured. Set SPOTIFY_CLIENT_SECRET on the server (Client ID is already used for playback).",
      });
      return;
    }
    const q = typeof req.query.q === "string" ? req.query.q : "";
    if (q.trim().length < 2) {
      res.status(400).json({ error: "Type at least 2 characters to search" });
      return;
    }
    try {
      const tracks = await spotifySearch.search(q, 8);
      res.json({ tracks });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 502;
      res.status(status).json({ error: err instanceof Error ? err.message : "Spotify search failed" });
    }
  });

  // Album cover for a song already in a session's library (songs added before covers were saved).
  // Only library songs, so this can't be used as an open Spotify proxy.
  app.get("/api/spotify/cover/:trackId", async (req, res) => {
    const id = req.params.trackId;
    const uri = `spotify:track:${id}`;
    const inUse = (s: SessionStore) => s.catalogTracks().some((t) => t.spotifyUri === uri) || s.getState().nowPlaying?.spotifyUri === uri;
    if (!/^[A-Za-z0-9]{22}$/.test(id) || ![...sessions.values()].some(inUse)) {
      res.status(404).json({ error: "Not a song in this session" });
      return;
    }
    if (!spotifySearch?.configured) {
      res.json({ imageUrl: null });
      return;
    }
    try {
      res.set("cache-control", "public, max-age=86400").json({ imageUrl: await spotifySearch.cover(id) });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : "Cover lookup failed" });
    }
  });

  // Add a Spotify track to the live session catalog so attendees can vote on it.
  const AddTrackSchema = z
    .object({
      id: z.string().max(64).optional(),
      title: z.string().min(1).max(120),
      artist: z.string().min(1).max(120),
      spotifyUri: z.string().min(1).max(200),
      genre: z.string().min(1).max(40).optional(),
      bpm: z.number().min(40).max(220).optional(),
      energy: z.number().min(0).max(1).optional(),
      popularity: z.number().min(0).max(100).optional(),
      imageUrl: z.string().regex(SPOTIFY_IMAGE_URL).optional(),
      participantId: participantId.optional(),
    })
    .strict();

  app.post("/api/sessions/:id/tracks", async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Unknown session" });
      return;
    }
    const parsed = AddTrackSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid track" });
      return;
    }
    const ip = clientIp(req);
    if (!trackAddLimiter.allow(parsed.data.participantId ?? ip)) {
      res.status(429).json({ error: "Too many songs added — try again shortly" });
      return;
    }
    try {
      const uri = toSpotifyUri(parsed.data.spotifyUri) ?? parsed.data.spotifyUri;
      const spotifyId =
        parsed.data.id ??
        uri.match(/^spotify:track:([A-Za-z0-9]{22})$/)?.[1] ??
        uri.replace(/[^A-Za-z0-9]/g, "").slice(0, 22);
      const fromSpotify = catalogTrackFromSpotify({
        id: spotifyId,
        title: parsed.data.title,
        artist: parsed.data.artist,
        spotifyUri: uri,
        popularity: parsed.data.popularity,
        imageUrl: parsed.data.imageUrl,
      });
      // New song from an attendee: Gemini estimates its genre (for the by-genre song list) and
      // BPM/energy, like host imports. Songs already in the session skip the call.
      const known = session.catalogTracks().some((t) => t.id === fromSpotify.id || t.spotifyUri === fromSpotify.spotifyUri);
      const estimate =
        !known && !parsed.data.genre && trackEstimator
          ? (await estimateSongs(trackEstimator, [{ title: fromSpotify.title, artist: fromSpotify.artist }])).meta[0]
          : null;
      const track = parseLiveTrack({
        ...fromSpotify,
        ...(estimate?.metaSource === "gemini"
          ? { genre: estimate.genre, bpm: estimate.bpm, energy: estimate.energy, metaSource: "gemini" }
          : {}),
        ...(parsed.data.genre ? { genre: parsed.data.genre } : {}),
        ...(parsed.data.bpm != null ? { bpm: parsed.data.bpm } : {}),
        ...(parsed.data.energy != null ? { energy: parsed.data.energy } : {}),
      });
      const outcome = await session.addTrack(track);
      if (outcome.status === "rejected") {
        res.status(outcome.httpStatus).json({ error: outcome.reason });
        return;
      }
      log({ kind: "track.added", sessionId: req.params.id, trackId: track.id, title: track.title });
      res.status(201).json(outcome);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid track" });
    }
  });

  app.get("/api/health", async (_req, res) => {
    // Status only — never connection strings or other configuration.
    const database = db ? ((await db.ping()) ? "up" : "down") : "off";
    const anyRec = recommenders.values().next().value as RecommendationService | undefined;
    const gemini = anyRec?.status().configured ? "configured" : "off";
    res.json({ ok: true, service: "crowdpulse-server", database, gemini, time: new Date().toISOString() });
  });

  // Host-only: the analytics are for the signed-in host, not the public.
  app.get("/api/sessions/:id/metrics", ...hostAuth.require, async (req: express.Request<{ id: string }>, res: express.Response) => {
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
  app.post("/api/sessions/:id/votes/retract", eventRoute("vote.retract"));

  // An attendee's own state (their votes, mood, genre). The participant id is a random per-device
  // id, so this only ever shows a device its own choices.
  app.get("/api/sessions/:id/participants/:participantId", (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Unknown session" });
      return;
    }
    if (!participantId.safeParse(req.params.participantId).success) {
      res.status(400).json({ error: "Invalid participant" });
      return;
    }
    res.set("cache-control", "no-store").json(session.participantState(req.params.participantId));
  });
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
      playerId: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/).optional(),
      clipStartMs: z.number().min(0).max(24 * 3_600_000).optional(),
      clipEndMs: z.number().min(0).max(24 * 3_600_000).optional(),
    })
    .strict();

  // --- Music library: songs the host imports from Spotify (playlist or search) ---
  const LibraryAddSchema = z
    .object({
      tracks: z
        .array(
          z
            .object({
              title: z.string().trim().min(1).max(120),
              artist: z.string().trim().min(1).max(120),
              spotifyUri: z.string().max(120),
              imageUrl: z.string().regex(SPOTIFY_IMAGE_URL).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_TRACKS_PER_ADD),
    })
    .strict();

  app.post("/api/host/sessions/:id/library", ...requireHost, hostSession, async (req, res) => {
    const parsed = LibraryAddSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid songs" });
      return;
    }
    const session = sessions.get(req.params.id)!;
    const known = new Set(session.catalogTracks().map((t) => t.spotifyUri).filter(Boolean));
    // Normalize, drop bad URIs and anything already in the library before spending Gemini calls.
    const seen = new Set<string>();
    const songs = parsed.data.tracks.flatMap((t) => {
      const uri = toSpotifyUri(t.spotifyUri);
      const id = uri && spotifyTrackId(uri);
      if (!uri || !id || known.has(uri) || seen.has(uri)) return [];
      seen.add(uri);
      return [{ ...t, spotifyUri: uri, id: `sp_${id}` }];
    });
    const alreadyThere = parsed.data.tracks.length - songs.length;
    if (!songs.length) {
      const body: LibraryAddResult = { added: 0, skipped: alreadyThere, estimatedBy: null, note: "Those songs are already in the library", trackIds: [] };
      res.json(body);
      return;
    }

    const { meta, note } = await estimateSongs(trackEstimator, songs);
    const tracks: CatalogTrack[] = songs.map((s, i) => ({
      id: s.id,
      title: s.title,
      artist: s.artist,
      spotifyUri: s.spotifyUri,
      ...(s.imageUrl ? { imageUrl: s.imageUrl } : {}),
      genre: meta[i].genre,
      bpm: meta[i].bpm,
      energy: meta[i].energy,
      metaSource: meta[i].metaSource,
    }));
    const outcome = await session.addTracks(tracks);
    if (outcome.status === "rejected") {
      res.status(outcome.httpStatus).json({ error: outcome.reason });
      return;
    }
    const sources = new Set(tracks.filter((t) => outcome.added?.includes(t.id)).map((t) => t.metaSource));
    const body: LibraryAddResult = {
      added: outcome.added?.length ?? 0,
      skipped: alreadyThere + (outcome.skipped ?? 0),
      estimatedBy: sources.size === 2 ? "mixed" : sources.has("gemini") ? "gemini" : "default",
      note,
      trackIds: outcome.added ?? [],
    };
    log({ kind: "host.library_add", sessionId: req.params.id, added: body.added, skipped: body.skipped, estimatedBy: body.estimatedBy });
    res.json(body);
  });

  app.delete("/api/host/sessions/:id/library/:trackId", ...requireHost, hostSession, async (req: express.Request<{ id: string; trackId: string }>, res: express.Response) => {
    const outcome = await sessions.get(req.params.id)!.removeTrack(req.params.trackId);
    if (outcome.status === "rejected") {
      res.status(outcome.httpStatus).json({ error: outcome.reason });
      return;
    }
    log({ kind: "host.library_remove", sessionId: req.params.id, trackId: req.params.trackId });
    res.json({ status: "accepted" });
  });

  app.delete("/api/host/sessions/:id/library", ...requireHost, hostSession, async (req, res) => {
    const outcome = await sessions.get(req.params.id)!.clearLibrary();
    if (outcome.status === "rejected") {
      res.status(outcome.httpStatus).json({ error: outcome.reason });
      return;
    }
    log({ kind: "host.library_clear", sessionId: req.params.id, removed: outcome.removed });
    res.json(outcome);
  });

  // The host's own queue: ordered song ids that play before voted songs (also used by Shuffle).
  const QueueSchema = z.object({ trackIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).max(MAX_CATALOG_TRACKS) }).strict();
  app.put("/api/host/sessions/:id/queue", ...requireHost, hostSession, async (req, res) => {
    const parsed = QueueSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid queue" });
      return;
    }
    const outcome = await sessions.get(req.params.id)!.setHostQueue(parsed.data.trackIds);
    if (outcome.status === "rejected") {
      res.status(outcome.httpStatus).json({ error: outcome.reason });
      return;
    }
    log({ kind: "host.queue", sessionId: req.params.id, songs: parsed.data.trackIds.length });
    res.json(outcome);
  });

  const SeekSchema = z.object({ positionMs: z.number().int().min(0).max(24 * 3_600_000) }).strict();
  app.post("/api/host/sessions/:id/playback/seek", ...requireHost, hostSession, async (req, res) => {
    const parsed = SeekSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid position" });
      return;
    }
    const outcome = await sessions.get(req.params.id)!.seek(parsed.data.positionMs);
    if (outcome.status === "rejected") {
      res.status(outcome.httpStatus).json({ error: outcome.reason });
      return;
    }
    res.json(outcome);
  });

  const AppearanceSchema = z
    .object({
      preset: z.enum(APPEARANCE_PRESETS as unknown as [AppearancePreset, ...AppearancePreset[]]),
      mode: z.enum(["light", "dark"]),
      showEnergy: z.boolean().optional(),
    })
    .strict();

  app.post("/api/host/sessions/:id/appearance", ...requireHost, hostSession, async (req, res) => {
    const parsed = AppearanceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid appearance" });
      return;
    }
    const outcome = await sessions.get(req.params.id)!.setAppearance(parsed.data);
    if (outcome.status === "rejected") {
      res.status(outcome.httpStatus).json({ error: outcome.reason });
      return;
    }
    log({ kind: "host.appearance", sessionId: req.params.id, ...parsed.data });
    res.json(outcome);
  });

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

  // Optional { trackId } plays that song next (e.g. "Play next" from the host's search);
  // without it, the top-voted song plays.
  const AdvanceSchema = z.object({ trackId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional() }).strict();

  app.post("/api/host/sessions/:id/advance", ...requireHost, hostSession, async (req, res) => {
    const parsed = AdvanceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid track" });
      return;
    }
    const outcome = await sessions.get(req.params.id)!.advance(parsed.data.trackId);
    if (outcome.status === "rejected") {
      res.status(outcome.httpStatus).json({ error: outcome.reason });
      return;
    }
    log({ kind: "host.advance", sessionId: req.params.id, outcome: "accepted", trackId: parsed.data.trackId ?? null });
    res.json(outcome);
  });

  // ⏸ / ▶ / ⏮ — the player (wherever it is) follows the session state.
  const playbackAction =
    (name: "pause" | "resume" | "previous"): express.RequestHandler<{ id: string }> =>
    async (req, res) => {
      const outcome = await sessions.get(req.params.id)![name]();
      if (outcome.status === "rejected") {
        res.status(outcome.httpStatus).json({ error: outcome.reason });
        return;
      }
      log({ kind: `host.${name}`, sessionId: req.params.id });
      res.json(outcome);
    };
  app.post("/api/host/sessions/:id/playback/pause", ...requireHost, hostSession, playbackAction("pause"));
  app.post("/api/host/sessions/:id/playback/resume", ...requireHost, hostSession, playbackAction("resume"));
  app.post("/api/host/sessions/:id/previous", ...requireHost, hostSession, playbackAction("previous"));
  const StageViewSchema = z.object({ panel: z.enum(["queue", "votes"]), auto: z.boolean() }).strict();
  app.post("/api/host/sessions/:id/stage-view", ...requireHost, hostSession, async (req, res) => {
    const parsed = StageViewSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid projector view" });
      return;
    }
    const outcome = await sessions.get(req.params.id)!.setStageView(parsed.data);
    if (outcome.status === "rejected") {
      res.status(outcome.httpStatus).json({ error: outcome.reason });
      return;
    }
    res.json(outcome);
  });

  app.post("/api/host/sessions/:id/crowd/reset", ...requireHost, hostSession, async (req, res) => {
    const outcome = await sessions.get(req.params.id)!.resetCrowd();
    if (outcome.status === "rejected") {
      res.status(outcome.httpStatus).json({ error: outcome.reason });
      return;
    }
    log({ kind: "host.crowd_reset", sessionId: req.params.id });
    res.json(outcome);
  });

  // --- Saved playlists (host-only): name, store, load back into the library ---
  const PlaylistName = z
    .string()
    .trim()
    .min(1)
    .max(PLAYLIST_NAME_MAX)
    .refine((n) => !/[\u0000-\u001f<>]/.test(n), "plain text only");
  const sendOutcome = (res: express.Response, outcome: EventOutcome & Record<string, unknown>) => {
    if (outcome.status === "rejected") {
      res.status(outcome.httpStatus).json({ error: outcome.reason });
      return;
    }
    res.json(outcome);
  };

  app.get("/api/host/sessions/:id/playlists", ...requireHost, hostSession, (req, res) => {
    res.json({ playlists: sessions.get(req.params.id)!.listPlaylists() });
  });

  app.get("/api/host/sessions/:id/playlists/:pid", ...requireHost, hostSession, (req: express.Request<{ id: string; pid: string }>, res: express.Response) => {
    const pl = sessions.get(req.params.id)!.getPlaylist(req.params.pid);
    if (!pl) {
      res.status(404).json({ error: "Unknown playlist" });
      return;
    }
    res.json(pl);
  });

  // Save the current library as a new playlist ({name}) — or as an existing one's songs ({id}).
  const SavePlaylistSchema = z.object({ name: PlaylistName.optional(), id: z.string().max(40).optional() }).strict();
  app.post("/api/host/sessions/:id/playlists", ...requireHost, hostSession, async (req, res) => {
    const parsed = SavePlaylistSchema.safeParse(req.body ?? {});
    if (!parsed.success || (!parsed.data.name && !parsed.data.id)) {
      res.status(400).json({ error: "Give the playlist a name (up to 60 characters)" });
      return;
    }
    sendOutcome(res, await sessions.get(req.params.id)!.savePlaylist(parsed.data));
  });

  app.patch("/api/host/sessions/:id/playlists/:pid", ...requireHost, hostSession, async (req: express.Request<{ id: string; pid: string }>, res: express.Response) => {
    const parsed = z.object({ name: PlaylistName }).strict().safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Give the playlist a name (up to 60 characters)" });
      return;
    }
    sendOutcome(res, await sessions.get(req.params.id)!.renamePlaylist(req.params.pid, parsed.data.name));
  });

  app.delete("/api/host/sessions/:id/playlists/:pid", ...requireHost, hostSession, async (req: express.Request<{ id: string; pid: string }>, res: express.Response) => {
    sendOutcome(res, await sessions.get(req.params.id)!.deletePlaylist(req.params.pid));
  });

  const LoadPlaylistSchema = z.object({ replace: z.boolean().default(false), queue: z.boolean().default(false) }).strict();
  app.post("/api/host/sessions/:id/playlists/:pid/load", ...requireHost, hostSession, async (req: express.Request<{ id: string; pid: string }>, res: express.Response) => {
    const parsed = LoadPlaylistSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid load options" });
      return;
    }
    sendOutcome(res, await sessions.get(req.params.id)!.loadPlaylist(req.params.pid, parsed.data));
  });

  // --- Highlights mode: play only each song's best bit ---
  const HighlightSettingsSchema = z
    .object({
      enabled: z.boolean(),
      clipSec: z.number().refine((n) => (HIGHLIGHT_CLIP_SECONDS as readonly number[]).includes(n), "clip length must be 30, 45, 60 or 90"),
      part: z.enum(HIGHLIGHT_PARTS as [HighlightPart, ...HighlightPart[]]),
      transition: z.enum(["cut", "fade"]),
    })
    .strict();
  app.post("/api/host/sessions/:id/playback/highlights", ...requireHost, hostSession, async (req, res) => {
    const parsed = HighlightSettingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid highlights settings" });
      return;
    }
    const outcome = await sessions.get(req.params.id)!.setHighlights(parsed.data as HighlightSettings);
    if (outcome.status === "rejected") {
      res.status(outcome.httpStatus).json({ error: outcome.reason });
      return;
    }
    res.json(outcome);
  });

  // Where a song's highlight starts (found once, then saved). The player asks right before playing.
  const highlightJobs = new Map<string, Promise<Highlight>>();
  app.get("/api/host/sessions/:id/highlight/:trackId", ...requireHost, hostSession, async (req: express.Request<{ id: string; trackId: string }>, res: express.Response) => {
    const session = sessions.get(req.params.id)!;
    const part = HIGHLIGHT_PARTS.includes(req.query.part as HighlightPart) ? (req.query.part as HighlightPart) : "auto";
    const track = session.catalogTracks().find((t) => t.id === req.params.trackId);
    if (!track) {
      res.status(404).json({ error: "Unknown track" });
      return;
    }
    const known = session.getHighlight(track.id, part);
    if (known) {
      res.json(known);
      return;
    }
    const key = `${req.params.id}|${track.id}|${part}`;
    let job = highlightJobs.get(key);
    if (!job) {
      job = (async () => {
        const lyrics = await (options.lyrics ?? fetchSyncedLyrics)(track.title, track.artist);
        const everyday = options.songFinder ?? trackEstimator;
        const found = await findHighlight(options.highlightModel ?? everyday, track, part, lyrics, everyday);
        if (found.source !== "default") await session.saveHighlight(track.id, part, found);
        return found;
      })().finally(() => highlightJobs.delete(key));
      highlightJobs.set(key, job);
    }
    res.json(await job);
  });

  // The host nudged a highlight (±10 s): remember it for next time.
  const NudgeSchema = z
    .object({
      part: z.enum(HIGHLIGHT_PARTS as [HighlightPart, ...HighlightPart[]]),
      startMs: z.number().int().min(0).max(3_600_000),
      endMs: z.number().int().min(0).max(3_600_000).optional(),
    })
    .strict();
  app.put("/api/host/sessions/:id/highlight/:trackId", ...requireHost, hostSession, async (req: express.Request<{ id: string; trackId: string }>, res: express.Response) => {
    const parsed = NudgeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid highlight" });
      return;
    }
    const highlight = { startMs: parsed.data.startMs, endMs: parsed.data.endMs ?? null, source: "host" as const };
    const ok = await sessions.get(req.params.id)!.saveHighlight(req.params.trackId, parsed.data.part, highlight);
    if (!ok) {
      res.status(404).json({ error: "Unknown track" });
      return;
    }
    res.json(highlight);
  });

  const RepeatSchema = z.object({ repeat: z.boolean() }).strict();
  app.post("/api/host/sessions/:id/playback/repeat", ...requireHost, hostSession, async (req, res) => {
    const parsed = RepeatSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid repeat setting" });
      return;
    }
    const outcome = await sessions.get(req.params.id)!.setRepeat(parsed.data.repeat);
    if (outcome.status === "rejected") {
      res.status(outcome.httpStatus).json({ error: outcome.reason });
      return;
    }
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
  // Shared by recommendations and Find / Surprise me: genre + popularity (all-time Spotify streams).
  const streams = z.number().int().min(0).max(SONG_REQUEST_LIMITS.maxStreams).nullable();
  const plainText = (max: number) =>
    z
      .string()
      .trim()
      .max(max)
      // Plain text only: no control characters, links or markup.
      .refine((s) => !/[\u0000-\u0008\u000b-\u001f<>]|https?:\/\//i.test(s), "plain text only");
  const filters = {
    genres: z.array(z.string().trim().toLowerCase().regex(GENRE_PATTERN)).max(SONG_REQUEST_LIMITS.maxGenres),
    artists: z
      .array(z.string().trim().min(1).max(80).refine((a) => !/[\u0000-\u001f<>]|https?:\/\//i.test(a), "plain text only"))
      .max(SONG_REQUEST_LIMITS.maxArtists)
      .default([]),
    includeFeatures: z.boolean().default(false),
    artistHint: plainText(120).optional(),
    minStreams: streams,
    maxStreams: streams,
  };
  const rangeOk = (r: { minStreams: number | null; maxStreams: number | null }) =>
    r.minStreams == null || r.maxStreams == null || r.minStreams <= r.maxStreams;
  const RequestSchema = z
    .object({ prompt: plainText(SONG_REQUEST_LIMITS.promptMax), ...filters })
    .strict()
    .refine(rangeOk, "minStreams must be ≤ maxStreams");
  const TargetSchema = z
    // The host target is optional (no target = Gemini goes by the crowd alone).
    .object({ hostTarget: z.enum(HOST_TARGETS as [HostTarget, ...HostTarget[]]).nullable().default(null), request: RequestSchema.optional() })
    .strict();

  // Songs from outside the library: Find (lyrics / a description) or Surprise me (random in a
  // genre + popularity range, favoring popular songs). Gemini names them; Spotify confirms them.
  const FindSchema = z
    .object({
      text: plainText(300).optional(),
      surprise: z.boolean().optional(),
      count: z.number().int().min(1).max(SONG_REQUEST_LIMITS.maxFind).optional(),
      ...filters,
    })
    .strict()
    .refine(rangeOk, "minStreams must be ≤ maxStreams")
    // Something to go on: text, or at least an artist / artist description / genre.
    .refine(
      (f) => f.surprise || (f.text ?? "").length >= 2 || f.artists.length > 0 || !!f.artistHint?.trim() || f.genres.length > 0,
      "Type something, or pick an artist or genre",
    );
  app.post("/api/host/sessions/:id/find-songs", ...requireHost, hostSession, async (req, res) => {
    const parsed = FindSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }
    const library = sessions.get(req.params.id)!.catalogTracks();
    try {
      res.json(
        await findSongs(options.songFinder ?? trackEstimator, spotifySearch, {
          ...parsed.data,
          // A surprise should be something new: skip what's already in the library.
          exclude: parsed.data.surprise ? library.map((t) => `${t.title} — ${t.artist}`) : [],
        }),
      );
    } catch (err) {
      log({ kind: "ai.find_songs", outcome: "failed", message: (err as Error).message });
      res.status(502).json({ error: `Gemini couldn't answer: ${(err as Error).message}` });
    }
  });

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
    const result = await svc.recommend(parsed.data.hostTarget, parsed.data.request ?? null);
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
