import { readFileSync } from "node:fs";
import { z } from "zod";
import { DEMO_TRACKS, MAX_CATALOG_TRACKS, type Track } from "@crowdpulse/shared";

// The song list attendees vote on. Defaults to the built-in demo tracks; set CATALOG_FILE to a JSON
// array of real songs (see apps/server/catalog.example.json). Spotify can't supply BPM/energy for
// new apps anymore, so those are part of the file.

export type CatalogTrack = Omit<Track, "votes" | "status" | "boosts" | "round">;

const TrackSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "id: letters, numbers, _ or -"),
    title: z.string().trim().min(1).max(120),
    artist: z.string().trim().min(1).max(120),
    genre: z.string().trim().min(1).max(40),
    bpm: z.number().min(40).max(220),
    energy: z.number().min(0).max(1),
    // Accepts spotify:track:<id> or a share link (https://open.spotify.com/track/<id>?si=…).
    spotifyUri: z
      .preprocess(
        (v) => (typeof v === "string" ? toSpotifyUri(v) ?? v : v),
        z.string().regex(/^spotify:track:[A-Za-z0-9]{22}$/, "spotifyUri must be spotify:track:<id> or an open.spotify.com/track link"),
      )
      .optional(),
  })
  .strict();

/** spotify:track:<id> → <id>, used to make stable library track ids (sp_<id>). */
export function spotifyTrackId(uri: string): string | null {
  return uri.match(/^spotify:track:([A-Za-z0-9]{22})$/)?.[1] ?? null;
}

export function toSpotifyUri(value: string): string | null {
  const v = value.trim();
  const uri = v.match(/^spotify:track:([A-Za-z0-9]{22})$/);
  if (uri) return `spotify:track:${uri[1]}`;
  const link = v.match(/^https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})(?:[/?#].*)?$/);
  return link ? `spotify:track:${link[1]}` : null;
}

const CatalogSchema = z
  .array(TrackSchema)
  .min(2)
  .max(MAX_CATALOG_TRACKS)
  .refine((tracks) => new Set(tracks.map((t) => t.id)).size === tracks.length, "track ids must be unique");

/** Parses and validates a catalog. Throws with a readable message on bad input. */
export function parseCatalog(json: unknown): CatalogTrack[] {
  const parsed = CatalogSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid catalog: ${issue.path.length ? `track ${issue.path.join(".")}: ` : ""}${issue.message}`);
  }
  return parsed.data;
}

export function loadCatalog(file: string | undefined): CatalogTrack[] {
  if (!file) return DEMO_TRACKS;
  return parseCatalog(JSON.parse(readFileSync(file, "utf8")));
}
