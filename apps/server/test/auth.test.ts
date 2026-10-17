import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type Sessions } from "../src/app.js";
import { createAuth0HostAuth } from "../src/auth.js";
import { SessionStore } from "../src/session.js";

// A local stand-in for an Auth0 tenant: our own RSA key served as a JWKS, so tokens are
// validated by the real express-oauth2-jwt-bearer code path (signature, iss, aud, exp, alg).

const ISSUER = "https://crowdpulse-test.us.auth0.com/";
const AUDIENCE = "https://api.crowdpulse.test";
let jwksServer: Server;
let jwksUri: string;
let privateKey: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  jwksServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => jwksServer.listen(0, "127.0.0.1", r));
  jwksUri = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/.well-known/jwks.json`;
});

afterAll(() => {
  jwksServer.close();
});

async function token(
  claims: Record<string, unknown> = {},
  opts: { key?: CryptoKey; iss?: string; aud?: string; exp?: number | string; kid?: string } = {},
) {
  return new SignJWT({ permissions: [], ...claims })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "test-key" })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setSubject("auth0|host-1")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "10m")
    .sign(opts.key ?? privateKey);
}

let store: SessionStore;
let app: ReturnType<typeof createApp>["app"];

beforeEach(() => {
  store = new SessionStore("demo", "Demo");
  const other = new SessionStore("other", "Other");
  const sessions: Sessions = new Map([
    ["demo", store],
    ["other", other],
  ]);
  const hostAuth = createAuth0HostAuth({
    domain: "crowdpulse-test.us.auth0.com",
    audience: AUDIENCE,
    clientId: "spa-client-id",
    issuer: ISSUER,
    jwksUri,
  });
  ({ app } = createApp({ sessions, hostAuth }));
});

const setVisual = (auth?: Record<string, string>) => {
  const req = request(app).post("/api/host/sessions/demo/visual");
  for (const [k, v] of Object.entries(auth ?? {})) req.set(k, v);
  return req.send({ visual: { theme: "sunset", intensity: 0.9 } });
};
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe("Auth0 host authorization (Doc 06)", () => {
  it("AU-04: a host token with host:demo can change the stage", async () => {
    const res = await setVisual(bearer(await token({ permissions: ["host:demo"] })));
    expect(res.status).toBe(200);
    expect(store.getState().visualState).toEqual({ theme: "sunset", intensity: 0.9 });
  });

  it("host:* works for any session", async () => {
    expect((await setVisual(bearer(await token({ permissions: ["host:*"] })))).status).toBe(200);
  });

  it("AU-02: no token → 401 and no side effect", async () => {
    const res = await setVisual();
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/Bearer/);
    expect(store.getState().visualMode).toBe("auto");
  });

  it("AU-03: a signed-in attendee without host permission → 403, stage unchanged", async () => {
    const res = await setVisual(bearer(await token({ permissions: [] })));
    expect(res.status).toBe(403);
    expect(store.getState().visualMode).toBe("auto");
  });

  it("AU-05: expired, malformed, wrong-key, wrong-issuer, and wrong-audience tokens → 401", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const bad = [
      await token({ permissions: ["host:demo"] }, { exp: past }),
      "not.a.jwt",
      await token({ permissions: ["host:demo"] }, { key: otherKey }),
      await token({ permissions: ["host:demo"] }, { iss: "https://evil.example/" }),
      await token({ permissions: ["host:demo"] }, { aud: "https://some-other-api" }),
    ];
    for (const t of bad) {
      const res = await setVisual(bearer(t));
      expect(res.status).toBe(401);
    }
    expect(store.getState().visualMode).toBe("auto");
  });

  it("AU-05: an unsigned (alg: none) token is rejected", async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${enc({ alg: "none", typ: "JWT" })}.${enc({ iss: ISSUER, aud: AUDIENCE, sub: "x", exp: now + 600, permissions: ["host:*"] })}.`;
    expect((await setVisual(bearer(unsigned))).status).toBe(401);
  });

  it("AU-06: a host for another session can't control this one", async () => {
    const res = await setVisual(bearer(await token({ permissions: ["host:other"] })));
    expect(res.status).toBe(403);
    expect(store.getState().visualMode).toBe("auto");
  });

  it("AU-08: the dev key does nothing when Auth0 is on, and every host route is protected", async () => {
    expect((await setVisual({ "x-host-key": "local-dev-host-key" })).status).toBe(401);
    const routes: [string, string][] = [
      ["post", "/api/host/sessions/demo/visual"],
      ["post", "/api/host/sessions/demo/advance"],
      ["get", "/api/host/sessions/demo/recommendations"],
      ["post", "/api/host/sessions/demo/recommendations"],
      ["post", "/api/host/sessions/demo/recommendations/abc/approve"],
      ["post", "/api/host/sessions/demo/recommendations/abc/reject"],
    ];
    for (const [method, path] of routes) {
      const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method](path).send({});
      expect([method, path, res.status]).toEqual([method, path, 401]);
    }
  });

  it("attendee endpoints stay public", async () => {
    const res = await request(app)
      .post("/api/sessions/demo/votes")
      .send({ sessionId: "demo", trackId: "track_01", eventId: crypto.randomUUID(), participantId: "participant_pub1" });
    expect(res.body.status).toBe("accepted");
  });

  it("exposes only public Auth0 settings to the browser", async () => {
    const res = await request(app).get("/api/auth/config");
    expect(res.body).toEqual({
      mode: "auth0",
      domain: "crowdpulse-test.us.auth0.com",
      clientId: "spa-client-id",
      audience: AUDIENCE,
    });
  });
});
