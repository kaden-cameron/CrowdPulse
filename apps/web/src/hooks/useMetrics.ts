import { useEffect, useState } from "react";
import type { SessionMetrics } from "@crowdpulse/shared";

const POLL_MS = 3000;

/**
 * Polls the TigerData-backed metrics endpoint (host-only). Waits until the host is signed in, and
 * keeps the last good result when a poll fails.
 */
export function useMetrics(sessionId: string, ready: boolean, getHeaders: () => Promise<Record<string, string>>) {
  const [metrics, setMetrics] = useState<SessionMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/metrics`, { headers: await getHeaders() });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? `Metrics request failed (${res.status})`);
        if (cancelled) return;
        setMetrics(body as SessionMetrics);
        setFetchedAt(Date.now());
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Metrics unavailable");
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, POLL_MS);
      }
    };
    poll();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getHeaders is read on each poll
  }, [sessionId, ready]);

  return { metrics, error, fetchedAt };
}
