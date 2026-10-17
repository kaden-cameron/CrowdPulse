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

describe("VoteButton take-back", () => {
  it("a voted song can be tapped again to take the vote back", async () => {
    const onVote = vi.fn();
    const onUnvote = vi.fn();
    render(<VoteButton feedback="accepted" trackTitle="Gator Glow" onVote={onVote} onUnvote={onUnvote} />);
    const btn = screen.getByRole("button", { name: "Take back your vote for Gator Glow" });
    expect(btn).toBeEnabled();
    expect(btn).toHaveTextContent("Voted ✓ · undo");
    await userEvent.click(btn);
    expect(onUnvote).toHaveBeenCalledOnce();
    expect(onVote).not.toHaveBeenCalled();
  });

  it("stays disabled for new votes when all votes are used", () => {
    render(<VoteButton feedback="idle" trackTitle="Gator Glow" disabled onVote={() => {}} onUnvote={() => {}} />);
    expect(screen.getByRole("button")).toBeDisabled();
  });
});
