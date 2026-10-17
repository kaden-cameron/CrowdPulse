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

export type TrackVote = { feedback: VoteFeedback; reason?: string };

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
  // eventId -> trackId, so results map back to the right vote button.
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
        const trackId = pendingVotes.current.get(result.eventId);
        if (!trackId) {
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
          [trackId]: {
            feedback: already ? "duplicate" : result.status,
            reason: result.reason,
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
    window.addEventListener("online", onOnline);

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
    pendingVotes.current.set(eventId, trackId);
    setVotes((v) => ({ ...v, [trackId]: { feedback: "pending" } }));
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

  return {
    state,
    status,
    error,
    lastMessageAt,
    votes,
    applyState,
    setMood,
    submitVote,
    tap,
  };
}
