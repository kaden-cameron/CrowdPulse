import { useEffect, useState } from "react";
import type { ConnectionStatus } from "@crowdpulse/shared";

const LABELS: Record<ConnectionStatus, string> = {
  connecting: "Connecting",
  connected: "Live",
  disconnected: "Disconnected",
  reconnecting: "Reconnecting",
  not_found: "Session not found",
};

/** Connection status plus data freshness ("3s ago") when live. */
export function ConnectionBadge({
  status,
  lastMessageAt,
}: {
  status: ConnectionStatus;
  lastMessageAt?: number | null;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (lastMessageAt == null) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [lastMessageAt]);
  const age =
    lastMessageAt != null && status === "connected"
      ? Math.max(0, Math.round((Date.now() - lastMessageAt) / 1000))
      : null;

  return (
    <span className={`conn-badge conn-${status}`} role="status">
      <span className="conn-dot" aria-hidden />
      {LABELS[status]}
      {age != null && <span className="conn-age">· {age}s ago</span>}
    </span>
  );
}
