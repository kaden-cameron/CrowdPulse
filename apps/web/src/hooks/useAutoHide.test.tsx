import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIRM_MS, useAutoHide } from "./useAutoHide";

function Demo({ initial }: { initial: { kind: "accepted" | "rejected"; text: string } }) {
  const [msg, setMsg] = useState<typeof initial | null>(initial);
  useAutoHide(msg, () => setMsg(null));
  return <p>{msg?.text ?? "gone"}</p>;
}

afterEach(() => vi.useRealTimers());

describe("useAutoHide", () => {
  it("clears a green confirmation after a few seconds", () => {
    vi.useFakeTimers();
    render(<Demo initial={{ kind: "accepted", text: "Skipped to the next song" }} />);
    expect(screen.getByText("Skipped to the next song")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(CONFIRM_MS + 10));
    expect(screen.getByText("gone")).toBeInTheDocument();
  });

  it("leaves errors up", () => {
    vi.useFakeTimers();
    render(<Demo initial={{ kind: "rejected", text: "Nothing is playing" }} />);
    act(() => vi.advanceTimersByTime(CONFIRM_MS * 3));
    expect(screen.getByText("Nothing is playing")).toBeInTheDocument();
  });
});
