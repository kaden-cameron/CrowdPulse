import type { Appearance, AppearanceMode, AppearancePreset } from "@crowdpulse/shared";
import { THEME_PRESETS } from "../lib/theme";

// Host-page window: the session's look. The stage and every attendee phone follow it live.

const MODES: { id: AppearanceMode; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

export function AppearanceCard({
  appearance,
  disabled,
  onChange,
}: {
  appearance: Appearance | undefined;
  disabled: boolean;
  onChange: (next: Appearance) => void;
}) {
  const current = appearance ?? { preset: "sky" as AppearancePreset, mode: "light" as AppearanceMode };
  return (
    <div className="host-block appearance-card">
      <h2>Appearance</h2>
      <p className="host-sub">The big screen and every attendee&apos;s phone use this look.</p>
      <fieldset className="theme-field" disabled={disabled}>
        <legend>Color</legend>
        <div className="theme-swatches">
          {THEME_PRESETS.map((p) => (
            <label key={p.id} className={`theme-swatch${current.preset === p.id ? " selected" : ""}`}>
              <input
                type="radio"
                name="appearance-preset"
                value={p.id}
                checked={current.preset === p.id}
                onChange={() => onChange({ ...current, preset: p.id })}
              />
              <span className="swatch-chip" aria-hidden>
                <span style={{ background: p.light }} />
                <span style={{ background: p.dark }} />
              </span>
              {p.label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="theme-field" disabled={disabled}>
        <legend>Mode</legend>
        <div className="theme-modes two">
          {MODES.map((m) => (
            <label key={m.id} className={`theme-mode${current.mode === m.id ? " selected" : ""}`}>
              <input
                type="radio"
                name="appearance-mode"
                value={m.id}
                checked={current.mode === m.id}
                onChange={() => onChange({ ...current, mode: m.id })}
              />
              {m.label}
            </label>
          ))}
        </div>
      </fieldset>
      {disabled && <p className="host-sub">Sign in as host (above) to change it.</p>}
    </div>
  );
}
