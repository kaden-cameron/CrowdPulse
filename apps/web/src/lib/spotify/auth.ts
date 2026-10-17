// Spotify login for the player page: Authorization Code with PKCE, entirely in the browser.
// Only the app's Client ID is needed — the Client Secret is never used, sent or stored.
// Tokens live in this tab's sessionStorage and are refreshed automatically.

const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
// Web Playback SDK needs streaming + email/private; playback control needs the two player scopes.
export const SPOTIFY_SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
].join(" ");

const TOKENS_KEY = "crowdpulse.spotify.tokens";
const PENDING_KEY = "crowdpulse.spotify.pending";

interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  clientId: string;
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function randomVerifier(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(48)));
}

/** RFC 7636 S256 code challenge. */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** Spotify forbids "localhost" redirect URIs; loopback must be 127.0.0.1 (HTTP) or the site must be HTTPS. */
export function redirectUri(origin = window.location.origin): string {
  return `${origin}/spotify/callback`;
}

export function redirectProblem(loc: Location = window.location): string | null {
  if (loc.hostname === "localhost") {
    return `Spotify doesn't allow "localhost" logins. Open this page at http://127.0.0.1${loc.port ? `:${loc.port}` : ""}${loc.pathname} instead.`;
  }
  const loopback = loc.hostname === "127.0.0.1" || loc.hostname === "[::1]";
  if (loc.protocol !== "https:" && !loopback) {
    return "Spotify login needs HTTPS (or http://127.0.0.1 for local testing). Use the deployed https:// URL.";
  }
  return null;
}

export async function startSpotifyLogin(clientId: string, returnTo: string) {
  const verifier = randomVerifier();
  const state = randomVerifier().slice(0, 24);
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ verifier, state, returnTo, clientId }));
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri(),
    scope: SPOTIFY_SCOPES,
    code_challenge_method: "S256",
    code_challenge: await codeChallenge(verifier),
    state,
  }).toString();
  window.location.assign(url.toString());
}

/** On /spotify/callback: swap the code for tokens. Returns where to go next. */
export async function finishSpotifyLogin(params: URLSearchParams): Promise<string> {
  const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null") as {
    verifier: string;
    state: string;
    returnTo: string;
    clientId: string;
  } | null;
  sessionStorage.removeItem(PENDING_KEY);
  if (params.get("error")) throw new Error(`Spotify login was cancelled (${params.get("error")})`);
  if (!pending || params.get("state") !== pending.state) throw new Error("Spotify login expired — try again");
  const code = params.get("code");
  if (!code) throw new Error("Spotify didn't return a code");
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: pending.clientId,
    code_verifier: pending.verifier,
  });
  saveTokens({ ...tokens, clientId: pending.clientId });
  return pending.returnTo;
}

export function spotifyConnected(): boolean {
  return loadTokens() !== null;
}

export function disconnectSpotify() {
  sessionStorage.removeItem(TOKENS_KEY);
}

/** A valid access token, refreshed a minute before it expires. */
export async function spotifyAccessToken(): Promise<string> {
  const t = loadTokens();
  if (!t) throw new Error("Not connected to Spotify");
  if (Date.now() < t.expiresAt - 60_000) return t.accessToken;
  if (!t.refreshToken) throw new Error("Spotify session expired — connect again");
  const fresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refreshToken, client_id: t.clientId });
  saveTokens({ ...fresh, refreshToken: fresh.refreshToken ?? t.refreshToken, clientId: t.clientId });
  return fresh.accessToken;
}

async function tokenRequest(body: Record<string, string>): Promise<Omit<Tokens, "clientId">> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Spotify token request failed: ${data.error_description ?? data.error ?? res.status}`);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
  };
}

function loadTokens(): Tokens | null {
  try {
    return JSON.parse(sessionStorage.getItem(TOKENS_KEY) ?? "null");
  } catch {
    return null;
  }
}

function saveTokens(t: Tokens) {
  sessionStorage.setItem(TOKENS_KEY, JSON.stringify(t));
}
