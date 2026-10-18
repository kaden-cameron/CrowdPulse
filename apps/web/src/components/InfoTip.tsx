import type { ReactNode } from "react";

/** A small "?" that shows an explanation on hover or keyboard focus. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="info-tip" tabIndex={0} aria-label={`About ${label}`}>
      <span aria-hidden>?</span>
      <span className="info-tip-text" role="tooltip">
        {children}
      </span>
    </span>
  );
}
