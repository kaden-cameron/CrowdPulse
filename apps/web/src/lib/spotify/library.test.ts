import { describe, expect, it, vi } from "vitest";
import { fetchPlaylistTracks, parsePlaylistId, searchSpotifyTracks } from "./library";

const PL = "37i9dQZF1DXcBWIGoYBM5M";
const t = (n: number, over: Record<string, unknown> = {}) => ({
  name: `Song ${n}`,
  uri: `spotify:track:${String(n).padStart(22, "A")}`,
  type: "track",
  duration_ms: 200_000,
  artists: [{ name: "A" }, { name: "B" }],
  album: { images: [{ url: "big", width: 640 }, { url: "small", width: 64 }] },
  ...over,
});

describe("parsePlaylistId", () => {
  it("accepts links, URIs and ids; rejects others", () => {
    expect(parsePlaylistId(`https://open.spotify.com/playlist/${PL}?si=abc`)).toBe(PL);
    expect(parsePlaylistId(`https://open.spotify.com/intl-fr/playlist/${PL}`)).toBe(PL);
    expect(parsePlaylistId(`spotify:playlist:${PL}`)).toBe(PL);
    expect(parsePlaylistId(PL)).toBe(PL);
    expect(parsePlaylistId(`https://open.spotify.com/album/${PL}`)).toBeNull();
    expect(parsePlaylistId("https://evil.example/playlist/x")).toBeNull();
  });
});

describe("fetchPlaylistTracks", () => {
  it("pages through the playlist, skipping local files, podcasts and unavailable items", async () => {
    const api = vi.fn(async (url: string) => {
      const offset = Number(new URL(url).searchParams.get("offset"));
      const page =
        offset === 0
          ? { items: [{ item: t(1) }, { item: t(2, { is_local: true }) }, { item: { ...t(3), type: "episode" } }], next: "more", total: 5 }
          : { items: [{ track: t(4) }, { item: null }], next: null, total: 5 };
      return Response.json(page);
    }) as unknown as typeof fetch;
    const r = await fetchPlaylistTracks(PL, "tok", { api });
    expect(r.tracks.map((x) => x.title)).toEqual(["Song 1", "Song 4"]);
    expect(r.tracks[0]).toMatchObject({ artist: "A, B", imageUrl: "small", durationMs: 200_000 });
    expect(r.skipped).toBe(3);
    expect(r.truncated).toBe(false);
    expect((api as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]).toContain(`/playlists/${PL}/items?limit=50&offset=0`);
  });

  it("stops at the cap and says it was cut short", async () => {
    const api = vi.fn(async () => Response.json({ items: Array.from({ length: 50 }, (_, i) => ({ item: t(i) })), next: "more", total: 300 })) as unknown as typeof fetch;
    const r = await fetchPlaylistTracks(PL, "tok", { api, cap: 60 });
    expect(r.tracks).toHaveLength(60);
    expect(r.truncated).toBe(true);
  });

  it("explains Spotify's 'only your own playlists' rule on 403", async () => {
    const api = vi.fn(async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
    await expect(fetchPlaylistTracks(PL, "tok", { api })).rejects.toThrow(/own or collaborate on/);
  });
});

describe("searchSpotifyTracks", () => {
  it("returns up to 10 playable songs", async () => {
    const api = vi.fn(async (url: string) => {
      expect(url).toContain("type=track&limit=10&q=daft%20punk");
      return Response.json({ tracks: { items: [t(1), t(2, { is_local: true })] } });
    }) as unknown as typeof fetch;
    const r = await searchSpotifyTracks("daft punk", "tok", { api });
    expect(r.map((x) => x.title)).toEqual(["Song 1"]);
    expect(await searchSpotifyTracks("   ", "tok", { api })).toEqual([]);
  });
});
