import { useEffect, useRef, type ReactNode } from "react";

// A compact window that drops down from a menu-bar button (top right): ⚙︎ settings or 👤 profile.
// Closes with Escape, the ✕ button, or a click outside.

export function SettingsPanel({
  open,
  onClose,
  children,
  id = "host-settings",
  title = "Settings",
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  id?: string;
  title?: string;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="settings-backdrop" onClick={onClose} aria-hidden />
      <aside ref={panel} id={id} className="settings-panel" role="dialog" aria-label={title} tabIndex={-1}>
        <div className="settings-head">
          <h2>{title}</h2>
          <button type="button" className="btn ghost compact" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}>
            ✕
          </button>
        </div>
        <div className="settings-body">{children}</div>
      </aside>
    </>
  );
}
