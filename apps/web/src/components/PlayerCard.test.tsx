import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "@crowdpulse/shared";
import { PlayerCard } from "./PlayerCard";

const COVER = "https://i.scdn.co/image/ab67616d00001e02e2a0a166493a2bde5480a420";
const URI = "spotify:track:4uLU6hMCjMI75M1A2tKUQC";

function stateWith(track: Record<string, unknown>, playback: Record<string, unknown> = {}) {
  return {
    nowPlaying: { trackId: "sp_1", title: "Song One", artist: "Artist", votes: 0, boosts: 0 },
    tracks: [{ id: "sp_1", title: "Song One", artist: "Artist", genre: "pop", bpm: 100, energy: 0.5, votes: 0, boosts: 0, round: 1, status: "playing", ...track }],
    playback: { status: "playing", trackId: "sp_1", round: 1, startedAt: new Date(Date.now() - 30_000).toISOString(), durationMs: 180_000, source: "spotify", message: null, mode: "auto", playerOnline: true, repeat: false, highlights: { enabled: false, clipSec: 45, part: "auto", transition: "fade" }, clipStartMs: null, clipEndMs: null, ...playback },
  } as unknown as SessionState;
}

function mockNet(cover: string | null = null) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/public-config") return Response.json({ publicUrl: null, lanIp: null, spotifyClientId: "cid" });
    if (url.startsWith("/api/spotify/cover/")) return Response.json({ imageUrl: cover });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const props = { sessionCode: "demo", ready: true, getHeaders: async () => ({}), onState: () => {} };

describe("PlayerCard (host page Now playing)", () => {
  it("shows the stored album cover, song, and progress from the server's timing", async () => {
    const net = mockNet();
    render(<PlayerCard {...props} state={stateWith({ spotifyUri: URI, imageUrl: COVER })} />);
    expect(screen.getByRole("img", { name: "Album cover for Song One" })).toHaveAttribute("src", COVER);
    expect(screen.getByText("Song One")).toBeInTheDocument();
    expect(screen.getByText(/0:3\d \/ 3:00/)).toBeInTheDocument();
    expect(screen.getByText("● Player online")).toBeInTheDocument();
    expect(net.mock.calls.some(([u]) => String(u).startsWith("/api/spotify/cover/"))).toBe(false);
  });

  it("looks up the cover for older songs that don't have one saved", async () => {
    const net = mockNet(COVER);
    render(<PlayerCard {...props} state={stateWith({ spotifyUri: URI })} />);
    await waitFor(() => expect(screen.getByRole("img", { name: "Album cover for Song One" })).toHaveAttribute("src", COVER));
    expect(net).toHaveBeenCalledWith("/api/spotify/cover/4uLU6hMCjMI75M1A2tKUQC");
  });

  it("shows a placeholder when there's no cover", () => {
    mockNet();
    render(<PlayerCard {...props} state={stateWith({})} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("plays through Spotify only: Start audio waits for a Spotify login", async () => {
    mockNet();
    render(<PlayerCard {...props} state={stateWith({ spotifyUri: URI })} />);
    expect(await screen.findByRole("button", { name: "Connect Spotify first" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /This laptop/ })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Connect Spotify \(Premium account\)/ })).toBeInTheDocument();
  });

  it("Highlights mode: turning it on sends the settings; while a clip plays, ±10s nudges are offered", async () => {
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/public-config") return Response.json({ publicUrl: null, lanIp: null, spotifyClientId: "cid" });
        if (init?.method === "POST" || init?.method === "PUT") posts.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({ status: "accepted", state: stateWith({}) });
      }),
    );
    const { rerender } = render(<PlayerCard {...props} state={stateWith({})} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Highlights mode" }));
    await waitFor(() => expect(posts.find((p) => p.url.endsWith("/playback/highlights"))?.body).toEqual({ enabled: true, clipSec: 45, part: "auto", transition: "fade" }));

    const on = { highlights: { enabled: true, clipSec: 45, part: "auto", transition: "fade" }, clipStartMs: 60_000, clipEndMs: 105_000 };
    rerender(<PlayerCard {...props} state={stateWith({}, on)} />);
    expect(screen.getByText("Highlight 1:00–1:45")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start the highlight 10 seconds later" }));
    await waitFor(() => expect(posts.some((p) => p.url.endsWith("/highlight/sp_1"))).toBe(true));
    expect(posts.find((p) => p.url.endsWith("/highlight/sp_1"))!.body).toEqual({ part: "auto", startMs: 70_000, endMs: 115_000 });
    await waitFor(() => expect(posts.find((p) => p.url.endsWith("/playback/seek"))?.body).toEqual({ positionMs: 70_000 }));
  });

  it("Highlights has no part dropdown — Gemini picks each song's best section", () => {
    mockNet();
    const on = { highlights: { enabled: true, clipSec: 45, part: "auto", transition: "fade" } };
    render(<PlayerCard {...props} state={stateWith({}, on)} />);
    expect(screen.getByRole("combobox", { name: "Clip length" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Which part of each song" })).not.toBeInTheDocument();
  });
});
