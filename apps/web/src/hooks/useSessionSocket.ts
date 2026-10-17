import { useEffect, useRef, useState } from "react";
import type {
  ConnectionStatus,
  Mood,
  SessionState,
  VoteFeedback,
} from "@crowdpulse/shared";
import { createEventId, fetchSessionState, SessionSocket } from "../lib/ws";

export function useSessionSocket(
  sessionId: string,
  role: "attendee" | "stage" | "host",
) {
  const [state, setState] = useState<SessionState | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [voteFeedback, setVoteFeedback] = useState<VoteFeedback>("idle");
  const [voteReason, setVoteReason] = useState<string | null>(null);
  const socketRef = useRef<SessionSocket | null>(null);
  const pendingEventId = useRef<string | null>(null);
  const moodRef = useRef<Mood | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    fetchSessionState(sessionId)
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch(() => {
        /* WS will retry / supply state */
      });

    const socket = new SessionSocket(sessionId, role, {
      onState: (s) => {
        if (!cancelled) {
          setState(s);
          setError(null);
        }
      },
      onVoteResult: (result) => {
        if (cancelled) return;
        if (
          pendingEventId.current &&
          result.eventId !== pendingEventId.current
        ) {
          return;
        }
        pendingEventId.current = null;
        setVoteFeedback(result.status);
        setVoteReason(result.reason ?? null);
        window.setTimeout(() => {
          setVoteFeedback((current) =>
            current === "pending" ? current : "idle",
          );
        }, 2200);
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

    return () => {
      cancelled = true;
      socket.close();
      socketRef.current = null;
    };
  }, [sessionId, role]);

  function setMood(mood: Mood) {
    moodRef.current = mood;
    socketRef.current?.send({
      type: "session.join",
      sessionId,
      mood,
    });
  }

  function submitVote(trackId: string) {
    const eventId = createEventId();
    pendingEventId.current = eventId;
    setVoteFeedback("pending");
    setVoteReason(null);
    socketRef.current?.send({
      type: "vote.submit",
      sessionId,
      trackId,
      eventId,
      mood: moodRef.current,
    });
  }

  return {
    state,
    status,
    error,
    voteFeedback,
    voteReason,
    setMood,
    submitVote,
  };
}
