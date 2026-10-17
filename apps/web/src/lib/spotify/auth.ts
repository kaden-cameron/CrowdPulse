import { useEffect, useState } from "react";

// Spotify login for the player page: Authorization Code with PKCE, entirely in the browser.
// Only the app's Client ID is needed — the Client Secret is never used, sent or stored.
// Tokens live in this tab's sessionStorage and are refreshed automatically.
// The login runs in a popup, so the host page never reloads: a reload would drop the host's Auth0
// sign-in, which is kept in memory only. If popups are blocked it falls back to a full redirect.

const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
// Web Playback SDK needs streaming + email/private; playback control needs the two player scopes.
export const SPOTIFY_SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  // Host page: import songs from the host's own / collaborative playlists.
  "playlist-read-private",
  "playlist-read-collaborative",
].join(" ");

/** True when the stored login predates a permission we now need (the host must reconnect once). */
export function spotifyMissingScopes(): boolean {
  try {
    const t = JSON.parse(sessionStorage.getItem("crowdpulse.spotify.tokens") ?? "null") as { scope?: string } | null;
    if (!t) return false;
    const have = new Set((t.scope ?? "").split(" "));
    return SPOTIFY_SCOPES.split(" ").some((s) => !have.has(s));
  } catch {
    return false;
  }
}

const TOKENS_KEY = "crowdpulse.spotify.tokens";
const PENDING_KEY = "crowdpulse.spotify.pending";

interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  clientId: string;
  /** Space-separated permissions Spotify granted. */
  scope?: string;
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

/** Fired on window when this tab's Spotify login changes (connected in the popup, or disconnected). */
export const SPOTIFY_AUTH_EVENT = "crowdpulse:spotify-auth";

export async function startSpotifyLogin(clientId: string, returnTo: string) {
  // Open the popup first, synchronously inside the click, or the browser blocks it.
  const popup = window.open("", "crowdpulse-spotify-login", "popup,width=480,height=760");
  const verifier = randomVerifier();
  const state = randomVerifier().slice(0, 24);
  // localStorage, so the popup can read it; removed as soon as the login finishes.
  localStorage.setItem(PENDING_KEY, JSON.stringify({ verifier, state, returnTo, clientId, popup: Boolean(popup) }));
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
  if (popup) popup.location.href = url.toString();
  else window.location.assign(url.toString());
}

/**
 * On /spotify/callback: swap the code for tokens. In the popup, the tokens go to the page that
 * opened it and the result is "popup" (close this window); otherwise it's where to go next.
 */
export async function finishSpotifyLogin(params: URLSearchParams): Promise<string> {
  const pending = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null") as {
    verifier: string;
    state: string;
    returnTo: string;
    clientId: string;
    popup?: boolean;
  } | null;
  localStorage.removeItem(PENDING_KEY);
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
  const saved: Tokens = { ...tokens, clientId: pending.clientId };
  const opener = openerWindow();
  if (pending.popup && opener) {
    opener.sessionStorage.setItem(TOKENS_KEY, JSON.stringify(saved));
    opener.dispatchEvent(new Event(SPOTIFY_AUTH_EVENT));
    return "popup";
  }
  saveTokens(saved);
  return pending.returnTo;
}

/** The same-origin page that opened this popup, if any. */
function openerWindow(): Window | null {
  try {
    const o = window.opener as Window | null;
    return o && o.location.origin === window.location.origin ? o : null;
  } catch {
    return null; // cross-origin opener
  }
}

export function spotifyConnected(): boolean {
  return loadTokens() !== null;
}

export function disconnectSpotify() {
  sessionStorage.removeItem(TOKENS_KEY);
  window.dispatchEvent(new Event(SPOTIFY_AUTH_EVENT));
}

/** spotifyConnected(), re-rendering when the login changes (popup finished, disconnect). */
export function useSpotifyConnected(): boolean {
  const [connected, setConnected] = useState(spotifyConnected);
  useEffect(() => {
    const update = () => setConnected(spotifyConnected());
    window.addEventListener(SPOTIFY_AUTH_EVENT, update);
    return () => window.removeEventListener(SPOTIFY_AUTH_EVENT, update);
  }, []);
  return connected;
}

/** A valid access token, refreshed a minute before it expires. */
export async function spotifyAccessToken(): Promise<string> {
  const t = loadTokens();
  if (!t) throw new Error("Not connected to Spotify");
  if (Date.now() < t.expiresAt - 60_000) return t.accessToken;
  if (!t.refreshToken) throw new Error("Spotify session expired — connect again");
  const fresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refreshToken, client_id: t.clientId });
  saveTokens({ ...fresh, refreshToken: fresh.refreshToken ?? t.refreshToken, clientId: t.clientId, scope: fresh.scope ?? t.scope });
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
    ...(data.scope ? { scope: String(data.scope) } : {}),
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
