import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Recommendation } from "@crowdpulse/shared";
import { AiPanel } from "./AiPanel";

const rec = (overrides: Partial<Recommendation> = {}): Recommendation => ({
  id: "rec-1",
  sessionId: "demo",
  createdAt: new Date().toISOString(),
  status: "pending",
  hostTarget: "raise_energy",
  input: { energy_score: 40 },
  model: "gemini-test",
  responseId: "resp_abcdefghijklmnop",
  modelVersion: "gemini-test-001",
  latencyMs: 812,
  rawResponse: "{}",
  proposal: {
    reason: "Wild is the top mood and energy is falling",
    target_energy: 85,
    recommended_track_id: "track_07",
    visual_theme: "neon_pulse",
    intensity: 0.8,
    confidence: 0.86,
  },
  validationErrors: [],
  baseline: { trackId: "track_02", reason: "Most votes (4)" },
  decidedAt: null,
  ...overrides,
});

const tracks = [
  { id: "track_07", title: "Stage Lightning", artist: "DJ Hydra", genre: "dnb", bpm: 174, energy: 0.95, votes: 0, boosts: 0, round: 0, status: "open" as const },
  { id: "track_02", title: "Midnight Cypress", artist: "Lake Beat", genre: "lofi", bpm: 84, energy: 0.2, votes: 4, boosts: 0, round: 0, status: "queued" as const },
];

