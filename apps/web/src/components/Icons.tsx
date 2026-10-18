// Small line icons that take the text color (black on the light themes), so they match the
// ⏮ ⏸ ⏭ glyphs and the menu bar instead of rendering as color emoji.

export function RepeatIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" aria-hidden>
      <path d="M2.5 7V5.5h9.5" />
      <path d="M10 3l2.5 2.5L10 8" />
      <path d="M13.5 9v1.5H4" />
      <path d="M6 13l-2.5-2.5L6 8" />
    </svg>
  );
}

export function ProfileIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <circle cx="8" cy="5.5" r="2.8" />
      <path d="M2.8 14c.6-3 2.6-4.6 5.2-4.6s4.6 1.6 5.2 4.6" strokeLinecap="square" />
    </svg>
  );
}
