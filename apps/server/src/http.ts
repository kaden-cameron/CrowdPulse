import type { IncomingMessage } from "node:http";
import type { RequestHandler } from "express";
import { log } from "./log.js";

// Deployment hardening (Doc 07): client IPs behind the reverse proxy, an origin allowlist for
// browsers (HTTP and WebSocket), and baseline security headers.

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * The real client IP. Only trusts X-Forwarded-For when the connection comes from the local
 * reverse proxy (Caddy on the same host), matching Express's `trust proxy: "loopback"`.
 */
export function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? "unknown";
  const fwd = req.headers["x-forwarded-for"];
  if (LOOPBACK.has(remote) && typeof fwd === "string" && fwd.trim()) {
    return fwd.split(",")[0].trim();
  }
  return remote;
}

/**
 * Origin policy. `allowed` empty means "any origin" (local development).
 * Requests without an Origin header (curl, server-to-server) are judged by auth, not origin.
 */
export function originPolicy(allowed: string[]) {
  const set = new Set(allowed.map((o) => o.replace(/\/+$/, "")));
  const isAllowed = (origin: string | undefined) => !origin || set.size === 0 || set.has(origin);

  /** Browsers on an unapproved origin get 403 before any handler runs (VU-08). */
  const middleware: RequestHandler = (req, res, next) => {
    const origin = req.get("origin");
    if (isAllowed(origin)) return next();
    log({ kind: "origin", outcome: "rejected", origin, path: req.path, httpStatus: 403 });
    res.status(403).json({ error: "Origin not allowed" });
  };

  return { isAllowed, middleware, list: [...set] };
}

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  next();
};
