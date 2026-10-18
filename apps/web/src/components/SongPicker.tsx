import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// A checklist of songs with "Select all" and "Add selected". Used for Spotify search results,
// playlist imports and Gemini's Find songs results.

export interface PickItem {
  key: string;
  title: string;
  artist: string;
  /** Extra info after the artist, e.g. "3:20" or "≈ 1.2B streams". */
  meta?: string;
  imageUrl?: string | null;
  /** Can't be picked, with the reason shown instead of a checkbox label (e.g. "In library"). */
  unavailable?: string;
}

export function SongPicker({
  items,
  onAdd,
  busy = false,
  selectAllInitially = false,
  addLabel = "Add selected",
  rowAction,
  label,
}: {
  items: PickItem[];
  /** Called with the keys of the selected songs. */
  onAdd: (keys: string[]) => void | Promise<void>;
  busy?: boolean;
  selectAllInitially?: boolean;
  addLabel?: string;
  /** Per-row extra button, e.g. Play now. */
  rowAction?: (item: PickItem) => ReactNode;
  /** Accessible name for the list. */
  label: string;
}) {
  const pickable = useMemo(() => items.filter((i) => !i.unavailable).map((i) => i.key), [items]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(selectAllInitially ? pickable : []));
  // New results: start over (keep only keys that still exist).
  const itemsKey = items.map((i) => i.key).join("|");
  useEffect(() => {
    setSelected(new Set(selectAllInitially ? pickable : []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey]);

  const chosen = pickable.filter((k) => selected.has(k));
  const all = pickable.length > 0 && chosen.length === pickable.length;
  const allBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = chosen.length > 0 && !all;
  }, [chosen.length, all]);

  const toggle = (key: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="song-picker">
      <div className="picker-head">
        <label className="picker-all">
          <input
            ref={allBox}
            type="checkbox"
            checked={all}
            disabled={!pickable.length || busy}
            onChange={() => setSelected(new Set(all ? [] : pickable))}
          />
          Select all ({pickable.length})
        </label>
        <button type="button" className="btn primary compact" disabled={!chosen.length || busy} onClick={() => void onAdd(chosen)}>
          {busy ? "Adding…" : `${addLabel} (${chosen.length})`}
        </button>
      </div>
      <ul className="panel library-results picker-list" aria-label={label}>
        {items.map((item) => (
          <li key={item.key} className={item.unavailable ? "unavailable" : selected.has(item.key) ? "picked" : undefined}>
            <input
              type="checkbox"
              checked={!item.unavailable && selected.has(item.key)}
              disabled={!!item.unavailable || busy}
              onChange={() => toggle(item.key)}
              aria-label={item.unavailable ? `${item.title}: ${item.unavailable}` : `Select ${item.title}`}
            />
            {item.imageUrl ? <img src={item.imageUrl} alt="" width={40} height={40} /> : <span className="library-art" aria-hidden />}
            <span className="library-meta">
              <strong>{item.title}</strong>
              <em>
                {item.artist}
                {item.meta && ` · ${item.meta}`}
                {item.unavailable && ` · ${item.unavailable}`}
              </em>
            </span>
            {rowAction?.(item)}
          </li>
        ))}
      </ul>
    </div>
  );
}
