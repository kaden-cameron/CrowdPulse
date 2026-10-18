import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ConnectionStatus } from "@crowdpulse/shared";
import { ConnectionBadge } from "./ConnectionBadge";

// Retro desktop menu bar: tabs along the top edge (logo and page on the left, connection status on the right).

export function MenuBar({
  title,
  status,
  lastMessageAt,
  children,
  actions,
}: {
  title?: string;
  status?: ConnectionStatus;
  lastMessageAt?: number | null;
  /** Extra tabs on the left, after the page title. */
  children?: ReactNode;
  /** Buttons on the right edge, e.g. the host's ⚙︎ settings. */
  actions?: ReactNode;
}) {
  return (
    <header className="menubar">
      <div className="menubar-group">
        <Link to="/" className="menubar-tab menubar-logo" aria-label="CrowdPulse home">
          <span aria-hidden>☼</span>
          <span className="menubar-brand">CrowdPulse</span>
        </Link>
        {title && <span className="menubar-tab">{title}</span>}
        {children}
      </div>
      <div className="menubar-group">
        {status && (
          <span className="menubar-tab menubar-status">
            <ConnectionBadge status={status} lastMessageAt={lastMessageAt} />
          </span>
        )}
        {actions}
      </div>
    </header>
  );
}
