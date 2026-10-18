import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { DEFAULT_CROWD_ENERGY, type BoostConfig, type CrowdEnergyLevel } from "@crowdpulse/shared";
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

function energyLabel(n: CrowdEnergyLevel): string {
  if (n <= 25) return "Low";
  if (n <= 50) return "Medium";
  if (n <= 75) return "High";
  return "Peak";
}

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
    setEnergy,
    submitVote,
    retractVote,
    me,
    myVotes,
  } = useSessionSocket(sessionCode, "attendee");
  const tabs = useSingleTab(`crowdpulse-attendee-${sessionCode}`);
  useSessionAppearance(sessionCode, state?.appearance);

  // Joined = this device set energy in the current run (the server remembers, so a reload or a
  // second tab goes straight to voting). A host "Start new run" sends everyone back to join.
  const joined = !!state && !!me && me.run === state.run && me.joined;
  const step: "join" | "vote" = joined ? "vote" : "join";
  const lastRun = readJoinedRun(sessionCode);
  const newRun = !!state && lastRun !== null && lastRun < state.run && !joined;
  const [energy, setEnergyLocal] = useState<CrowdEnergyLevel>(DEFAULT_CROWD_ENERGY);
  const [genre, setGenre] = useState<string | null>(null);
  const genreChoices = libraryGenres(state?.tracks ?? []);
  const maxVotes = state?.maxVotesPerPerson ?? 3;
  const votesLeft = Math.max(0, maxVotes - myVotes.length);
  const [boostConfig, setBoostConfig] = useState<BoostConfig | null>(null);
  const [boostTrack, setBoostTrack] = useState<string | null>(null);

  // Keep the vote-page slider in sync with what the server last recorded for this device.
  useEffect(() => {
    if (me?.energy != null) setEnergyLocal(me.energy);
  }, [me?.energy]);

  useEffect(() => {
    fetchBoostConfig()
      .then(setBoostConfig)
      .catch(() => setBoostConfig(null)); // boosts are optional; voting never depends on them
  }, []);

  function continueToVote() {
    setEnergy(energy, genre);
    if (state) saveJoinedRun(sessionCode, state.run);
  }

  function onEnergyChange(next: CrowdEnergyLevel) {
    setEnergyLocal(next);
    if (joined) setEnergy(next);
  }

  // Latest rejection that still applies, shown once above the list.
  const rejection = voteRejection;
  // The vote list: most-voted first, searchable, PAGE_SIZE songs per page.
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const allTracks = state?.tracks ?? [];
  const [sort, setSort] = useState<VoteSort>("votes");
  const matching = filterAndRank(allTracks, search, sort);
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const pageIndex = Math.min(page, pages - 1);
  const tracks = matching.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE);

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
              A new run just started — set your energy to jump back in.
            </p>
          )}
          <p className="session-kicker">You&apos;re joining</p>
          <h1 className="window-heading">{state?.sessionName ?? "Loading session…"}</h1>
          <p className="privacy-note">
            We use a random anonymous ID on this device — no name, email,
            location, or microphone. Votes are shared only as totals.
          </p>

          <label className="energy-slider-field">
            <span className="metric-label">
              Your energy · {energyLabel(energy)} ({energy})
            </span>
            <div className="energy-slider-row">
              <span className="energy-end">Low</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={energy}
                onChange={(e) => setEnergyLocal(Number(e.target.value))}
                aria-valuetext={`${energyLabel(energy)}, ${energy}`}
              />
              <span className="energy-end">High</span>
            </div>
          </label>

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
            disabled={!state}
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
              {state?.appearance.showEnergy !== false && <>Energy {state?.energyScore ?? "—"} · </>}
              {state?.visualState.theme.replaceAll("_", " ") ?? "—"}
            </p>
          </div>

          <label className="energy-slider-field compact">
            <span className="metric-label">
              Your energy · {energyLabel(energy)} ({energy}) — adjust anytime
            </span>
            <div className="energy-slider-row">
              <span className="energy-end">Low</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={energy}
                onChange={(e) => onEnergyChange(Number(e.target.value))}
                aria-valuetext={`${energyLabel(energy)}, ${energy}`}
              />
              <span className="energy-end">High</span>
            </div>
          </label>

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
            canVote={votesLeft > 0 && tabs.active}
            onAdded={(trackId, vote) => vote && submitVote(trackId)}
          />

          <p className="votes-left" aria-live="polite">
            {votesLeft === 0
              ? `All ${maxVotes} votes used — tap “Voted ✓” on a song to take one back.`
              : `${votesLeft} of ${maxVotes} vote${maxVotes === 1 ? "" : "s"} left`}
          </p>

          {allTracks.length > 0 && (
            <div className="vote-tools">
              <label className="vote-search">
                <span className="visually-hidden">Search songs</span>
                <input
                  type="search"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(0);
                  }}
                  placeholder={`Search ${allTracks.length} songs`}
                />
              </label>
              <label className="vote-sort">
                <span className="visually-hidden">Sort songs</span>
                <select
                  value={sort}
                  onChange={(e) => {
                    setSort(e.target.value as VoteSort);
                    setPage(0);
                  }}
                  aria-label="Sort songs"
                >
                  {(Object.keys(VOTE_SORT_LABELS) as VoteSort[]).map((k) => (
                    <option key={k} value={k}>
                      {VOTE_SORT_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <ul className="track-list panel">
            {allTracks.length > 0 && tracks.length === 0 && (
              <li className="track-row">
                <p className="track-meta">No songs match “{search}”.</p>
              </li>
            )}
            {allTracks.length === 0 && (
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
                    {track.boosts > 0 && ` · boost ×${track.boosts}`}
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
                    Boost
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
          {pages > 1 && (
            <nav className="vote-pages" aria-label="Song pages">
              <button type="button" className="btn ghost compact" disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>
                ‹ Prev
              </button>
              <span>
                Page {pageIndex + 1} of {pages}
              </span>
              <button type="button" className="btn ghost compact" disabled={pageIndex >= pages - 1} onClick={() => setPage(pageIndex + 1)}>
                Next ›
              </button>
            </nav>
          )}

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

/** Songs per page in the attendee's vote list. */
export const PAGE_SIZE = 15;

export type VoteSort = "votes" | "title" | "artist" | "genre" | "newest";
export const VOTE_SORT_LABELS: Record<VoteSort, string> = {
  votes: "Most votes",
  title: "Title A–Z",
  artist: "Artist A–Z",
  genre: "Genre",
  newest: "Newest added",
};

/**
 * The attendee's list: songs matching the search (title, artist or genre) in the chosen order —
 * by default most votes first (boosts break ties, then library order). The playing song stays on top.
 */
export function filterAndRank<T extends { title: string; artist: string; genre: string; votes: number; boosts: number; status: string }>(
  tracks: T[],
  search: string,
  sort: VoteSort = "votes",
): T[] {
  const q = search.trim().toLowerCase();
  const az = (x: string, y: string) => x.localeCompare(y, undefined, { sensitivity: "base" });
  const order = (a: { t: T; i: number }, b: { t: T; i: number }) => {
    switch (sort) {
      case "title":
        return az(a.t.title, b.t.title);
      case "artist":
        return az(a.t.artist, b.t.artist) || az(a.t.title, b.t.title);
      case "genre":
        return az(a.t.genre, b.t.genre) || az(a.t.title, b.t.title);
      case "newest":
        return b.i - a.i;
      default:
        return b.t.votes - a.t.votes || b.t.boosts - a.t.boosts;
    }
  };
  return tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !q || `${t.title} ${t.artist} ${t.genre}`.toLowerCase().includes(q))
    .sort((a, b) => Number(b.t.status === "playing") - Number(a.t.status === "playing") || order(a, b) || a.i - b.i)
    .map(({ t }) => t);
}
