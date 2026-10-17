import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Mood } from "@crowdpulse/shared";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { useSessionSocket } from "../hooks/useSessionSocket";

const MOODS: { id: Mood; label: string; hint: string }[] = [
  { id: "chill", label: "Chill", hint: "Laid-back waves" },
  { id: "hyped", label: "Hyped", hint: "Turn it up" },
  { id: "focused", label: "Focused", hint: "Clean & crisp" },
  { id: "wild", label: "Wild", hint: "Full send" },
];

export function JoinPage() {
  const { sessionCode = "demo" } = useParams();
  const {
    state,
    status,
    error,
    voteFeedback,
    voteReason,
    setMood,
    submitVote,
  } = useSessionSocket(sessionCode, "attendee");

  const [step, setStep] = useState<"join" | "vote">("join");
  const [mood, setMoodLocal] = useState<Mood | null>(null);
  const [pendingTrack, setPendingTrack] = useState<string | null>(null);

  function continueToVote() {
    if (!mood) return;
    setMood(mood);
    setStep("vote");
  }

  function onVote(trackId: string) {
    setPendingTrack(trackId);
    submitVote(trackId);
  }

  const feedbackLabel =
    voteFeedback === "pending"
      ? "Submitting vote…"
      : voteFeedback === "accepted"
        ? "Vote accepted"
        : voteFeedback === "rejected"
          ? `Rejected${voteReason ? `: ${voteReason}` : ""}`
          : voteFeedback === "duplicate"
            ? "Already counted"
            : null;

  return (
    <main className="join-page">
      <header className="page-top">
        <Link to="/" className="brand-inline">
          CrowdPulse
        </Link>
        <ConnectionBadge status={status} />
      </header>

      {step === "join" ? (
        <section className="join-panel">
          <p className="session-kicker">You&apos;re joining</p>
          <h1>{state?.sessionName ?? "Loading session…"}</h1>
          <p className="privacy-note">
            Votes are tied to this session only. We don&apos;t ask for your name
            or phone number.
          </p>

          <fieldset className="mood-field">
            <legend>Pick a mood</legend>
            <div className="mood-grid">
              {MOODS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`mood-chip ${mood === m.id ? "selected" : ""}`}
                  onClick={() => setMoodLocal(m.id)}
                  aria-pressed={mood === m.id}
                >
                  <span className="mood-label">{m.label}</span>
                  <span className="mood-hint">{m.hint}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <button
            type="button"
            className="btn primary wide"
            disabled={!mood}
            onClick={continueToVote}
          >
            Continue to vote
          </button>
        </section>
      ) : (
        <section className="vote-panel">
          <div className="vote-heading">
            <h1>Shape the queue</h1>
            <p>
              Energy {state?.energyScore ?? "—"} · Theme{" "}
              {state?.visualState.theme.replace("_", " ") ?? "—"}
            </p>
          </div>

          {feedbackLabel && (
            <p
              className={`feedback feedback-${voteFeedback}`}
              role="status"
              aria-live="polite"
            >
              {feedbackLabel}
            </p>
          )}
          {error && (
            <p className="feedback feedback-rejected" role="alert">
              {error}
            </p>
          )}
          {(status === "disconnected" || status === "reconnecting") && (
            <p className="feedback feedback-warn" role="status">
              Connection lost — votes will send when you&apos;re back online.
            </p>
          )}

          <ul className="track-list">
            {(state?.tracks ?? []).map((track) => (
              <li key={track.id} className="track-row">
                <div>
                  <p className="track-title">{track.title}</p>
                  <p className="track-meta">
                    {track.artist} · {track.votes} votes · {track.status}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn primary compact"
                  disabled={
                    status !== "connected" || voteFeedback === "pending"
                  }
                  aria-busy={
                    voteFeedback === "pending" && pendingTrack === track.id
                  }
                  onClick={() => onVote(track.id)}
                >
                  {voteFeedback === "pending" && pendingTrack === track.id
                    ? "…"
                    : "Vote"}
                </button>
              </li>
            ))}
          </ul>

          <p className="stage-link">
            Watching on the big screen?{" "}
            <Link to={`/stage/${sessionCode}`}>Open stage view</Link>
          </p>
        </section>
      )}
    </main>
  );
}
