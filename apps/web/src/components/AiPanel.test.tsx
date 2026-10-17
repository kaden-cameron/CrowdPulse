import { render, screen, waitFor } from "@testing-library/react";
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
});
