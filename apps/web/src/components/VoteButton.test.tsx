import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { VoteButton } from "./VoteButton";

describe("VoteButton", () => {
  it("FE-02: walks idle → pending → accepted / rejected", () => {
    const { rerender } = render(
      <VoteButton feedback="idle" trackTitle="Gator Glow" onVote={() => {}} />,
    );
    const btn = screen.getByRole("button");
    expect(btn).toHaveTextContent("Vote");
    expect(btn).toBeEnabled();

    rerender(<VoteButton feedback="pending" trackTitle="Gator Glow" onVote={() => {}} />);
    expect(btn).toHaveTextContent("Sending…");
    expect(btn).toBeDisabled();

    rerender(<VoteButton feedback="accepted" trackTitle="Gator Glow" onVote={() => {}} />);
    expect(btn).toHaveTextContent("Voted ✓");
    expect(btn).toBeDisabled();

    rerender(<VoteButton feedback="rejected" trackTitle="Gator Glow" onVote={() => {}} />);
    expect(btn).toHaveTextContent("Retry");
    expect(btn).toBeEnabled();
  });

  it("treats a duplicate as already counted", () => {
    render(<VoteButton feedback="duplicate" trackTitle="Gator Glow" onVote={() => {}} />);
    expect(screen.getByRole("button")).toHaveTextContent("Voted ✓");
  });

  it("FE-06: is keyboard-activatable", async () => {
    const onVote = vi.fn();
    render(<VoteButton feedback="idle" trackTitle="Gator Glow" onVote={onVote} />);
    await userEvent.tab();
    expect(screen.getByRole("button")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onVote).toHaveBeenCalledOnce();
  });
});
