import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ConnectionStatus } from "@crowdpulse/shared";
import { ConnectionBadge } from "./ConnectionBadge";

// Retro desktop menu bar: tabs along the top edge (logo, page, then status, date and clock on the right).

const fmtDate = (d: Date) =>
  d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).replace(/,/g, "").toUpperCase();
const fmtTime = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

export function MenuBar({
  title,
  status,
  lastMessageAt,
  children,
}: {
  title?: string;
  status?: ConnectionStatus;
  lastMessageAt?: number | null;
  /** Extra tabs on the left, after the page title. */
  children?: ReactNode;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(t);
  }, []);

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
        <span className="menubar-tab menubar-date">{fmtDate(now)}</span>
        <span className="menubar-tab menubar-clock" aria-label={`Time ${fmtTime(now)}`}>
          <span aria-hidden>◷</span> {fmtTime(now)}
        </span>
      </div>
    </header>
  );
}
