import { MAX_TRACKS_PER_ADD, pickCover } from "@crowdpulse/shared";

// Host-page Spotify reads: playlist import and song search (Web API, the host's own login).

const API = "https://api.spotify.com/v1";

export interface FoundTrack {
  title: string;
  artist: string;
  spotifyUri: string;
  durationMs: number;
  explicit: boolean;
  /** Small thumbnail for result lists. */
  imageUrl: string | null;
  /** ~300px album cover, saved with the song. */
  coverUrl: string | null;
}

/** Playlist link, URI or bare id → playlist id. */
export function parsePlaylistId(input: string): string | null {
  const v = input.trim();
  const m =
    v.match(/^spotify:playlist:([A-Za-z0-9]{22})$/) ??
    v.match(/^https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/([A-Za-z0-9]{22})(?:[/?#].*)?$/) ??
    v.match(/^([A-Za-z0-9]{22})$/);
  return m?.[1] ?? null;
}

interface SpotifyTrack {
  name?: string;
  uri?: string;
  type?: string;
  is_local?: boolean;
  duration_ms?: number;
  explicit?: boolean;
  artists?: { name?: string }[];
  album?: { images?: { url: string; width?: number }[] };
}

function toFound(t: SpotifyTrack | null | undefined): FoundTrack | null {
  if (!t || t.is_local || (t.type && t.type !== "track") || !t.uri?.startsWith("spotify:track:") || !t.name) return null;
  const images = t.album?.images ?? [];
  return {
    title: t.name.slice(0, 120),
    artist: (t.artists ?? []).map((a) => a.name).filter(Boolean).join(", ").slice(0, 120) || "Unknown artist",
    spotifyUri: t.uri,
    durationMs: t.duration_ms ?? 0,
    explicit: Boolean(t.explicit),
    imageUrl: (images.find((i) => (i.width ?? 0) <= 100) ?? images.at(-1))?.url ?? null,
    coverUrl: pickCover(images),
  };
}

async function call(path: string, token: string, api: typeof fetch) {
  const res = await api(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (res.ok) return res.json();
  if (res.status === 401) throw new Error("Spotify login expired — connect Spotify again");
  if (res.status === 403) {
    throw new Error(
      "Spotify only lets apps read playlists you own or collaborate on. Add the songs to one of your own playlists and import that.",
    );
  }
  if (res.status === 404) throw new Error("That playlist wasn't found (check the link)");
  if (res.status === 429) throw new Error("Spotify is rate-limiting requests — wait a minute and try again");
  throw new Error(`Spotify request failed (${res.status})`);
}

/**
 * All songs in a playlist (up to `cap`), skipping local files, podcasts and unavailable items.
 * Reads 50 per page — Spotify's maximum.
 */
export async function fetchPlaylistTracks(
  playlistId: string,
  token: string,
  { api = fetch, cap = MAX_TRACKS_PER_ADD }: { api?: typeof fetch; cap?: number } = {},
): Promise<{ tracks: FoundTrack[]; skipped: number; truncated: boolean }> {
  const tracks: FoundTrack[] = [];
  let skipped = 0;
  let offset = 0;
  for (;;) {
    const page = await call(`/playlists/${playlistId}/items?limit=50&offset=${offset}&additional_types=track`, token, api);
    const items: { item?: SpotifyTrack; track?: SpotifyTrack }[] = page.items ?? [];
    for (const it of items) {
      const t = toFound(it.item ?? it.track);
      if (!t) skipped++;
      else if (tracks.length < cap) tracks.push(t);
    }
    offset += items.length;
    const total: number = page.total ?? offset;
    if (!page.next || !items.length || tracks.length >= cap) {
      return { tracks, skipped, truncated: total - skipped > tracks.length };
    }
  }
}

/** Song search (Spotify returns at most 10 results per request). */
export async function searchSpotifyTracks(query: string, token: string, { api = fetch }: { api?: typeof fetch } = {}): Promise<FoundTrack[]> {
  const q = query.trim();
  if (!q) return [];
  const data = await call(`/search?type=track&limit=10&q=${encodeURIComponent(q)}`, token, api);
  return ((data.tracks?.items ?? []) as SpotifyTrack[]).map(toFound).filter((t): t is FoundTrack => t !== null);
}
