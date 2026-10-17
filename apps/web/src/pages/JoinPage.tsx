import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Mood } from "@crowdpulse/shared";
import { ConnectionBadge } from "../components/ConnectionBadge";
import { VoteButton } from "../components/VoteButton";
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
    lastMessageAt,
    votes,
    setMood,
    submitVote,
    tap,
  } = useSessionSocket(sessionCode, "attendee");

  const [step, setStep] = useState<"join" | "vote">("join");
  const [mood, setMoodLocal] = useState<Mood | null>(null);
  const [myTaps, setMyTaps] = useState(0);

  function continueToVote() {
    if (!mood) return;
    setMood(mood);
    setStep("vote");
  }

  function onTap() {
    tap();
    setMyTaps((n) => n + 1);
    navigator.vibrate?.(10);
  }

  // Latest rejection reason across tracks, shown once above the list.
  const rejection = Object.values(votes).find(
    (v) => v.feedback === "rejected",
  )?.reason;
  const offline = status !== "connected";

  if (status === "not_found") {
    return (
      <main className="join-page">
        <header className="page-top">
          <Link to="/" className="brand-inline">
            CrowdPulse
          </Link>
          <ConnectionBadge status={status} />
        </header>
        <section className="join-panel">
          <h1>Session not found</h1>
          <p className="privacy-note">
            Check the code on the stage screen and try again.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="join-page">
      <header className="page-top">
        <Link to="/" className="brand-inline">
          CrowdPulse
        </Link>
        <ConnectionBadge status={status} lastMessageAt={lastMessageAt} />
      </header>

      {step === "join" ? (
        <section className="join-panel">
          <p className="session-kicker">You&apos;re joining</p>
          <h1>{state?.sessionName ?? "Loading session…"}</h1>
          <p className="privacy-note">
            We use a random anonymous ID on this device — no name, email,
            location, or microphone. Votes and taps are shared only as totals.
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

          <div role="status" aria-live="polite">
            {rejection && (
              <p className="feedback feedback-rejected">Rejected: {rejection}</p>
            )}
          </div>
          {error && (
            <p className="feedback feedback-rejected" role="alert">
              {error}
            </p>
          )}
          {(status === "disconnected" || status === "reconnecting") && (
            <p className="feedback feedback-warn" role="status">
              Connection lost — pending votes will send when you&apos;re back
              online.
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
                <VoteButton
                  feedback={votes[track.id]?.feedback ?? "idle"}
                  trackTitle={track.title}
                  disabled={track.status === "playing"}
                  onVote={() => submitVote(track.id)}
                />
              </li>
            ))}
          </ul>

          <section className="hype-panel" aria-labelledby="hype-title">
            <h2 id="hype-title">
              {state?.crowdQuest.label ?? "Crowd quest"}
            </h2>
            <div className="quest-bar">
              <div
                style={{
                  width: `${state ? Math.min(100, (state.crowdQuest.progress / state.crowdQuest.goal) * 100) : 0}%`,
                }}
              />
            </div>
            <p className="track-meta">
              {state?.crowdQuest.progress ?? 0} / {state?.crowdQuest.goal ?? 100}
            </p>
            <button
              type="button"
              className="btn hype wide"
              onClick={onTap}
              disabled={offline}
            >
              Hype tap 🔥 <span className="hype-count">({myTaps} from you)</span>
            </button>
          </section>

          <p className="stage-link">
            Watching on the big screen?{" "}
            <Link to={`/stage/${sessionCode}`}>Open stage view</Link>
          </p>
        </section>
      )}
    </main>
  );
}
