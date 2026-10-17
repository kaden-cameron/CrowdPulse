import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_TAPS_PER_BATCH,
  type ConnectionStatus,
  type Mood,
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

const TAP_FLUSH_MS = 1000;

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
  const pendingTaps = useRef(0);

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

    // Hype taps are batched so a frantic tapper sends ~1 message per second.
    const flush = window.setInterval(() => {
      const count = Math.min(MAX_TAPS_PER_BATCH, pendingTaps.current);
      if (!count) return;
      pendingTaps.current -= count;
      socket.sendEvent({
        type: "tap.batch",
        sessionId,
        eventId: createEventId(),
        participantId: getParticipantId(),
        count,
      });
    }, TAP_FLUSH_MS);

    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(flush);
      socket.close();
      socketRef.current = null;
    };
  }, [sessionId, role, applyState]);

  function setMood(mood: Mood) {
    socketRef.current?.sendEvent({
      type: "session.join",
      sessionId,
      eventId: createEventId(),
      participantId: getParticipantId(),
      mood,
    });
  }

  function submitVote(trackId: string) {
    const eventId = createEventId();
    const key = voteKey(state, trackId);
    pendingVotes.current.set(eventId, key);
    setVotes((v) => ({ ...v, [key]: { feedback: "pending", at: Date.now() } }));
    socketRef.current?.sendEvent({
      type: "vote.submit",
      sessionId,
      trackId,
      eventId,
      participantId: getParticipantId(),
    });
  }

  function tap() {
    pendingTaps.current += 1;
  }

  /** This phone's vote state for a track in the current run and round. */
  function voteFor(trackId: string): TrackVote | undefined {
    return votes[voteKey(state, trackId)];
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
    tap,
  };
}
