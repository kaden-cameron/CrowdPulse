import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { BoostConfig, Mood } from "@crowdpulse/shared";
import { BoostPanel } from "../components/BoostPanel";
import { SpotifySearch } from "../components/SpotifySearch";
import { fetchBoostConfig } from "../lib/solana";
import { MenuBar } from "../components/MenuBar";
import { Window } from "../components/Window";
import { VoteButton } from "../components/VoteButton";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { useSessionAppearance } from "../lib/theme";
import { getParticipantId } from "../lib/ws";

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
    voteFor,
    voteRejection,
    applyState,
    setMood,
    submitVote,
  } = useSessionSocket(sessionCode, "attendee");
  useSessionAppearance(sessionCode, state?.appearance);

  // Which run this phone joined. A host "Start new run" bumps state.run, which sends everyone
  // back to the mood step for the new run.
  const [joinedRun, setJoinedRun] = useState<number | null>(null);
  const step: "join" | "vote" = state && joinedRun === state.run ? "vote" : "join";
  const newRun = joinedRun !== null && state !== null && joinedRun !== state.run;
  const [mood, setMoodLocal] = useState<Mood | null>(null);
  const [boostConfig, setBoostConfig] = useState<BoostConfig | null>(null);
  const [boostTrack, setBoostTrack] = useState<string | null>(null);

  useEffect(() => {
    fetchBoostConfig()
      .then(setBoostConfig)
      .catch(() => setBoostConfig(null)); // boosts are optional; voting never depends on them
  }, []);

  function continueToVote() {
    if (!mood) return;
    setMood(mood);
    setJoinedRun(state?.run ?? null);
  }

  // Latest rejection that still applies, shown once above the list.
  const rejection = voteRejection;
  const groups = groupByGenre(state?.tracks ?? []);

  if (status === "not_found") {
    return (
      <main className="join-page">
        <MenuBar status={status} />
        <div className="join-stack">
          <Window title="Hmm…" className="join-panel" headingLevel={1}>
            <p className="window-heading">Session not found</p>
            <p className="privacy-note">Check the code on the stage screen and try again.</p>
          </Window>
        </div>
      </main>
    );
  }

  return (
    <main className="join-page">
      <MenuBar status={status} lastMessageAt={lastMessageAt} />

      <div className="join-stack">
      {step === "join" ? (
        <Window title="Welcome" className="join-panel" headingLevel={2}>
          {newRun && (
            <p className="feedback feedback-pending" role="status">
              A new run just started — pick your mood to jump back in.
            </p>
          )}
          <p className="session-kicker">You&apos;re joining</p>
          <h1 className="window-heading">{state?.sessionName ?? "Loading session…"}</h1>
          <p className="privacy-note">
            We use a random anonymous ID on this device — no name, email,
            location, or microphone. Votes are shared only as totals.
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
            disabled={!mood || !state}
            onClick={continueToVote}
          >
            Continue to vote
          </button>
        </Window>
      ) : (
        <>
        <Window title="Vote" className="vote-panel">
          <div className="vote-heading">
            <h1 className="window-heading">Shape the queue</h1>
            <p className="on-air">
              {state?.nowPlaying ? (
                <>
                  <strong>ON AIR</strong> <span className="on-air-dot" aria-hidden>●</span> {state.nowPlaying.title}
                </>
              ) : (
                "Nothing playing yet"
              )}
            </p>
            <p className="vote-stats">
              Energy {state?.energyScore ?? "—"} · {state?.visualState.theme.replaceAll("_", " ") ?? "—"}
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

          <SpotifySearch
            sessionId={sessionCode}
            participantId={getParticipantId()}
            onAdded={(trackId) => submitVote(trackId)}
          />

          {!groups.length && (
            <ul className="track-list panel">
              <li className="track-row">
                <div>
                  <p className="track-title">No songs yet</p>
                  <p className="track-meta">Search Spotify above to add a real track to the queue.</p>
                </div>
              </li>
            </ul>
          )}
          {groups.map(({ genre, tracks }) => (
            <details key={genre} className="genre-group" open>
              <summary>
                <span>{genre}</span>
                <span className="genre-count">{tracks.length}</span>
              </summary>
              <ul className="track-list panel">
                {tracks.map((track) => (
                  <li key={track.id} className="track-row">
                    <div>
                      <p className="track-title">{track.title}</p>
                      <p className="track-meta">
                        {track.artist} · {track.votes} {track.votes === 1 ? "vote" : "votes"}
                        {track.boosts > 0 && ` · ⚡${track.boosts}`}
                        {track.status !== "open" && ` · ${track.status}`}
                      </p>
                    </div>
                    {boostConfig?.enabled && track.status !== "playing" && (
                      <button
                        type="button"
                        className="btn ghost compact boost-btn"
                        aria-label={`Boost ${track.title} with Solana devnet (optional)`}
                        onClick={() => setBoostTrack(track.id)}
                      >
                        ⚡
                      </button>
                    )}
                    <VoteButton
                      feedback={voteFor(track.id)?.feedback ?? "idle"}
                      trackTitle={track.title}
                      disabled={track.status === "playing"}
                      onVote={() => submitVote(track.id)}
                    />
                  </li>
                ))}
              </ul>
            </details>
          ))}

          {boostTrack && boostConfig && (
            <BoostPanel
              key={boostTrack}
              sessionId={sessionCode}
              trackId={boostTrack}
              trackTitle={state?.tracks.find((t) => t.id === boostTrack)?.title ?? boostTrack}
              config={boostConfig}
              blockedReason={
                state?.tracks.find((t) => t.id === boostTrack)?.status === "playing"
                  ? "This track just started playing, so boosting it now would have no effect."
                  : null
              }
              onState={applyState}
              onClose={() => setBoostTrack(null)}
            />
          )}

        </Window>


          <p className="stage-link">
            Watching on the big screen? <Link to={`/stage/${sessionCode}`}>Open stage view</Link>
          </p>
        </>
      )}
      </div>
    </main>
  );
}

const OTHER = "Other";

/** The library grouped by genre for attendees (alphabetical, "Other" last; songs keep library order). */
export function groupByGenre<T extends { genre: string }>(tracks: T[]): { genre: string; tracks: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const t of tracks) {
    const g = t.genre.trim().toLowerCase();
    const label = !g || g === "unknown" || g === "spotify" ? OTHER : g.replace(/\b\w/g, (c) => c.toUpperCase());
    groups.set(label, [...(groups.get(label) ?? []), t]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === OTHER ? 1 : b === OTHER ? -1 : a.localeCompare(b)))
    .map(([genre, list]) => ({ genre, tracks: list }));
}
