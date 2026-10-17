import type { ErrorRequestHandler, RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
import { auth, UnauthorizedError } from "express-oauth2-jwt-bearer";
import type { AuthConfig } from "@crowdpulse/shared";
import { log } from "./log.js";

// Host authorization (Doc 06). Attendees are anonymous and never need a token; every host
// endpoint requires either an Auth0 access token with a host permission, or — only when Auth0
// is not configured and not in production — the local dev key.

export interface Auth0Settings {
  /** Tenant domain, e.g. crowdpulse.us.auth0.com */
  domain: string;
  /** API identifier configured in Auth0 (the token's `aud`). */
  audience: string;
  /** SPA client ID. Public — safe to send to the browser. */
  clientId: string;
  /** Overrides for tests; default derives from the domain. */
  issuer?: string;
  jwksUri?: string;
}

export interface HostAuth {
  mode: "auth0" | "dev-key";
  /** Middleware chain for routes with an `:id` session param. */
  require: RequestHandler[];
  publicConfig(): AuthConfig;
}

/** A token may control session X with `host:X`, or every session with `host:*`. */
export function hostPermissionFor(sessionId: string) {
  return [`host:${sessionId}`, "host:*"];
}

export function createAuth0HostAuth(settings: Auth0Settings): HostAuth {
  const issuer = settings.issuer ?? `https://${settings.domain}/`;
  const validateToken = auth({
    issuer,
    audience: settings.audience,
    jwksUri: settings.jwksUri ?? `https://${settings.domain}/.well-known/jwks.json`,
    tokenSigningAlg: "RS256",
  });

  // Signature, issuer, audience, expiry and algorithm are checked by validateToken (401 on failure).
  // This adds the role check: a valid token without a host permission for this session is a 403.
  const requirePermission: RequestHandler<{ id: string }> = (req, res, next) => {
    const payload = req.auth?.payload;
    const permissions = Array.isArray(payload?.permissions) ? (payload.permissions as unknown[]) : [];
    const allowed = hostPermissionFor(req.params.id).some((p) => permissions.includes(p));
    if (!allowed) {
      log({ kind: "auth", outcome: "forbidden", httpStatus: 403, sub: payload?.sub, sessionId: req.params.id, path: req.path });
      res.status(403).json({ error: `Forbidden — this account is not a host for session "${req.params.id}"` });
      return;
    }
    next();
  };

  return {
    mode: "auth0",
    require: [validateToken, requirePermission as unknown as RequestHandler],
    publicConfig: () => ({
      mode: "auth0",
      domain: settings.domain,
      clientId: settings.clientId,
      audience: settings.audience,
    }),
  };
}

export function createDevKeyHostAuth(hostKey: string): HostAuth {
  const requireKey: RequestHandler = (req, res, next) => {
    const given = Buffer.from(req.get("x-host-key") ?? "");
    const expected = Buffer.from(hostKey);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      log({ kind: "auth", path: req.path, outcome: "unauthorized", httpStatus: 401 });
      res.status(401).json({ error: "Host key required" });
      return;
    }
    next();
  };
  return { mode: "dev-key", require: [requireKey], publicConfig: () => ({ mode: "dev-key" }) };
}

/** Turns Auth0 SDK errors into JSON 401/403s. Never echoes the token or Authorization header. */
export const authErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (!(err instanceof UnauthorizedError)) return next(err);
  log({ kind: "auth", outcome: "unauthorized", httpStatus: err.status, path: req.path, reason: err.message });
  res.set(err.headers);
  res.status(err.status).json({
    error: err.status === 403 ? "Forbidden" : "Unauthorized — sign in as a host",
  });
};
