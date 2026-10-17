import { describe, expect, it } from "vitest";
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
