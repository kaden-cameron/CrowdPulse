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
    await userEvent.selectOptions(screen.getByRole("combobox"), "r&b");
    fireEvent.change(screen.getByRole("slider", { name: "Minimum streams" }), { target: { value: "2" } }); // 1M
    fireEvent.change(screen.getByRole("slider", { name: "Maximum streams" }), { target: { value: "7" } }); // 500M
    expect(screen.getByText(/Popularity · 1M – 500M streams/)).toBeInTheDocument();
    const ask = await screen.findByRole("button", { name: "Get recommendation" });
    await waitFor(() => expect(ask).toBeEnabled());
    await userEvent.click(ask);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      hostTarget: "raise_energy",
      request: { prompt: "slow jam for the end of the night", genre: "r&b", minStreams: 1_000_000, maxStreams: 500_000_000 },
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
    const find = await screen.findByRole("button", { name: "🔎 Find on Spotify" });
    await waitFor(() => expect(find).toBeEnabled());
    await userEvent.click(find);
    expect(await screen.findByText("Bohemian Rhapsody")).toBeInTheDocument();
    expect(screen.getByText(/≈ 2.6B streams/)).toBeInTheDocument();
    expect(calls[0]).toEqual({
      url: "/api/host/sessions/demo/find-songs",
      body: { text: "is this the real life, is this just fantasy", genre: null, minStreams: null, maxStreams: null },
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
    await userEvent.selectOptions(screen.getByRole("combobox"), "house");
    const surprise = await screen.findByRole("button", { name: "🎲 Surprise me" });
    await waitFor(() => expect(surprise).toBeEnabled());
    await userEvent.click(surprise);
    expect(await screen.findByText("One More Time")).toBeInTheDocument();
    expect(calls[0].body).toEqual({ surprise: true, genre: "house", minStreams: null, maxStreams: null });
  });

  it("formats stream counts", async () => {
    const { fmtStreams } = await import("./AiPanel");
    expect([fmtStreams(2_500_000_000), fmtStreams(120_000), fmtStreams(50_000_000), fmtStreams(900)]).toEqual(["2.5B", "120K", "50M", "900"]);
  });
});
