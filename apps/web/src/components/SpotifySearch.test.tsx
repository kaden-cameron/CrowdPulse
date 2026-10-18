import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpotifySearch } from "./SpotifySearch";

const hit = (id: string, title: string) => ({
  id: id.padEnd(22, "A"),
  title,
  artist: "Band",
  album: "",
  spotifyUri: `spotify:track:${id.padEnd(22, "A")}`,
  durationMs: 1,
  popularity: 50,
  imageUrl: null,
});

/** Search responses wait until the test releases them, so it can answer out of order. */
function mockNet() {
  const pending = new Map<string, () => void>();
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" });
      if (url === "/api/public-config") return Response.json({ publicUrl: null, lanIp: null, spotifyClientId: "cid", spotifySearch: true });
      if (url.startsWith("/api/spotify/search")) {
        const q = new URL(url, "http://x").searchParams.get("q")!;
        await new Promise<void>((resolve) => pending.set(q, resolve));
        return Response.json({ tracks: [hit(q, `Result for ${q}`)] });
      }
      if (url.endsWith("/tracks")) return Response.json({ status: "accepted" });
      return new Response("{}", { status: 404 });
    }),
  );
  return { pending, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("SpotifySearch", () => {
  it("ignores an older search that answers after a newer one", async () => {
    const { pending } = mockNet();
    render(<SpotifySearch sessionId="demo" />);
    const box = await screen.findByRole("searchbox");
    fireEvent.change(box, { target: { value: "old" } });
    await waitFor(() => expect(pending.has("old")).toBe(true), { timeout: 2000 });
    fireEvent.change(box, { target: { value: "new" } });
    await waitFor(() => expect(pending.has("new")).toBe(true), { timeout: 2000 });
    pending.get("new")!();
    expect(await screen.findByText("Result for new")).toBeInTheDocument();
    expect(screen.queryByText("Searching…")).not.toBeInTheDocument();
    pending.get("old")!();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Result for old")).not.toBeInTheDocument();
    expect(screen.getByText("Result for new")).toBeInTheDocument();
  });

  it("says Add & vote only when the attendee can vote, and votes only then", async () => {
    const { pending } = mockNet();
    const onAdded = vi.fn();
    const { rerender } = render(<SpotifySearch sessionId="demo" onAdded={onAdded} canVote={false} />);
    fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "song" } });
    await waitFor(() => expect(pending.has("song")).toBe(true), { timeout: 2000 });
    pending.get("song")!();
    await userEvent.click(await screen.findByRole("button", { name: "Add" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("sp_songAAAAAAAAAAAAAAAAAA", false));
    rerender(<SpotifySearch sessionId="demo" onAdded={onAdded} canVote />);
    await userEvent.click(screen.getByRole("button", { name: "Add & vote" }));
    await waitFor(() => expect(onAdded).toHaveBeenLastCalledWith("sp_songAAAAAAAAAAAAAAAAAA", true));
  });
});
