import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "@crowdpulse/shared";
import { QueueCard } from "./QueueCard";
import { libraryGenres } from "../pages/JoinPage";

const q = (id: string, hostPick: boolean, votes = 0) => ({ trackId: id, title: `Song ${id}`, artist: "A", votes, boosts: 0, hostPick });
const state = { queue: [q("a", true), q("b", true), q("c", false, 3)] } as unknown as SessionState;

afterEach(() => vi.unstubAllGlobals());

function mockNet() {
  const bodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ status: "accepted", state });
    }),
  );
  return bodies;
}

describe("QueueCard", () => {
  it("lists the host's picks first, then voted songs", () => {
    render(<QueueCard sessionCode="demo" state={state} ready getHeaders={async () => ({})} onState={() => {}} />);
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toContain("Song a");
    expect(items[1]).toContain("Song b");
    expect(items[2]).toContain("3 votes");
  });

  it("moves, removes and clears host picks", async () => {
    const bodies = mockNet();
    render(<QueueCard sessionCode="demo" state={state} ready getHeaders={async () => ({})} onState={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Move Song b up" }));
    await waitFor(() => expect(bodies[0]).toEqual({ trackIds: ["b", "a"] }));
    await userEvent.click(screen.getByRole("button", { name: "Take Song a out of the queue" }));
    await waitFor(() => expect(bodies[1]).toEqual({ trackIds: ["b"] }));
    await userEvent.click(screen.getByRole("button", { name: "Clear queue" }));
    await waitFor(() => expect(bodies[2]).toEqual({ trackIds: [] }));
  });
});

describe("QueueCard auto entries", () => {
  it("with nothing queued, shows what auto play would pick next, tagged 'auto'", () => {
    const empty = { queue: [], autoNext: [q("x", false), q("y", false)] } as unknown as SessionState;
    render(<QueueCard sessionCode="demo" state={empty} ready getHeaders={async () => ({})} onState={() => {}} />);
    expect(screen.getAllByText("auto")).toHaveLength(2);
    expect(screen.getByText("Song x")).toBeInTheDocument();
    expect(screen.queryByText(/Empty — add songs/)).not.toBeInTheDocument();
  });
});

describe("libraryGenres (attendee join step)", () => {
  it("offers the library's genres, most songs first, without unknown ones", () => {
    const genres = libraryGenres([
      { genre: "house" },
      { genre: "spotify" },
      { genre: "hip hop" },
      { genre: "House" },
      { genre: "unknown" },
    ]);
    expect(genres).toEqual(["house", "hip hop"]);
  });
});
