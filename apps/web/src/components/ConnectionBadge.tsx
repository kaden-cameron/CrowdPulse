import type { ConnectionStatus } from "@crowdpulse/shared";

const LABELS: Record<ConnectionStatus, string> = {
  connecting: "Connecting",
  connected: "Live",
  disconnected: "Disconnected",
  reconnecting: "Reconnecting",
};

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  return (
    <span className={`conn-badge conn-${status}`} role="status">
      <span className="conn-dot" aria-hidden />
      {LABELS[status]}
    </span>
  );
}
