import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "@crowdpulse/shared";
import { LibraryCard } from "./LibraryCard";

const URI = "spotify:track:4uLU6hMCjMI75M1A2tKUQC";
const state = {
  nowPlaying: null,
  tracks: [
    { id: "track_01", title: "Gator Glow", artist: "x", genre: "house", bpm: 122, energy: 0.6, votes: 0, boosts: 0, round: 0, status: "open" },
    { id: "track_02", title: "Midnight", artist: "y", genre: "lofi", bpm: 84, energy: 0.2, votes: 0, boosts: 0, round: 0, status: "open" },
  ],
} as unknown as SessionState;

beforeEach(() => {
  sessionStorage.setItem(
    "crowdpulse.spotify.tokens",
    JSON.stringify({
      accessToken: "tok",
      refreshToken: "r",
      expiresAt: Date.now() + 3_600_000,
      clientId: "cid",
      scope: "streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative",
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function mockNet() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url === "/api/public-config") return Response.json({ publicUrl: null, lanIp: null, spotifyClientId: "cid", spotifySearch: true });
      if (url.startsWith("/api/spotify/search")) {
        return Response.json({
          tracks: [{ id: "4uLU6hMCjMI75M1A2tKUQC", title: "One More Time", artist: "Daft Punk", album: "Discovery", spotifyUri: URI, durationMs: 320_000, popularity: 80, imageUrl: null, coverUrl: null }],
        });
      }
      if (url.endsWith("/library") && init?.method === "DELETE") return Response.json({ status: "accepted", state });
      if (url.endsWith("/library")) return Response.json({ added: 1, skipped: 0, estimatedBy: "gemini", note: null, trackIds: ["sp_4uLU6hMCjMI75M1A2tKUQC"] });
      if (url.endsWith("/queue")) return Response.json({ status: "accepted", state });
      if (url.includes("/v1/playlists/")) {
        const t = (n: number, name: string) => ({ item: { name, uri: `spotify:track:${String(n).padStart(22, "B")}`, type: "track", duration_ms: 200_000, artists: [{ name: "Band" }] } });
        return Response.json({ items: [t(1, "First Song"), t(2, "Second Song"), t(3, "Third Song")], next: null });
      }
      if (url.endsWith("/advance")) return Response.json({ status: "accepted", state });
      if (init?.method === "PATCH") return Response.json({ status: "accepted", state });
      return new Response("{}", { status: 404 });
    }),
  );
  return calls;
}

