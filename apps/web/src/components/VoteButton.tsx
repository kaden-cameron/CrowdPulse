import type { VoteFeedback } from "@crowdpulse/shared";

const LABELS: Record<VoteFeedback, string> = {
  idle: "Vote",
  pending: "Sending…",
  accepted: "Voted ✓",
  duplicate: "Voted ✓",
  rejected: "Retry",
};

export function VoteButton({
  feedback,
  trackTitle,
  disabled,
  onVote,
}: {
  feedback: VoteFeedback;
  trackTitle: string;
  disabled?: boolean;
  onVote: () => void;
}) {
  const done = feedback === "accepted" || feedback === "duplicate";
  return (
    <button
      type="button"
      className={`btn compact vote-btn vote-${feedback} ${done ? "ghost" : "primary"}`}
      data-feedback={feedback}
      aria-label={`${LABELS[feedback]}: ${trackTitle}`}
      aria-busy={feedback === "pending"}
      disabled={disabled || feedback === "pending" || done}
      onClick={onVote}
    >
      {LABELS[feedback]}
    </button>
  );
}
