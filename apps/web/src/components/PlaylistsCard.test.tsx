import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "@crowdpulse/shared";
import { PlaylistsCard } from "./PlaylistsCard";

const state = { tracks: [{ id: "a" }, { id: "b" }, { id: "c" }] } as unknown as SessionState;
const pl = { id: "pl_1", name: "Friday warm-up", count: 12, updatedAt: "2026-10-17T20:00:00Z" };

function mockNet() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if ((init?.method ?? "GET") === "GET") return Response.json({ playlists: [pl] });
      return Response.json({ status: "accepted", state });
    }),
  );
  return calls;
}
afterEach(() => vi.unstubAllGlobals());
const props = { sessionCode: "demo", state, ready: true, getHeaders: async () => ({}), onState: () => {} };

describe("PlaylistsCard", () => {
  it("lists saved playlists and saves the library under a name", async () => {
    const calls = mockNet();
    render(<PlaylistsCard {...props} />);
    expect(await screen.findByText("Friday warm-up")).toBeInTheDocument();
    expect(screen.getByText(/12 songs/)).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText(/Name it/), "Late night");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Late night" }));
    expect(await screen.findByText(/Saved “Late night” \(3 songs\)/)).toBeInTheDocument();
  });

  it("Load replaces the library (after asking) and can queue it; Add adds", async () => {
    const calls = mockNet();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PlaylistsCard {...props} />);
    await screen.findByText("Friday warm-up");
    await userEvent.click(screen.getByRole("checkbox", { name: /Also put loaded songs in the queue/ }));
    await userEvent.click(screen.getByRole("button", { name: "Load Friday warm-up (replace the library)" }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith("/pl_1/load"))?.body).toEqual({ replace: true, queue: true }));
    expect(confirm).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("checkbox", { name: /Also put loaded songs in the queue/ }));
    await userEvent.click(screen.getByRole("button", { name: "Add Friday warm-up to the library" }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/pl_1/load")).at(-1)?.body).toEqual({ replace: false, queue: false }));
    confirm.mockRestore();
  });

  it("renames and deletes", async () => {
    const calls = mockNet();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PlaylistsCard {...props} />);
    await screen.findByText("Friday warm-up");
    await userEvent.click(screen.getByLabelText("More for Friday warm-up"));
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    const box = screen.getByRole("textbox", { name: "New name for Friday warm-up" });
    await userEvent.clear(box);
    await userEvent.type(box, "Saturday");
    await userEvent.click(screen.getByRole("button", { name: "Save new name" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "Saturday" }));
    await userEvent.click(screen.getByLabelText("More for Friday warm-up"));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/api/host/sessions/demo/playlists/pl_1"));
    confirm.mockRestore();
  });

  it("keeps the typed name and rename text when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        (init?.method ?? "GET") === "GET" ? Response.json({ playlists: [pl] }) : Response.json({ error: "Name taken" }, { status: 409 }),
      ),
    );
    render(<PlaylistsCard {...props} />);
    await screen.findByText("Friday warm-up");
    await userEvent.type(screen.getByPlaceholderText(/Name it/), "Late night");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Name taken")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Name it/)).toHaveValue("Late night");
    await userEvent.click(screen.getByLabelText("More for Friday warm-up"));
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    const box = screen.getByRole("textbox", { name: "New name for Friday warm-up" });
    await userEvent.type(box, "!");
    await userEvent.click(screen.getByRole("button", { name: "Save new name" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save new name" })).toBeEnabled());
    expect(screen.getByRole("textbox", { name: "New name for Friday warm-up" })).toHaveValue("Friday warm-up!");
  });
});
