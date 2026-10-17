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
      if (url === "/api/public-config") return Response.json({ publicUrl: null, lanIp: null, spotifyClientId: "cid" });
      if (url.startsWith("https://api.spotify.com/v1/search")) {
        return Response.json({ tracks: { items: [{ name: "One More Time", uri: URI, type: "track", duration_ms: 320_000, artists: [{ name: "Daft Punk" }] }] } });
      }
      if (url.endsWith("/library")) return Response.json({ added: 1, skipped: 0, estimatedBy: "gemini", note: null, trackIds: ["sp_4uLU6hMCjMI75M1A2tKUQC"] });
      if (url.endsWith("/advance")) return Response.json({ status: "accepted", state });
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

    await userEvent.click(screen.getByRole("button", { name: "Add One More Time to the library" }));
    expect(await screen.findByText(/Added 1 song\. BPM\/energy estimated by Gemini\./)).toBeInTheDocument();
    const add = calls.find((c) => c.url === "/api/host/sessions/demo/library")!;
    expect(add.body).toEqual({ tracks: [{ title: "One More Time", artist: "Daft Punk", spotifyUri: URI }] });
  });

  it("Play next adds the song if needed, then plays it", async () => {
    const calls = mockNet();
    const onState = vi.fn();
    render(<LibraryCard sessionCode="demo" state={state} ready getHeaders={async () => ({ "x-host-key": "k" })} onState={onState} />);
    await userEvent.type(await screen.findByPlaceholderText("Song or artist"), "daft punk");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await userEvent.click(await screen.findByRole("button", { name: "Play One More Time next" }));
    await waitFor(() => expect(onState).toHaveBeenCalled());
    const advance = calls.find((c) => c.url.endsWith("/advance"))!;
    expect(advance.body).toEqual({ trackId: "sp_4uLU6hMCjMI75M1A2tKUQC" });
    expect(screen.getByText(/Playing “One More Time” next/)).toBeInTheDocument();
  });

  it("asks the host to reconnect when the login lacks the playlist permission", async () => {
    mockNet();
    sessionStorage.setItem("crowdpulse.spotify.tokens", JSON.stringify({ accessToken: "t", refreshToken: null, expiresAt: Date.now() + 1e6, clientId: "cid", scope: "streaming" }));
    render(<LibraryCard sessionCode="demo" state={state} ready getHeaders={async () => ({})} onState={() => {}} />);
    expect(await screen.findByRole("button", { name: /Reconnect Spotify/ })).toBeInTheDocument();
  });
});
