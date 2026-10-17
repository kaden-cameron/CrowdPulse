import type { VoteFeedback } from "@crowdpulse/shared";

const LABELS: Record<VoteFeedback, string> = {
  idle: "Vote",
  pending: "Sending…",
  accepted: "Voted ✓",
  duplicate: "Voted ✓",
  rejected: "Retry",
};

/**
 * Vote for a song. Once voted, tapping again takes the vote back (when `onUnvote` is given),
 * which frees it for another song.
 */
export function VoteButton({
  feedback,
  trackTitle,
  disabled,
  onVote,
  onUnvote,
}: {
  feedback: VoteFeedback;
  trackTitle: string;
  disabled?: boolean;
  onVote: () => void;
  onUnvote?: () => void;
}) {
  const done = feedback === "accepted" || feedback === "duplicate";
  const canUndo = done && !!onUnvote;
  return (
    <button
      type="button"
      className={`btn compact vote-btn vote-${feedback} ${done ? "ghost" : "primary"}`}
      data-feedback={feedback}
      aria-label={canUndo ? `Take back your vote for ${trackTitle}` : `${LABELS[feedback]}: ${trackTitle}`}
      title={canUndo ? "Tap to take your vote back" : undefined}
      aria-busy={feedback === "pending"}
      disabled={feedback === "pending" || (done ? !canUndo : disabled)}
      onClick={canUndo ? onUnvote : onVote}
    >
      {canUndo ? (
        <>
          Voted ✓<span className="vote-undo"> · undo</span>
        </>
      ) : (
        LABELS[feedback]
      )}
    </button>
  );
}