describe("LibraryCard", () => {
  it("searches Spotify and adds a song, reporting Gemini's estimate", async () => {
    const calls = mockNet();
    render(<LibraryCard sessionCode="demo" state={state} ready getHeaders={async () => ({ "x-host-key": "k" })} onState={() => {}} />);
    await userEvent.type(await screen.findByPlaceholderText("Song or artist"), "daft punk");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("One More Time")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox", { name: "Select One More Time" }));
    await userEvent.click(screen.getByRole("button", { name: "Add selected (1)" }));
    expect(await screen.findByText(/Added 1 song\. BPM\/energy estimated by Gemini\./)).toBeInTheDocument();
    const add = calls.find((c) => c.url === "/api/host/sessions/demo/library")!;
    expect(add.body).toEqual({ tracks: [{ title: "One More Time", artist: "Daft Punk", spotifyUri: URI }] });
  });

  it("+ Queue on a search result adds it to the library, then to the end of the queue", async () => {
    const calls = mockNet();
    render(<LibraryCard sessionCode="demo" state={state} ready getHeaders={async () => ({})} onState={() => {}} />);
    await userEvent.type(await screen.findByPlaceholderText("Song or artist"), "daft punk");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await userEvent.click(await screen.findByRole("button", { name: "Add One More Time to the queue" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/queue"))).toBe(true));
    const addIdx = calls.findIndex((c) => c.url.endsWith("/library") && c.method === "POST");
    const queueIdx = calls.findIndex((c) => c.url.endsWith("/queue"));
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(queueIdx).toBeGreaterThan(addIdx);
    expect(calls[queueIdx].body).toEqual({ trackIds: ["sp_4uLU6hMCjMI75M1A2tKUQC"] });
  });

  it("search results close with ✕ without searching again", async () => {
    mockNet();
    render(<LibraryCard sessionCode="demo" state={state} ready getHeaders={async () => ({})} onState={() => {}} />);
    await userEvent.type(await screen.findByPlaceholderText("Song or artist"), "daft punk");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("One More Time")).toBeInTheDocument();
    expect(screen.getByText(/1 result for “daft punk”/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close search results" }));
    expect(screen.queryByText("One More Time")).not.toBeInTheDocument();
  });

  it("Play now adds the song if needed, then plays it", async () => {
    const calls = mockNet();
    const onState = vi.fn();
    render(<LibraryCard sessionCode="demo" state={state} ready getHeaders={async () => ({ "x-host-key": "k" })} onState={onState} />);
    await userEvent.type(await screen.findByPlaceholderText("Song or artist"), "daft punk");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await userEvent.click(await screen.findByRole("button", { name: "Play One More Time now" }));
    await waitFor(() => expect(onState).toHaveBeenCalled());
    const advance = calls.find((c) => c.url.endsWith("/advance"))!;
    expect(advance.body).toEqual({ trackId: "sp_4uLU6hMCjMI75M1A2tKUQC" });
    expect(screen.getByText(/Playing “One More Time” now/)).toBeInTheDocument();
  });

  it("asks the host to reconnect when the login lacks the playlist permission", async () => {
    mockNet();
    sessionStorage.setItem("crowdpulse.spotify.tokens", JSON.stringify({ accessToken: "t", refreshToken: null, expiresAt: Date.now() + 1e6, clientId: "cid", scope: "streaming" }));
    render(<LibraryCard sessionCode="demo" state={state} ready getHeaders={async () => ({})} onState={() => {}} />);
    expect(await screen.findByRole("button", { name: /Reconnect Spotify/ })).toBeInTheDocument();
  });

  it("+ Queue appends a library song to the host's queue", async () => {
    const calls = mockNet();
    render(<LibraryCard sessionCode="demo" state={state} ready getHeaders={async () => ({ "x-host-key": "k" })} onState={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Add Midnight to the queue" }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith("/queue"))?.body).toEqual({ trackIds: ["track_02"] }));
    expect(calls.find((c) => c.url.endsWith("/queue"))?.method).toBe("PUT");
  });

  it("▶ on a library song plays it now", async () => {
    const calls = mockNet();
    const onState = vi.fn();
    render(<LibraryCard sessionCode="demo" state={state} ready getHeaders={async () => ({})} onState={onState} />);
    await userEvent.click(screen.getByRole("button", { name: "Play Midnight now" }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith("/advance"))?.body).toEqual({ trackId: "track_02" }));
    expect(onState).toHaveBeenCalled();
  });

  it("local songs can be renamed (title and artist); Spotify songs can't", async () => {
    const calls = mockNet();
    const onState = vi.fn();
    const withLocal = {
      ...state,
      tracks: [...state.tracks, { id: "lf_00000000000000aa", title: "track01", artist: "Unknown artist", genre: "house", bpm: 124, energy: 0.5, votes: 0, boosts: 0, round: 0, status: "open", source: "local" }],
    } as unknown as SessionState;
    render(<LibraryCard sessionCode="demo" state={withLocal} ready getHeaders={async () => ({})} onState={onState} />);
    expect(screen.queryByRole("button", { name: "Rename Gator Glow" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Rename track01" }));
    const title = screen.getByRole("textbox", { name: "New title for track01" });
    await userEvent.clear(title);
    await userEvent.type(title, "Sunrise");
    const artist = screen.getByRole("textbox", { name: "New artist for track01" });
    await userEvent.clear(artist);
    await userEvent.type(artist, "DJ Gator");
    await userEvent.click(screen.getByRole("button", { name: "Save the new name" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ url: "/api/host/sessions/demo/library/lf_00000000000000aa", body: { title: "Sunrise", artist: "DJ Gator" } }));
    expect(onState).toHaveBeenCalled();
    expect(await screen.findByText("Renamed to “Sunrise” by DJ Gator.")).toBeInTheDocument();
  });

  it("a song already in the queue can be queued again", async () => {
    const calls = mockNet();
    const queued = { ...state, queue: [{ trackId: "track_02", title: "Midnight", artist: "y", votes: 0, boosts: 0, hostPick: true }] } as unknown as SessionState;
    render(<LibraryCard sessionCode="demo" state={queued} ready getHeaders={async () => ({})} onState={() => {}} />);
    expect(screen.getByText("#1")).toBeInTheDocument();
    const again = screen.getByRole("button", { name: "Add Midnight to the queue again" });
    expect(again).toBeEnabled();
    await userEvent.click(again);
    await waitFor(() => expect(calls.find((c) => c.url.endsWith("/queue"))?.body).toEqual({ trackIds: ["track_02", "track_02"] }));
  });

  it("Shuffle puts every library song into the queue in random order", async () => {
    const calls = mockNet();
    render(<LibraryCard sessionCode="demo" state={state} ready getHeaders={async () => ({})} onState={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "🔀 Shuffle" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/queue"))).toBe(true));
    const ids = (calls.find((c) => c.url.endsWith("/queue"))!.body as { trackIds: string[] }).trackIds;
    expect([...ids].sort()).toEqual(["track_01", "track_02"]);
  });

  it("Clear library asks first, then empties it", async () => {
    const calls = mockNet();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<LibraryCard sessionCode="demo" state={state} ready getHeaders={async () => ({})} onState={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Clear library" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Clear library" }));
    await waitFor(() => expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/api/host/sessions/demo/library"));
    expect(await screen.findByText("Library cleared.")).toBeInTheDocument();
    confirm.mockRestore();
  });
});

describe("LibraryCard playlist import", () => {
  it("lets the host choose which playlist songs to add", async () => {
    const calls = mockNet();
    render(<LibraryCard sessionCode="demo" state={state} ready getHeaders={async () => ({})} onState={() => {}} />);
    await userEvent.click(screen.getByText("Import a Spotify playlist"));
    await userEvent.type(screen.getByPlaceholderText(/open.spotify.com\/playlist/), "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M");
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    // Everything starts selected; untick one.
    expect(await screen.findByRole("button", { name: "Add selected (3)" })).toBeEnabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Second Song" }));
    await userEvent.click(screen.getByRole("button", { name: "Add selected (2)" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/library") && c.method === "POST")).toBe(true));
    const added = (calls.find((c) => c.url.endsWith("/library") && c.method === "POST")!.body as { tracks: { title: string }[] }).tracks;
    expect(added.map((t) => t.title)).toEqual(["First Song", "Third Song"]);
  });
});

describe("shuffled", () => {
  it("keeps every item exactly once", async () => {
    const { shuffled } = await import("./LibraryCard");
    const out = shuffled([1, 2, 3, 4, 5]);
    expect([...out].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("sortLibrary", () => {
  const lib = [
    { title: "b song", artist: "Zed", genre: "pop", votes: 1, bpm: 90, energy: 0.2 },
    { title: "A song", artist: "amy", genre: "house", votes: 3, bpm: 128, energy: 0.9 },
    { title: "c song", artist: "Bob", genre: "edm", votes: 0, bpm: 140, energy: 0.5 },
  ];
  it("sorts by title, artist, votes, genre, BPM, energy, or newest first", async () => {
    const { sortLibrary } = await import("./LibraryCard");
    const titles = (k: Parameters<typeof sortLibrary>[1]) => sortLibrary(lib, k).map((x) => x.title);
    expect(titles("added")).toEqual(["b song", "A song", "c song"]);
    expect(titles("newest")).toEqual(["c song", "A song", "b song"]);
    expect(titles("title")).toEqual(["A song", "b song", "c song"]);
    expect(titles("artist")).toEqual(["A song", "c song", "b song"]);
    expect(titles("votes")).toEqual(["A song", "b song", "c song"]);
    expect(titles("genre")).toEqual(["c song", "A song", "b song"]);
    expect(titles("bpm")).toEqual(["c song", "A song", "b song"]);
    expect(titles("energy")).toEqual(["A song", "c song", "b song"]);
    expect(lib[0].title).toBe("b song"); // the library itself isn't changed
  });
});

describe("Spotify search fields", () => {
  it("builds a Spotify query from the box plus optional title / artist / album", async () => {
    const { buildSpotifyQuery } = await import("./LibraryCard");
    const none = { title: "", artist: "", album: "" };
    expect(buildSpotifyQuery("daft punk", none)).toBe("daft punk");
    expect(buildSpotifyQuery("", { ...none, artist: "Daft Punk", album: "Discovery" })).toBe('artist:"Daft Punk" album:"Discovery"');
    expect(buildSpotifyQuery("live", { title: 'One "More" Time', artist: "", album: "" })).toBe('live track:"One More Time"');
  });

  it("searches with only the artist and album fields filled", async () => {
    const calls = mockNet();
    render(<LibraryCard sessionCode="demo" state={state} ready getHeaders={async () => ({})} onState={() => {}} />);
    await userEvent.click(screen.getByText("Search by title, artist or album"));
    await userEvent.type(screen.getByRole("textbox", { name: "Artist" }), "Daft Punk");
    await userEvent.type(screen.getByRole("textbox", { name: "Album" }), "Discovery");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText(/for “artist Daft Punk · album Discovery”/)).toBeInTheDocument();
    const search = calls.find((c) => c.url.startsWith("/api/spotify/search"))!;
    expect(decodeURIComponent(search.url.split("q=")[1])).toBe('artist:"Daft Punk" album:"Discovery"');
  });
});
