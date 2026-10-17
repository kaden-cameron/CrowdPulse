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
import { useSingleTab } from "../lib/singleTab";

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
    retractVote,
    me,
    myVotes,
  } = useSessionSocket(sessionCode, "attendee");
  const tabs = useSingleTab(`crowdpulse-attendee-${sessionCode}`);
  useSessionAppearance(sessionCode, state?.appearance);

  // Joined = this device picked a mood in the current run (the server remembers, so a reload or a
  // second tab goes straight to voting). A host "Start new run" sends everyone back to join.
  const joined = !!state && !!me && me.run === state.run && me.joined;
  const step: "join" | "vote" = joined ? "vote" : "join";
  const lastRun = readJoinedRun(sessionCode);
  const newRun = !!state && lastRun !== null && lastRun < state.run && !joined;
  const [mood, setMoodLocal] = useState<Mood | null>(null);
  const [genre, setGenre] = useState<string | null>(null);
  const genreChoices = libraryGenres(state?.tracks ?? []);
  const maxVotes = state?.maxVotesPerPerson ?? 3;
  const votesLeft = Math.max(0, maxVotes - myVotes.length);
  const [boostConfig, setBoostConfig] = useState<BoostConfig | null>(null);
  const [boostTrack, setBoostTrack] = useState<string | null>(null);

  useEffect(() => {
    fetchBoostConfig()
      .then(setBoostConfig)
      .catch(() => setBoostConfig(null)); // boosts are optional; voting never depends on them
  }, []);

  function continueToVote() {
    if (!mood) return;
    setMood(mood, genre);
    if (state) saveJoinedRun(sessionCode, state.run);
  }

  // Latest rejection that still applies, shown once above the list.
  const rejection = voteRejection;
  const tracks = state?.tracks ?? [];

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
      {!tabs.active && (
        <Window title="Another tab" className="join-panel">
          <p className="window-heading">CrowdPulse is open in another tab</p>
          <p className="privacy-note">One voter per device — use it there, or move it here.</p>
          <button type="button" className="btn primary wide" onClick={tabs.takeOver}>
            Use it here
          </button>
        </Window>
      )}
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

          <fieldset className="mood-field">
            <legend>What do you want to hear?</legend>
            <div className="genre-grid">
              {[...genreChoices, null].map((g) => (
                <button
                  key={g ?? "any"}
                  type="button"
                  className={`mood-chip compact ${genre === g ? "selected" : ""}`}
                  onClick={() => setGenre(g)}
                  aria-pressed={genre === g}
                >
                  <span className="mood-label">{g ? titleCase(g) : "Anything"}</span>
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

          <p className="votes-left" aria-live="polite">
            {votesLeft === 0
              ? `All ${maxVotes} votes used — tap “Voted ✓” on a song to take one back.`
              : `${votesLeft} of ${maxVotes} vote${maxVotes === 1 ? "" : "s"} left`}
          </p>

          <ul className="track-list panel">
            {tracks.length === 0 && (
              <li className="track-row">
                <div>
                  <p className="track-title">No songs yet</p>
                  <p className="track-meta">Search Spotify above to add a real track to the queue.</p>
                </div>
              </li>
            )}
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
                  disabled={track.status === "playing" || votesLeft === 0 || !tabs.active}
                  onVote={() => submitVote(track.id)}
                  onUnvote={tabs.active ? () => retractVote(track.id) : undefined}
                />
              </li>
            ))}
          </ul>

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


const titleCase = (g: string) => g.replace(/\b\w/g, (c) => c.toUpperCase());

/** Genres in the host's library, most songs first (up to 8), for the join step. */
export function libraryGenres(tracks: { genre: string }[]): string[] {
  const counts = new Map<string, number>();
  for (const t of tracks) {
    const g = t.genre.trim().toLowerCase();
    if (g && g !== "unknown" && g !== "spotify") counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([g]) => g);
}

const runKey = (sessionCode: string) => `crowdpulse.joinedRun.${sessionCode}`;
function readJoinedRun(sessionCode: string): number | null {
  try {
    const v = localStorage.getItem(runKey(sessionCode));
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}
function saveJoinedRun(sessionCode: string, run: number) {
  try {
    localStorage.setItem(runKey(sessionCode), String(run));
  } catch {
    /* storage blocked */
  }
}
