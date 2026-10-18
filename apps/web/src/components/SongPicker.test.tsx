import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SongPicker } from "./SongPicker";

const items = [
  { key: "a", title: "Alpha", artist: "X" },
  { key: "b", title: "Bravo", artist: "Y" },
  { key: "c", title: "Charlie", artist: "Z", unavailable: "In library" },
];

describe("SongPicker", () => {
  it("picks songs one by one, or all at once (skipping unavailable ones)", async () => {
    const onAdd = vi.fn();
    render(<SongPicker label="Results" items={items} onAdd={onAdd} />);
    expect(screen.getByRole("button", { name: "Add selected (0)" })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Bravo" }));
    await userEvent.click(screen.getByRole("button", { name: "Add selected (1)" }));
    expect(onAdd).toHaveBeenLastCalledWith(["b"]);

    await userEvent.click(screen.getByRole("checkbox", { name: "Select all (2)" }));
    expect(screen.getByRole("checkbox", { name: "Charlie: In library" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Add selected (2)" }));
    expect(onAdd).toHaveBeenLastCalledWith(["a", "b"]);

    await userEvent.click(screen.getByRole("checkbox", { name: "Select all (2)" })); // unselect all
    expect(screen.getByRole("button", { name: "Add selected (0)" })).toBeDisabled();
  });

  it("can start with everything selected (playlist import)", () => {
    render(<SongPicker label="Playlist" items={items} onAdd={() => {}} selectAllInitially />);
    expect(screen.getByRole("button", { name: "Add selected (2)" })).toBeEnabled();
  });
});
