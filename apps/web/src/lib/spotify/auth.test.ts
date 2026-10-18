import { describe, expect, it, vi } from "vitest";
import { codeChallenge, redirectProblem } from "./auth";

const loc = (href: string) => new URL(href) as unknown as Location;

describe("Spotify PKCE login", () => {
  it("computes the RFC 7636 S256 code challenge", async () => {
    // Test vector from RFC 7636 Appendix B.
    expect(await codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("explains Spotify's redirect rules: no localhost, HTTPS except loopback IPs", () => {
    expect(redirectProblem(loc("http://localhost:5173/player/demo"))).toMatch(/127\.0\.0\.1:5173\/player\/demo/);
    expect(redirectProblem(loc("http://10.0.0.5:5173/player/demo"))).toMatch(/HTTPS/);
    expect(redirectProblem(loc("http://127.0.0.1:5173/player/demo"))).toBeNull();
    expect(redirectProblem(loc("https://203-0-113-7.sslip.io/player/demo"))).toBeNull();
  });
});

describe("spotifyAccessToken", () => {
  it("shares one refresh between callers that ask at the same time", async () => {
    sessionStorage.setItem(
      "crowdpulse.spotify.tokens",
      JSON.stringify({ accessToken: "old", refreshToken: "r1", expiresAt: Date.now() - 1000, clientId: "cid" }),
    );
    const fetchMock = vi.fn(async () => Response.json({ access_token: "new", refresh_token: "r2", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { spotifyAccessToken } = await import("./auth");
      expect(await Promise.all([spotifyAccessToken(), spotifyAccessToken(), spotifyAccessToken()])).toEqual(["new", "new", "new"]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(sessionStorage.getItem("crowdpulse.spotify.tokens")!)).toMatchObject({ accessToken: "new", refreshToken: "r2" });
      // Fresh now: no further refresh.
      expect(await spotifyAccessToken()).toBe("new");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      sessionStorage.clear();
    }
  });
});
