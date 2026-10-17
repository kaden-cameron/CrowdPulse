import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type Sessions } from "../src/app.js";
import { clientIp } from "../src/http.js";
import { SessionStore } from "../src/session.js";

const req = (remoteAddress: string, xff?: string) =>
  ({ socket: { remoteAddress }, headers: xff ? { "x-forwarded-for": xff } : {} }) as unknown as IncomingMessage;

describe("client IP behind the reverse proxy", () => {
  it("uses X-Forwarded-For only when the connection comes from the local proxy", () => {
    expect(clientIp(req("127.0.0.1", "198.51.100.7, 10.0.0.1"))).toBe("198.51.100.7");
    expect(clientIp(req("::ffff:127.0.0.1", "198.51.100.8"))).toBe("198.51.100.8");
    // A client connecting directly can't spoof its IP with the header.
    expect(clientIp(req("203.0.113.9", "1.2.3.4"))).toBe("203.0.113.9");
    expect(clientIp(req("127.0.0.1"))).toBe("127.0.0.1");
  });
});

describe("VU-08: origin allowlist (policy)", () => {
  const PUBLIC = "https://203-0-113-7.sslip.io";
  const make = () => {
    const sessions: Sessions = new Map([["demo", new SessionStore("demo", "Demo")]]);
    return createApp({ sessions, hostKey: "k", corsOrigins: [PUBLIC] });
  };
  const vote = () => ({ sessionId: "demo", trackId: "track_01", eventId: randomUUID(), participantId: "participant_o1" });

  it("allows the app's own origin and returns CORS headers for it", async () => {
    const { app } = make();
    const res = await request(app).post("/api/sessions/demo/votes").set("origin", PUBLIC).send(vote());
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(PUBLIC);
  });

  it("rejects an unapproved browser origin with 403 before anything happens", async () => {
    const { app } = make();
    const res = await request(app).post("/api/sessions/demo/votes").set("origin", "https://evil.example").send(vote());
    expect(res.status).toBe(403);
    const pre = await request(app).options("/api/sessions/demo/votes").set("origin", "https://evil.example");
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("applies the same rule to WebSocket upgrades", () => {
    const { isOriginAllowed } = make();
    expect(isOriginAllowed(PUBLIC)).toBe(true);
    expect(isOriginAllowed("https://evil.example")).toBe(false);
    expect(isOriginAllowed(undefined)).toBe(true); // non-browser clients
  });

  it("sends baseline security headers", async () => {
    const { app } = make();
    const res = await request(app).get("/api/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("allows any origin in development (no list configured)", async () => {
    const sessions: Sessions = new Map([["demo", new SessionStore("demo", "Demo")]]);
    const { app } = createApp({ sessions, hostKey: "k" });
    const res = await request(app).post("/api/sessions/demo/votes").set("origin", "http://192.168.1.20:5173").send(vote());
    expect(res.status).toBe(200);
  });
});

describe("venue Wi-Fi: many attendees behind one IP", () => {
  it("100 different attendees from one IP are not throttled by the IP backstop", async () => {
    const sessions: Sessions = new Map([["demo", new SessionStore("demo", "Demo")]]);
    const { app } = createApp({ sessions, hostKey: "k" });
    const statuses = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        request(app)
          .post("/api/sessions/demo/taps")
          .send({ sessionId: "demo", count: 3, eventId: randomUUID(), participantId: `participant_venue${String(i).padStart(3, "0")}` })
          .then((r) => r.status),
      ),
    );
    expect(statuses.filter((s) => s === 429)).toHaveLength(0);
  });
});

describe("stage QR link config", () => {
  it("returns PUBLIC_URL, and only shares the LAN IP when allowed (development)", async () => {
    const sessions: Sessions = new Map([["demo", new SessionStore("demo", "Demo")]]);
    const prod = createApp({ sessions, hostKey: "k", publicUrl: "https://203-0-113-7.sslip.io" }).app;
    expect((await request(prod).get("/api/public-config")).body).toEqual({ publicUrl: "https://203-0-113-7.sslip.io", lanIp: null, spotifyClientId: null });
    const dev = createApp({ sessions, hostKey: "k", exposeLanIp: true }).app;
    const body = (await request(dev).get("/api/public-config")).body;
    expect(body.publicUrl).toBeNull();
    expect(body.lanIp === null || /^\d+\.\d+\.\d+\.\d+$/.test(body.lanIp)).toBe(true);
  });
});
