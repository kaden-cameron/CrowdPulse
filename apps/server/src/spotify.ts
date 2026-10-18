// Spotify Web API helpers for CrowdPulse.
// Playback uses browser PKCE (Client ID only). Search uses Client Credentials so phones
// can find real songs without every attendee logging into Spotify.

import { pickCover, SPOTIFY_IMAGE_URL } from "@crowdpulse/shared";
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
  /** Small thumbnail for result lists. */
  imageUrl: string | null;
  /** ~300px album cover, stored with the song for the now-playing display. */
  coverUrl: string | null;
}

export interface SpotifySearchClient {
  configured: boolean;
  search(query: string, limit?: number): Promise<SpotifySearchHit[]>;
  /** ~300px album cover for a track id (cached; null if Spotify has none). */
  cover(trackId: string): Promise<string | null>;
  /** A track's real title / artist / cover (null = Spotify doesn't know this id). */
  track?(trackId: string): Promise<{ title: string; artist: string; imageUrl: string | null } | null>;
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
      async cover() {
        return null;
      },
    };
  }

  const covers = new Map<string, string | null>();

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
    async track(trackId: string) {
      const res = await fetch(`${API}/tracks/${encodeURIComponent(trackId)}`, {
        headers: { authorization: `Bearer ${await accessToken()}` },
      });
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) throw Object.assign(new Error(`Spotify track lookup failed (${res.status})`), { status: 502 });
      const data = (await res.json().catch(() => ({}))) as SpotifyApiTrack & { name?: string; artists?: { name?: string }[] };
      const artist = (data.artists ?? []).map((a) => a.name).filter(Boolean).join(", ");
      if (!data.name || !artist) return null;
      return { title: data.name.slice(0, 120), artist: artist.slice(0, 120), imageUrl: pickCover(data.album?.images) };
    },
    async cover(trackId: string): Promise<string | null> {
      if (covers.has(trackId)) return covers.get(trackId)!;
      const res = await fetch(`${API}/tracks/${encodeURIComponent(trackId)}`, {
        headers: { authorization: `Bearer ${await accessToken()}` },
      });
      if (!res.ok) {
        if (res.status === 404) covers.set(trackId, null);
        throw Object.assign(new Error(`Spotify cover lookup failed (${res.status})`), { status: 502 });
      }
      const data = (await res.json().catch(() => ({}))) as SpotifyApiTrack;
      const url = pickCover(data.album?.images);
      if (covers.size >= 1000) covers.delete(covers.keys().next().value!);
      covers.set(trackId, url);
      return url;
    },
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
          coverUrl: pickCover(t.album?.images),
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
  album?: { name?: string; images?: { url: string; width?: number | null }[] };
}

/** Turns a Spotify search hit into a CrowdPulse catalog track (BPM/energy are ours to set). */
export function catalogTrackFromSpotify(hit: {
  id: string;
  title: string;
  artist: string;
  spotifyUri: string;
  popularity?: number;
  imageUrl?: string;
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
    ...(hit.imageUrl && SPOTIFY_IMAGE_URL.test(hit.imageUrl) ? { imageUrl: hit.imageUrl } : {}),
  };
}
