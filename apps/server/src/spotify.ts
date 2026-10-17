// Spotify Web API helpers for CrowdPulse.
// Playback uses browser PKCE (Client ID only). Search uses Client Credentials so phones
// can find real songs without every attendee logging into Spotify.

import { toSpotifyUri, type CatalogTrack } from "./catalog.js";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";

export interface SpotifySearchHit {
  id: string;
  title: string;
  artist: string;
  album: string;
  spotifyUri: string;
  durationMs: number;
  popularity: number;
  imageUrl: string | null;
}

export interface SpotifySearchClient {
  configured: boolean;
  search(query: string, limit?: number): Promise<SpotifySearchHit[]>;
}

type TokenCache = { accessToken: string; expiresAt: number };

/** Client-credentials search. Returns a no-op client when secret/id are missing. */
export function createSpotifySearch(clientId?: string, clientSecret?: string): SpotifySearchClient {
  const id = clientId?.trim();
  const secret = clientSecret?.trim();
  if (!id || !secret) {
    return {
      configured: false,
      async search() {
        throw Object.assign(new Error("Spotify search isn't configured (set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET)"), {
          status: 503,
        });
      },
    };
  }

  let cache: TokenCache | null = null;

  async function accessToken(): Promise<string> {
    if (cache && Date.now() < cache.expiresAt - 60_000) return cache.accessToken;
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !data.access_token) {
      throw Object.assign(
        new Error(data.error_description ?? data.error ?? `Spotify token failed (${res.status})`),
        { status: 502 },
      );
    }
    cache = {
      accessToken: data.access_token,
      expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
    };
    return cache.accessToken;
  }

  return {
    configured: true,
    async search(query: string, limit = 8): Promise<SpotifySearchHit[]> {
      const q = query.trim().slice(0, 100);
      if (q.length < 2) return [];
      const token = await accessToken();
      const url = `${API}/search?type=track&limit=${Math.min(20, Math.max(1, limit))}&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      const data = (await res.json().catch(() => ({}))) as {
        tracks?: { items?: SpotifyApiTrack[] };
        error?: { message?: string };
      };
      if (!res.ok) {
        throw Object.assign(new Error(data.error?.message ?? `Spotify search failed (${res.status})`), {
          status: res.status === 401 || res.status === 403 ? 502 : 502,
        });
      }
      return (data.tracks?.items ?? [])
        .filter((t) => t?.id && t.name && t.uri)
        .map((t) => ({
          id: t.id,
          title: t.name,
          artist: (t.artists ?? []).map((a) => a.name).filter(Boolean).join(", ") || "Unknown artist",
          album: t.album?.name ?? "",
          spotifyUri: t.uri,
          durationMs: t.duration_ms ?? 0,
          popularity: t.popularity ?? 50,
          imageUrl: t.album?.images?.[t.album.images.length - 1]?.url ?? t.album?.images?.[0]?.url ?? null,
        }));
    },
  };
}

interface SpotifyApiTrack {
  id: string;
  name: string;
  uri: string;
  duration_ms?: number;
  popularity?: number;
  artists?: { name: string }[];
  album?: { name?: string; images?: { url: string }[] };
}

/** Turns a Spotify search hit into a CrowdPulse catalog track (BPM/energy are ours to set). */
export function catalogTrackFromSpotify(hit: {
  id: string;
  title: string;
  artist: string;
  spotifyUri: string;
  popularity?: number;
}): CatalogTrack {
  const uri = toSpotifyUri(hit.spotifyUri) ?? hit.spotifyUri;
  const popularity = Math.max(0, Math.min(100, hit.popularity ?? 50));
  return {
    id: `sp_${hit.id}`.slice(0, 64),
    title: hit.title.trim().slice(0, 120) || "Untitled",
    artist: hit.artist.trim().slice(0, 120) || "Unknown artist",
    genre: "spotify",
    // Spotify no longer exposes audio features to new apps — sensible defaults for Gemini/synth.
    bpm: 120,
    energy: Math.round((0.35 + (popularity / 100) * 0.55) * 100) / 100,
    spotifyUri: uri,
  };
}
