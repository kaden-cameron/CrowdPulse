import type { IncomingMessage } from "node:http";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import type { RequestHandler } from "express";
import { log } from "./log.js";

// Deployment hardening (Doc 07): client IPs behind the reverse proxy, an origin allowlist for
// browsers (HTTP and WebSocket), and baseline security headers.

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Interface names that are almost never reachable from a phone on venue Wi‑Fi. */
const SKIP_IFACE = /vpn|proton|tailscale|zerotier|hamachi|tun|tap|vethernet|hyper-v|docker|veth|vmware|virtualbox|vbox|wsl|loopback/i;

/**
 * Pick a LAN IPv4 phones on the same Wi‑Fi can open. Skips VPNs (/32), VMware host-only,
 * and similar virtual adapters — the first `networkInterfaces()` entry is often ProtonVPN.
 */
export function pickLanIp(
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string | null {
  const scored: { address: string; score: number }[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list || SKIP_IFACE.test(name)) continue;
    for (const a of list) {
      const family = typeof a.family === "string" ? a.family : a.family === 4 ? "IPv4" : "IPv6";
      if (family !== "IPv4" || a.internal) continue;
      if (a.cidr?.endsWith("/32")) continue;
      const address = a.address;
      let score = 0;
      if (/^192\.168\./.test(address)) score += 30;
      else if (/^10\./.test(address)) score += 20;
      else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) score += 15;
      else continue;
      if (/wi-?fi|wlan|wireless|airport/i.test(name)) score += 100;
      else if (/ethernet|eth\d|local area connection|en\d/i.test(name)) score += 50;
      if (/\.1$/.test(address)) score -= 10;
      scored.push({ address, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.address ?? null;
}

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
