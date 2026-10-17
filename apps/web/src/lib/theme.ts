import { useEffect } from "react";
import { DEFAULT_APPEARANCE, type Appearance, type AppearancePreset } from "@crowdpulse/shared";

// Session appearance. The host picks it on the host page; the server broadcasts it, and every
// screen in the session (stage, attendee phones, player, host) applies it. Within a mode every
// preset has the same perceived lightness (OKLCH L 0.90 light / 0.26 dark). Palette: styles.css.

export const THEME_PRESETS: { id: AppearancePreset; label: string; light: string; dark: string }[] = [
  { id: "sky", label: "Blue", light: "#cce1f6", dark: "#122539" },
  { id: "flamingo", label: "Pink", light: "#f6d5d5", dark: "#371a1c" },
  { id: "mint", label: "Green", light: "#c9e7d8", dark: "#0a2b1e" },
  { id: "lemon", label: "Yellow", light: "#e9e0ab", dark: "#2a2403" },
  { id: "lavender", label: "Purple", light: "#e2d9f4", dark: "#271f37" },
];

/** Plain color name for a preset id ("flamingo" → "Pink"). Ids stay as-is for saved sessions. */
export const presetLabel = (id: AppearancePreset) => THEME_PRESETS.find((p) => p.id === id)?.label ?? id;

const cacheKey = (sessionId: string) => `crowdpulse.appearance.${sessionId}`;

/** Sets data-preset / data-mode on <html> (the CSS keys off these) and the browser bar color. */
export function applyAppearance(a: Appearance) {
  const root = document.documentElement;
  root.dataset.preset = a.preset;
  root.dataset.mode = a.mode;
  const preset = THEME_PRESETS.find((p) => p.id === a.preset) ?? THEME_PRESETS[0];
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", a.mode === "dark" ? preset.dark : preset.light);
}

function cached(sessionId: string): Appearance | null {
  try {
    const v = JSON.parse(localStorage.getItem(cacheKey(sessionId)) ?? "null") as Appearance | null;
    return v && THEME_PRESETS.some((p) => p.id === v.preset) && (v.mode === "light" || v.mode === "dark") ? v : null;
  } catch {
    return null;
  }
}

/**
 * Before the first render: use the last look this device saw for the session in the URL, so a
 * reload doesn't flash the default colors while the live state loads.
 */
export function initTheme() {
  const m = window.location.pathname.match(/^\/(?:join|stage|host|player)\/([^/]+)/);
  applyAppearance((m && cached(decodeURIComponent(m[1]))) || DEFAULT_APPEARANCE);
}

/** Follow the session's appearance from live state (and remember it for next time). */
export function useSessionAppearance(sessionId: string, appearance: Appearance | undefined) {
  const preset = appearance?.preset;
  const mode = appearance?.mode;
  useEffect(() => {
    if (!preset || !mode) return;
    applyAppearance({ preset, mode });
    try {
      localStorage.setItem(cacheKey(sessionId), JSON.stringify({ preset, mode }));
    } catch {
      /* storage blocked — still applied */
    }
  }, [sessionId, preset, mode]);
}

/** Pages outside a session (the landing page) use the default look. */
export function useDefaultAppearance() {
  useEffect(() => applyAppearance(DEFAULT_APPEARANCE), []);
}
