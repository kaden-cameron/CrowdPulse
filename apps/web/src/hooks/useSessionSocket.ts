import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ConnectionStatus,
  type Mood,
  type ParticipantState,
  type SessionState,
  type VoteFeedback,
} from "@crowdpulse/shared";
import {
  createEventId,
  fetchSessionState,
  getParticipantId,
  isNewer,
  SessionSocket,
} from "../lib/ws";

export type TrackVote = { feedback: VoteFeedback; reason?: string; at: number };

/**
 * A vote button's identity: run + track + round. A new run (host "Start new run") or a track that
 * has played again gets a fresh key, so old "Voted ✓" / "Rejected" states don't stick.
 */
function voteKey(state: SessionState | null, trackId: string): string {
  const round = state?.tracks.find((t) => t.id === trackId)?.round ?? 0;
  return `${state?.run ?? 0}:${trackId}:${round}`;
}

/** This device's own choices in the session (votes, join), from the server. */
async function fetchMe(sessionId: string): Promise<ParticipantState> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(getParticipantId())}`);
  if (!res.ok) throw new Error("Failed to load your votes");
  return res.json() as Promise<ParticipantState>;
}

export function useSessionSocket(
  sessionId: string,
  role: "attendee" | "stage" | "host",
) {
  const [state, setState] = useState<SessionState | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  const [votes, setVotes] = useState<Record<string, TrackVote>>({});
  const socketRef = useRef<SessionSocket | null>(null);
  // eventId -> vote key, so results map back to the right vote button.
  const pendingVotes = useRef(new Map<string, string>());
  // eventId -> vote / unvote in flight, so results update this device's own votes.
  const pendingOps = useRef(new Map<string, { kind: "vote" | "unvote"; trackId: string; key: string }>());
  const [me, setMe] = useState<ParticipantState | null>(null);
  const run = state?.run;

  // Who this device is in the session: joined already? which songs has it voted for? Loaded on
  // open and on every new run, so a reload or another tab doesn't ask to join again.
  useEffect(() => {
    if (role !== "attendee" || run === undefined) return;
    let cancelled = false;
    fetchMe(sessionId)
      .then((m) => !cancelled && setMe(m))
      .catch(() => {
        /* offline: the join step shows instead */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, role, run]);

  const applyState = useCallback((next: SessionState) => {
    setState((prev) => (isNewer(prev, next) ? next : prev));
    setLastMessageAt(Date.now());
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetchSessionState(sessionId)
      .then((s) => {
        if (!cancelled) applyState(s);
      })
      .catch(() => {
        /* WS will retry / supply state */
      });

    const socket = new SessionSocket(sessionId, role, {
      onState: (s) => {
        if (!cancelled) {
          applyState(s);
          setError(null);
        }
      },
      onEventResult: (result) => {
        if (cancelled) return;
        if (result.retryable) {
          // Not saved yet; the socket resends it. Keep the vote button pending.
          setError("Couldn't save to the database — retrying…");
          return;
        }
        const op = pendingOps.current.get(result.eventId);
        if (op) {
          pendingOps.current.delete(result.eventId);
          // Keep this device's own vote list in step with the server.
          const has =
            op.kind === "vote"
              ? result.status !== "rejected" || result.reason === "Already voted for this track"
              : !(result.status !== "rejected" || result.reason === "No vote to take back");
          setMe((prev) => {
            const m = prev ?? { run: 0, joined: true, mood: null, genre: null, votes: [] };
            return { ...m, votes: has ? [...new Set([...m.votes, op.trackId])] : m.votes.filter((id) => id !== op.trackId) };
          });
          if (op.kind === "unvote") {
            // The button's look comes from the vote list again (no "Retry" for a take-back).
            setVotes((v) => {
              const next = { ...v };
              delete next[op.key];
              return next;
            });
            if (result.status === "rejected" && result.reason !== "No vote to take back") {
              setError(result.reason ?? "Couldn't take the vote back");
            }
            return;
          }
        }
        const key = pendingVotes.current.get(result.eventId);
        if (!key) {
          if (result.status === "rejected" && result.reason !== "Rate limit exceeded") {
            setError(result.reason ?? "Request rejected");
          }
          return;
        }
        pendingVotes.current.delete(result.eventId);
        // "Already voted" means the server has this person's vote: show it as counted.
        const already = result.reason === "Already voted for this track";
        setVotes((v) => ({
          ...v,
          [key]: {
            feedback: already ? "duplicate" : result.status,
            reason: result.reason,
            at: Date.now(),
          },
        }));
      },
      onStatus: (s) => {
        if (!cancelled) setStatus(s);
      },
      onError: (message) => {
        if (!cancelled) setError(message);
      },
    });

    socketRef.current = socket;
    socket.connect();

    const onOnline = () => socket.reconnectNow();
    const onOffline = () => socket.dropForOffline();
    // Phones suspend background tabs and can kill the socket without telling the page.
    // After more than a few seconds away, reconnect on return so state is current.
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
      } else if (hiddenAt !== null && Date.now() - hiddenAt > 5000) {
        hiddenAt = null;
        socket.refresh();
      } else {
        hiddenAt = null;
      }
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibility);
      socket.close();
      socketRef.current = null;
    };
  }, [sessionId, role, applyState]);

  function setMood(mood: Mood, genre?: string | null) {
    socketRef.current?.sendEvent({
      type: "session.join",
      sessionId,
      eventId: createEventId(),
      participantId: getParticipantId(),
      mood,
      ...(genre ? { genre } : {}),
    });
    setMe((m) => ({ run: state?.run ?? m?.run ?? 0, joined: true, mood, genre: genre ?? null, votes: m?.votes ?? [] }));
  }

  function submitVote(trackId: string) {
    const eventId = createEventId();
    const key = voteKey(state, trackId);
    pendingVotes.current.set(eventId, key);
    setVotes((v) => ({ ...v, [key]: { feedback: "pending", at: Date.now() } }));
    pendingOps.current.set(eventId, { kind: "vote", trackId, key });
    socketRef.current?.sendEvent({
      type: "vote.submit",
      sessionId,
      trackId,
      eventId,
      participantId: getParticipantId(),
    });
  }

  /** Take back this device's vote for a song. */
  function retractVote(trackId: string) {
    const eventId = createEventId();
    const key = voteKey(state, trackId);
    pendingOps.current.set(eventId, { kind: "unvote", trackId, key });
    setVotes((v) => ({ ...v, [key]: { feedback: "pending", at: Date.now() } }));
    socketRef.current?.sendEvent({
      type: "vote.retract",
      sessionId,
      trackId,
      eventId,
      participantId: getParticipantId(),
    });
  }

  // A song that starts playing uses its votes up (the server clears them), and removed songs go:
  // drop those from this device's list for good, so the song is votable again in its next round.
  const spent = (me?.votes ?? []).filter((id) => !state?.tracks.some((t) => t.id === id && t.status !== "playing"));
  const spentKey = state ? spent.join(",") : "";
  useEffect(() => {
    if (!spentKey) return;
    const gone = new Set(spentKey.split(","));
    setMe((m) => m && { ...m, votes: m.votes.filter((id) => !gone.has(id)) });
  }, [spentKey]);
  const myVotes = (me?.votes ?? []).filter((id) => !spent.includes(id));

  /** This phone's vote state for a track in the current run and round. */
  function voteFor(trackId: string): TrackVote | undefined {
    const local = votes[voteKey(state, trackId)];
    if (local?.feedback === "pending" || local?.feedback === "rejected") return local;
    // Otherwise the server's list decides (survives reloads and other tabs).
    return myVotes.includes(trackId) ? { feedback: "accepted", at: local?.at ?? 0 } : local?.feedback === "accepted" ? undefined : local;
  }

  /** Most recent rejection that still applies (current run/round only). */
  const currentKeys = new Set((state?.tracks ?? []).map((t) => voteKey(state, t.id)));
  const voteRejection =
    Object.entries(votes)
      .filter(([k, v]) => currentKeys.has(k) && v.feedback === "rejected")
      .sort((a, b) => b[1].at - a[1].at)[0]?.[1].reason ?? null;

  return {
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
  };
}
