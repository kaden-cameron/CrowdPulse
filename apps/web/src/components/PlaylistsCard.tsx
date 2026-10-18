import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PLAYLIST_NAME_MAX, type PlaylistSummary, type SessionState } from "@crowdpulse/shared";
import { fetchPlaylists, hostDeletePlaylist, hostLoadPlaylist, hostRenamePlaylist, hostSavePlaylist } from "../lib/host";
import { useAutoHide } from "../hooks/useAutoHide";

// Host-page window: save the library as a named playlist, and load saved playlists back —
// replacing the library or adding to it, optionally straight into the queue. Playlists keep each
// song's details, so loading one doesn't need Spotify or Gemini again.

type Msg = { kind: "accepted" | "rejected"; text: string } | null;

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
  " " +
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export function PlaylistsCard({
  sessionCode,
  state,
  ready,
  getHeaders,
  onState,
}: {
  sessionCode: string;
  state: SessionState | null;
  ready: boolean;
  getHeaders: () => Promise<Record<string, string>>;
  onState: (s: SessionState) => void;
}) {
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [name, setName] = useState("");
  const [queueToo, setQueueToo] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  useAutoHide(msg, () => setMsg(null));
  const librarySize = state?.tracks.length ?? 0;

  const refresh = useCallback(async () => {
    if (!ready) return;
    try {
      setPlaylists(await fetchPlaylists(sessionCode, await getHeaders()));
    } catch (err) {
      setMsg({ kind: "rejected", text: (err as Error).message });
    }
  }, [ready, sessionCode, getHeaders]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(label: string, fn: () => Promise<{ state: SessionState }>, done: string) {
    setBusy(label);
    setMsg(null);
    try {
      onState((await fn()).state);
      setMsg({ kind: "accepted", text: done });
      await refresh();
    } catch (err) {
      setMsg({ kind: "rejected", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    void act("save", async () => hostSavePlaylist(sessionCode, await getHeaders(), { name: n }), `Saved “${n}” (${librarySize} songs).`).then(() =>
      setName(""),
    );
  };

  const load = (p: PlaylistSummary, replace: boolean) => {
    if (replace && librarySize && !window.confirm(`Replace the library (${librarySize} songs) with “${p.name}”? The song playing now finishes first.`)) {
      return;
    }
    void act(
      `load:${p.id}`,
      async () => hostLoadPlaylist(sessionCode, await getHeaders(), p.id, { replace, queue: queueToo }),
      `${replace ? "Loaded" : "Added"} “${p.name}”${queueToo ? " into the queue" : ""}.`,
    );
  };

  const update = (p: PlaylistSummary) => {
    if (!window.confirm(`Replace the songs in “${p.name}” with the current library (${librarySize} songs)?`)) return;
    void act(`update:${p.id}`, async () => hostSavePlaylist(sessionCode, await getHeaders(), { id: p.id }), `Updated “${p.name}”.`);
  };

  const remove = (p: PlaylistSummary) => {
    if (!window.confirm(`Delete the playlist “${p.name}”? (The songs stay in the library.)`)) return;
    void act(`delete:${p.id}`, async () => hostDeletePlaylist(sessionCode, await getHeaders(), p.id), `Deleted “${p.name}”.`);
  };

  const rename = (e: FormEvent) => {
    e.preventDefault();
    const r = renaming;
    if (!r || !r.name.trim()) return;
    void act(`rename:${r.id}`, async () => hostRenamePlaylist(sessionCode, await getHeaders(), r.id, r.name.trim()), `Renamed to “${r.name.trim()}”.`).then(() =>
      setRenaming(null),
    );
  };

  return (
    <div className="host-block playlists-card">
      <h2>Playlists</h2>

      <form className="library-form" onSubmit={save}>
        <label className="host-field">
          <span className="metric-label">Save the library ({librarySize} songs) as a playlist</span>
          <span className="library-row">
            <input
              type="text"
              value={name}
              maxLength={PLAYLIST_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name it, e.g. Friday warm-up"
              disabled={!ready}
            />
            <button type="submit" className="btn" disabled={!ready || busy !== null || !name.trim() || !librarySize}>
              {busy === "save" ? "Saving…" : "Save"}
            </button>
          </span>
        </label>
      </form>

      <label className="energy-toggle">
        <input type="checkbox" checked={queueToo} onChange={(e) => setQueueToo(e.target.checked)} />
        Also put loaded songs in the queue, in order
      </label>

      <ul className="panel playlist-list" aria-label="Saved playlists">
        {!playlists.length && <li className="host-sub">No playlists yet — build a library, then save it here.</li>}
        {playlists.map((p) => (
          <li key={p.id}>
            {renaming?.id === p.id ? (
              <form className="playlist-rename" onSubmit={rename}>
                <input
                  type="text"
                  value={renaming.name}
                  maxLength={PLAYLIST_NAME_MAX}
                  onChange={(e) => setRenaming({ id: p.id, name: e.target.value })}
                  aria-label={`New name for ${p.name}`}
                  autoFocus
                />
                <button type="submit" className="btn compact" disabled={busy !== null || !renaming.name.trim()} aria-label="Save new name">
                  Save
                </button>
                <button type="button" className="btn ghost compact" onClick={() => setRenaming(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <span className="library-meta">
                  <strong>{p.name}</strong>
                  <em>
                    {p.count} song{p.count === 1 ? "" : "s"} · {fmtDate(p.updatedAt)}
                  </em>
                </span>
                <span className="playlist-actions">
                  <button
                    type="button"
                    className="btn primary compact"
                    disabled={!ready || busy !== null}
                    onClick={() => load(p, true)}
                    aria-label={`Load ${p.name} (replace the library)`}
                    title="Replace the library with this playlist"
                  >
                    {busy === `load:${p.id}` ? "…" : "Load"}
                  </button>
                  <button
                    type="button"
                    className="btn compact"
                    disabled={!ready || busy !== null}
                    onClick={() => load(p, false)}
                    aria-label={`Add ${p.name} to the library`}
                    title="Add this playlist's songs to the library"
                  >
                    Add
                  </button>
                  <details className="playlist-more">
                    <summary aria-label={`More for ${p.name}`}>⋯</summary>
                    <div className="playlist-menu">
                      <button type="button" className="btn ghost compact" disabled={busy !== null} onClick={() => setRenaming({ id: p.id, name: p.name })}>
                        Rename
                      </button>
                      <button
                        type="button"
                        className="btn ghost compact"
                        disabled={busy !== null || !librarySize}
                        onClick={() => update(p)}
                        title="Replace its songs with the current library"
                      >
                        Update with library
                      </button>
                      <button type="button" className="btn ghost compact" disabled={busy !== null} onClick={() => remove(p)}>
                        Delete
                      </button>
                    </div>
                  </details>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>

      <div role="status" aria-live="polite">
        {msg && <p className={`feedback feedback-${msg.kind}`}>{msg.text}</p>}
      </div>
    </div>
  );
}
