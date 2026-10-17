import { pickCover } from "@crowdpulse/shared";
import { spotifyAccessToken, spotifyConnected } from "./auth";

export interface SpotifySearchHit {
  id: string;
  title: string;
  artist: string;
  album: string;
  spotifyUri: string;
  durationMs: number;
  popularity: number;
  imageUrl: string | null;
  /** ~300px album cover, saved with the song for the now-playing display. */
  coverUrl?: string | null;
}

export type SearchSource = "server" | "client";

/** Server search (Client Credentials) when configured; otherwise the signed-in Spotify user token. */
export async function searchSpotifyTracks(
  query: string,
  options: { preferServer?: boolean } = {},
): Promise<{ tracks: SpotifySearchHit[]; source: SearchSource }> {
  const q = query.trim();
  if (q.length < 2) return { tracks: [], source: "server" };

  if (options.preferServer !== false) {
    try {
      const res = await fetch(`/api/spotify/search?q=${encodeURIComponent(q)}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) return { tracks: (data.tracks ?? []) as SpotifySearchHit[], source: "server" };
      if (res.status !== 503) throw new Error(data.error ?? `Search failed (${res.status})`);
      // 503 = server search not configured — fall through to client token.
    } catch (err) {
      if (!spotifyConnected()) throw err;
    }
  }

  if (!spotifyConnected()) {
    throw new Error(
      "Spotify search needs SPOTIFY_CLIENT_SECRET on the server, or Connect Spotify on this device.",
    );
  }

  const token = await spotifyAccessToken();
  const res = await fetch(
    `https://api.spotify.com/v1/search?type=track&limit=8&q=${encodeURIComponent(q)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message ?? `Spotify search failed (${res.status})`);
  }
  const tracks: SpotifySearchHit[] = (data.tracks?.items ?? [])
    .filter((t: { id?: string; name?: string; uri?: string }) => t?.id && t.name && t.uri)
    .map((t: {
      id: string;
      name: string;
      uri: string;
      duration_ms?: number;
      popularity?: number;
      artists?: { name: string }[];
      album?: { name?: string; images?: { url: string; width?: number | null }[] };
    }) => ({
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
  return { tracks, source: "client" };
}

export async function addSessionTrack(
  sessionId: string,
  hit: SpotifySearchHit,
  participantId?: string,
): Promise<{ trackId: string }> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/tracks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: hit.id,
      title: hit.title,
      artist: hit.artist,
      spotifyUri: hit.spotifyUri,
      popularity: hit.popularity,
      ...(hit.coverUrl ? { imageUrl: hit.coverUrl } : {}),
      ...(participantId ? { participantId } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Couldn't add song (${res.status})`);
  const trackId = `sp_${hit.id}`.slice(0, 64);
  return { trackId };
}
