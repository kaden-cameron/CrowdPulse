import { useEffect } from "react";

/** How long a green "done" message stays up. */
export const CONFIRM_MS = 3_000;

/**
 * Clears a confirmation ("Skipped to the next song", "Added 3 songs") a few seconds after it
 * appears. Errors and in-progress messages stay until the next action, so they aren't missed.
 */
export function useAutoHide<T extends { kind: string } | string | null>(value: T, clear: () => void, ms = CONFIRM_MS) {
  const isConfirmation = typeof value === "string" ? value.length > 0 : value?.kind === "accepted";
  useEffect(() => {
    if (!isConfirmation) return;
    const t = window.setTimeout(clear, ms);
    return () => window.clearTimeout(t);
    // Restart the timer for every new message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, isConfirmation, ms]);
}