function mockFetch(recommendation: Recommendation, configured = true) {
  const calls: { url: string; method: string; auth: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization") });
      const body = url.endsWith("/approve")
        ? { recommendation: { ...recommendation, status: "approved" } }
        : { ai: { configured, model: "gemini-test", lastError: null, lastSuccessAt: null }, recommendations: [recommendation] };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

const getHeaders = async () => ({ authorization: "Bearer test-token" });

afterEach(() => vi.unstubAllGlobals());

describe("AiPanel", () => {
  it("shows the proposal, model proof, and the baseline side by side", async () => {
    mockFetch(rec());
    render(<AiPanel sessionId="demo" getHeaders={getHeaders} ready tracks={tracks} onState={() => {}} />);
    expect(await screen.findByText(/Wild is the top mood/)).toBeInTheDocument();
    expect(screen.getByText("Stage Lightning")).toBeInTheDocument();
    expect(screen.getByText("Midnight Cypress")).toBeInTheDocument();
    expect(screen.getByText(/812 ms/)).toBeInTheDocument();
    expect(screen.getByText(/response resp_abcdefg/)).toBeInTheDocument();
  });

  it("approve calls the host endpoint for that recommendation", async () => {
    const calls = mockFetch(rec());
    render(<AiPanel sessionId="demo" getHeaders={getHeaders} ready tracks={tracks} onState={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/rec-1/approve"))).toBe(true));
    // Every host call carries the signed-in host's bearer token.
    expect(calls.every((c) => c.auth === "Bearer test-token")).toBe(true);
  });

  it("keeps an action's error when the background poll succeeds", async () => {
    // Capture the 5 s recommendations poll so the test can fire it.
    let poll: (() => void) | undefined;
    const spy = vi.spyOn(window, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === 5000) poll = fn;
      return 1;
    }) as typeof window.setInterval);
    let gets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") return Response.json({ error: "Approve failed" }, { status: 500 });
        gets++;
        return Response.json({ ai: { configured: true, model: "gemini-test", lastError: null, lastSuccessAt: null }, recommendations: [rec()] });
      }),
    );
    render(<AiPanel sessionId="demo" getHeaders={getHeaders} ready tracks={tracks} onState={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /Approve/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Approve failed");
    const before = gets;
    poll!();
    await waitFor(() => expect(gets).toBe(before + 1));
    expect(screen.getByRole("alert")).toHaveTextContent("Approve failed");
    spy.mockRestore();
  });

  it("shows validator errors and no approve button for an invalid proposal", async () => {
    mockFetch(rec({ status: "invalid", proposal: null, validationErrors: ['recommended_track_id "track_999" is not an eligible catalog track'] }));
    render(<AiPanel sessionId="demo" getHeaders={getHeaders} ready tracks={tracks} onState={() => {}} />);
    expect(await screen.findByText(/not an eligible catalog track/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  });

  it("GM-07: says AI is unavailable when the server has no key", async () => {
    mockFetch(rec(), false);
    render(<AiPanel sessionId="demo" getHeaders={getHeaders} ready tracks={tracks} onState={() => {}} />);
    expect(await screen.findByText(/set GEMINI_API_KEY/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get recommendation" })).toBeDisabled();
  });

  it("sends the host's request: text, genre and popularity range", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          bodies.push(JSON.parse(String(init.body)));
          return Response.json({ ai: { configured: true, model: "gemini-test", lastError: null, lastSuccessAt: null }, recommendation: rec() }, { status: 201 });
        }
        return Response.json({ ai: { configured: true, model: "gemini-test", lastError: null, lastSuccessAt: null }, recommendations: [] });
      }),
    );
    render(<AiPanel sessionId="demo" getHeaders={getHeaders} ready tracks={tracks} onState={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText(/pop-punk/), "slow jam for the end of the night");
    await userEvent.click(screen.getByText("Any genre"));
    await userEvent.click(screen.getByRole("checkbox", { name: "R&B" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Soul" }));
    fireEvent.change(screen.getByRole("slider", { name: "Minimum streams" }), { target: { value: "2" } }); // 1M
    fireEvent.change(screen.getByRole("slider", { name: "Maximum streams" }), { target: { value: "7" } }); // 500M
    expect(screen.getByText(/Popularity · 1M – 500M streams/)).toBeInTheDocument();
    const ask = await screen.findByRole("button", { name: "Get recommendation" });
    await waitFor(() => expect(ask).toBeEnabled());
    await userEvent.click(ask);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      hostTarget: null,
      request: { prompt: "slow jam for the end of the night", genres: ["r&b", "soul"], artists: [], includeFeatures: false, minStreams: 1_000_000, maxStreams: 500_000_000 },
    });
  });

  it("recognizes a song from lyrics and plays it from Spotify", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const hit = { id: "7tFiyTwD0nx5a1eklYtX2J", title: "Bohemian Rhapsody", artist: "Queen", album: "A Night at the Opera", spotifyUri: "spotify:track:7tFiyTwD0nx5a1eklYtX2J", durationMs: 354_000, popularity: 90, imageUrl: null, coverUrl: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") calls.push({ url, body: JSON.parse(String(init.body)) });
        if (url.endsWith("/find-songs")) return Response.json({ songs: [{ title: "Bohemian Rhapsody", artist: "Queen", why: "Opening lyric", confidence: 0.97, streams: 2_600_000_000, spotify: hit }], note: null });
        if (url.endsWith("/library")) return Response.json({ added: 1, skipped: 0, estimatedBy: "gemini", note: null, trackIds: ["sp_7tFiyTwD0nx5a1eklYtX2J"] });
        if (url.endsWith("/advance")) return Response.json({ status: "accepted", state: {} });
        return Response.json({ ai: { configured: true, model: "gemini-test", lastError: null, lastSuccessAt: null }, recommendations: [] });
      }),
    );
    const onState = vi.fn();
    render(<AiPanel sessionId="demo" getHeaders={getHeaders} ready tracks={tracks} onState={onState} />);
    await userEvent.type(screen.getByPlaceholderText(/pop-punk/), "is this the real life, is this just fantasy");
    const find = await screen.findByRole("button", { name: "🔎 Find songs" });
    await waitFor(() => expect(find).toBeEnabled());
    await userEvent.click(find);
    expect(await screen.findByText("Bohemian Rhapsody")).toBeInTheDocument();
    expect(screen.getByText(/≈ 2.6B streams/)).toBeInTheDocument();
    expect(screen.queryByText(/Opening lyric/)).not.toBeInTheDocument(); // Gemini's reason isn't shown
    // Results fold away with one click, and come back.
    await userEvent.click(screen.getByRole("button", { name: "Hide results" }));
    expect(screen.queryByText("Bohemian Rhapsody")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show results" }));
    expect(calls[0]).toEqual({
      url: "/api/host/sessions/demo/find-songs",
      body: { text: "is this the real life, is this just fantasy", count: 10, genres: [], artists: [], includeFeatures: false, minStreams: null, maxStreams: null },
    });
    await userEvent.click(screen.getByRole("button", { name: "Play Bohemian Rhapsody now" }));
    await waitFor(() => expect(onState).toHaveBeenCalled());
    expect(calls.find((c) => c.url.endsWith("/advance"))?.body).toEqual({ trackId: "sp_7tFiyTwD0nx5a1eklYtX2J" });
    expect(screen.getByText(/Playing “Bohemian Rhapsody” now/)).toBeInTheDocument();
  });

  it("Surprise me asks for a random song in the chosen genre, without needing text", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") calls.push({ url, body: JSON.parse(String(init.body)) });
        if (url.endsWith("/find-songs")) return Response.json({ songs: [{ title: "One More Time", artist: "Daft Punk", why: "French house classic", confidence: 0.9, streams: 900_000_000, spotify: null }], note: null });
        return Response.json({ ai: { configured: true, model: "gemini-test", lastError: null, lastSuccessAt: null }, recommendations: [] });
      }),
    );
    render(<AiPanel sessionId="demo" getHeaders={getHeaders} ready tracks={tracks} onState={() => {}} />);
    await userEvent.click(screen.getByText("Any genre"));
    await userEvent.click(screen.getByRole("checkbox", { name: "House" }));
    const surprise = await screen.findByRole("button", { name: "🎲 Surprise me" });
    await waitFor(() => expect(surprise).toBeEnabled());
    await userEvent.click(surprise);
    expect(await screen.findByText("One More Time")).toBeInTheDocument();
    expect(calls[0].body).toEqual({ surprise: true, genres: ["house"], artists: [], includeFeatures: false, minStreams: null, maxStreams: null });
  });

  it("formats stream counts", async () => {
    const { fmtStreams } = await import("./AiPanel");
    expect([fmtStreams(2_500_000_000), fmtStreams(120_000), fmtStreams(50_000_000), fmtStreams(900)]).toEqual(["2.5B", "120K", "50M", "900"]);
  });

  it("Find songs: choose how many, then select all and add them in one go", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const hit = (n: number) => ({ id: `id${n}`, title: `Song ${n}`, artist: "Band", album: "", spotifyUri: `spotify:track:${String(n).padStart(22, "A")}`, durationMs: 1, popularity: 50, imageUrl: null, coverUrl: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") calls.push({ url, body: JSON.parse(String(init.body)) });
        if (url.endsWith("/find-songs")) {
          return Response.json({
            songs: [1, 2, 3].map((n) => ({ title: `Song ${n}`, artist: "Band", why: "pop punk", confidence: 0.8, streams: 50_000_000, spotify: hit(n) })),
            note: null,
          });
        }
        if (url.endsWith("/library")) return Response.json({ added: 3, skipped: 0, estimatedBy: "gemini", note: null, trackIds: [] });
        return Response.json({ ai: { configured: true, model: "gemini-test", lastError: null, lastSuccessAt: null }, recommendations: [] });
      }),
    );
    render(<AiPanel sessionId="demo" getHeaders={getHeaders} ready tracks={tracks} onState={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText(/pop-punk/), "2000s pop punk");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "How many songs to find" }), "30");
    const find = await screen.findByRole("button", { name: "🔎 Find songs" });
    await waitFor(() => expect(find).toBeEnabled());
    await userEvent.click(find);
    await screen.findByText("Song 3");
    expect(calls[0].body).toMatchObject({ text: "2000s pop punk", count: 30 });
    await userEvent.click(screen.getByRole("checkbox", { name: /Select all/ }));
    await userEvent.click(screen.getByRole("button", { name: "Add selected (3)" }));
    expect(await screen.findByText(/Added 3 songs to the library/)).toBeInTheDocument();
    expect((calls.find((c) => c.url.endsWith("/library"))!.body as { tracks: unknown[] }).tracks).toHaveLength(3);
  });

  it("Find songs: drops duplicate Spotify matches", async () => {
    const hit = { id: "id1", title: "Song 1", artist: "Band", album: "", spotifyUri: `spotify:track:${"A".repeat(22)}`, durationMs: 1, popularity: 50, imageUrl: null, coverUrl: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/find-songs")) {
          return Response.json({
            songs: ["Song 1", "Song One"].map((title) => ({ title, artist: "Band", why: "", confidence: 0.8, streams: null, spotify: hit })),
            note: null,
          });
        }
        return Response.json({ ai: { configured: true, model: "gemini-test", lastError: null, lastSuccessAt: null }, recommendations: [] });
      }),
    );
    render(<AiPanel sessionId="demo" getHeaders={getHeaders} ready tracks={tracks} onState={() => {}} />);
    await userEvent.type(screen.getByPlaceholderText(/pop-punk/), "some song");
    const find = await screen.findByRole("button", { name: "🔎 Find songs" });
    await waitFor(() => expect(find).toBeEnabled());
    await userEvent.click(find);
    expect(await screen.findAllByText("Song 1")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /Play Song 1 now/ })).toHaveLength(1);
  });

  it("artists: pick from suggestions (library + Spotify), include features, sent with the request", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") calls.push({ url, body: JSON.parse(String(init.body)) });
        if (url.startsWith("/api/spotify/search")) {
          return Response.json({ tracks: [{ id: "1", title: "Summer", artist: "Calvin Harris", album: "", spotifyUri: "spotify:track:1", durationMs: 1, popularity: 1, imageUrl: null, coverUrl: null }] });
        }
        if (url.endsWith("/find-songs")) return Response.json({ songs: [], note: null });
        return Response.json({ ai: { configured: true, model: "gemini-test", lastError: null, lastSuccessAt: null }, recommendations: [] });
      }),
    );
    render(<AiPanel sessionId="demo" getHeaders={getHeaders} ready tracks={tracks} onState={() => {}} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Search an artist" }), "calv");
    await userEvent.click(await screen.findByRole("button", { name: "Calvin Harris" }));
    // A library artist matches instantly too.
    await userEvent.type(screen.getByRole("textbox", { name: "Search an artist" }), "hydra");
    await userEvent.click(await screen.findByRole("button", { name: "DJ Hydra" }));
    expect(screen.getByRole("button", { name: "Remove Calvin Harris" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Include features" }));
    await userEvent.type(screen.getByPlaceholderText(/pop-punk/), "summer");
    const find = await screen.findByRole("button", { name: "🔎 Find songs" });
    await waitFor(() => expect(find).toBeEnabled());
    await userEvent.click(find);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/find-songs"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/find-songs"))!.body).toMatchObject({ artists: ["Calvin Harris", "DJ Hydra"], includeFeatures: true });
  });

  it("text left in the artist box goes to Gemini as a free-form condition", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") calls.push({ url, body: JSON.parse(String(init.body)) });
        if (url.startsWith("/api/spotify/search")) return Response.json({ tracks: [] });
        if (url.endsWith("/find-songs")) return Response.json({ songs: [], note: null });
        return Response.json({ ai: { configured: true, model: "gemini-test", lastError: null, lastSuccessAt: null }, recommendations: [] });
      }),
    );
    render(<AiPanel sessionId="demo" getHeaders={getHeaders} ready tracks={tracks} onState={() => {}} />);
    await userEvent.type(screen.getByRole("textbox", { name: "Search an artist" }), "artists like Daft Punk");
    await userEvent.type(screen.getByPlaceholderText(/pop-punk/), "dance floor");
    expect(screen.getByText(/Gemini will look for artists matching “artists like Daft Punk”/)).toBeInTheDocument();
    const find = await screen.findByRole("button", { name: "🔎 Find songs" });
    await waitFor(() => expect(find).toBeEnabled());
    await userEvent.click(find);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/find-songs"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/find-songs"))!.body).toMatchObject({ artists: [], artistHint: "artists like Daft Punk" });
  });

  it("Find songs works with only an artist picked (no text)", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") calls.push({ url, body: JSON.parse(String(init.body)) });
        if (url.startsWith("/api/spotify/search")) return Response.json({ tracks: [] });
        if (url.endsWith("/find-songs")) return Response.json({ songs: [], note: null });
        return Response.json({ ai: { configured: true, model: "gemini-test", lastError: null, lastSuccessAt: null }, recommendations: [] });
      }),
    );
    render(<AiPanel sessionId="demo" getHeaders={getHeaders} ready tracks={tracks} onState={() => {}} />);
    const find = await screen.findByRole("button", { name: "🔎 Find songs" });
    await waitFor(() => expect(screen.getByRole("button", { name: "🎲 Surprise me" })).toBeEnabled());
    expect(find).toBeDisabled(); // nothing to go on yet
    await userEvent.type(screen.getByRole("textbox", { name: "Search an artist" }), "hydra");
    await userEvent.click(await screen.findByRole("button", { name: "DJ Hydra" }));
    expect(find).toBeEnabled();
    await userEvent.click(find);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/find-songs"))).toBe(true));
    const body = calls.find((c) => c.url.endsWith("/find-songs"))!.body as Record<string, unknown>;
    expect(body.artists).toEqual(["DJ Hydra"]);
    expect(body.text).toBeUndefined();
  });

  it("host target is optional: two choices, tap again to clear", async () => {
    const bodies: { hostTarget: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST" && url.endsWith("/recommendations")) {
          bodies.push(JSON.parse(String(init.body)));
          return Response.json({ ai: { configured: true, model: "gemini-test", lastError: null, lastSuccessAt: null }, recommendation: rec() }, { status: 201 });
        }
        return Response.json({ ai: { configured: true, model: "gemini-test", lastError: null, lastSuccessAt: null }, recommendations: [] });
      }),
    );
    render(<AiPanel sessionId="demo" getHeaders={getHeaders} ready tracks={tracks} onState={() => {}} />);
    expect(screen.queryByRole("button", { name: "Hold steady" })).not.toBeInTheDocument();
    const cool = screen.getByRole("button", { name: "Cool down" });
    const ask = await screen.findByRole("button", { name: "Get recommendation" });
    await waitFor(() => expect(ask).toBeEnabled());
    await userEvent.click(cool);
    expect(cool).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(ask);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].hostTarget).toBe("cool_down");
    await userEvent.click(cool); // tap again: no target
    expect(cool).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(ask);
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1].hostTarget).toBeNull();
  });

  it("a recommendation box (e.g. rejected by the validator) can be closed with ✕", async () => {
    mockFetch(rec({ status: "invalid", proposal: null, validationErrors: ["No songs in the library match “polka”"] }));
    render(<AiPanel sessionId="demo" getHeaders={getHeaders} ready tracks={tracks} onState={() => {}} />);
    expect(await screen.findByText(/No songs in the library match/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close this recommendation" }));
    expect(screen.queryByText(/No songs in the library match/)).not.toBeInTheDocument();
    expect(screen.queryByText("Rejected by server validator")).not.toBeInTheDocument();
  });
});
