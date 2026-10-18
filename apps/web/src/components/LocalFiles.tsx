import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { LOCAL_AUDIO_EXTENSIONS, MAX_TRACKS_PER_ADD, type SessionState } from "@crowdpulse/shared";
import { hostAddLocalTracks, hostSaveAnalysis } from "../lib/host";
import { analyzeFile } from "../lib/local/analyze";
import { useAutoHide } from "../hooks/useAutoHide";
import {
  canRememberFolder,
  hasLocalFile,
  localFile,
  pickFolder,
  registerFiles,
  relinkSavedFolder,
  savedFolderName,
  useLocalFiles,
} from "../lib/local/files";

// Songs window, "Local files": add audio files from this laptop (a folder or single files). They stay
// on this laptop — the library only gets their details, and this tab plays them. Each new song is
// then measured here (tempo, beats, key) for the AI DJ, one at a time in the background.

type Msg = { kind: "accepted" | "rejected" | "pending"; text: string } | null;
const ACCEPT = ["audio/*", ...LOCAL_AUDIO_EXTENSIONS.map((e) => `.${e}`)].join(",");

export function LocalFiles({
  sessionCode,
  state,
  ready,
  getHeaders,
}: {
  sessionCode: string;
  state: SessionState | null;
  ready: boolean;
  getHeaders: () => Promise<Record<string, string>>;
}) {
  useLocalFiles();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  useAutoHide(msg, () => setMsg(null));
  const [folder, setFolder] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState<{ title: string; left: number } | null>(null);
  const [round, setRound] = useState(0);
  const running = useRef(false);
  const failed = useRef(new Set<string>());
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const local = (state?.tracks ?? []).filter((t) => t.source === "local");
  const unlinked = local.filter((t) => !hasLocalFile(t.id));
  const toAnalyze = local.filter((t) => !t.analysis && hasLocalFile(t.id) && !failed.current.has(t.id));

  useEffect(() => {
    void savedFolderName().then(setFolder);
  }, []);

  // Measure new local songs, one at a time (decoding a song takes a moment and a fair bit of memory).
  useEffect(() => {
    if (!ready || running.current || !toAnalyze.length) {
      if (!toAnalyze.length) setAnalyzing(null);
      return;
    }
    const t = toAnalyze[0];
    const file = localFile(t.id);
    if (!file) return;
    running.current = true;
    setAnalyzing({ title: t.title, left: toAnalyze.length });
    void (async () => {
      try {
        const analysis = await analyzeFile(file);
        await hostSaveAnalysis(sessionCode, await getHeaders(), t.id, analysis);
      } catch (err) {
        failed.current.add(t.id);
        setMsg({ kind: "rejected", text: `Couldn't measure “${t.title}”: ${(err as Error).message}. It still plays, but won't be mixed.` });
      } finally {
        running.current = false;
        setRound((n) => n + 1);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, state, round]);

  async function add(files: File[]) {
    if (!files.length) {
      setMsg({ kind: "rejected", text: "No audio files there (mp3, m4a, wav, flac, ogg…)." });
      return;
    }
    setBusy(true);
    try {
      const inputs = await registerFiles(files, (done, total) => setMsg({ kind: "pending", text: `Reading ${done} of ${total} files…` }));
      let added = 0;
      let skipped = 0;
      for (let i = 0; i < inputs.length; i += MAX_TRACKS_PER_ADD) {
        const r = await hostAddLocalTracks(sessionCode, await getHeaders(), inputs.slice(i, i + MAX_TRACKS_PER_ADD));
        added += r.added;
        skipped += r.skipped;
      }
      setMsg({
        kind: added || skipped ? "accepted" : "rejected",
        text:
          (added ? `Added ${added} local song${added === 1 ? "" : "s"}.` : "No new songs.") +
          (skipped ? ` ${skipped} already in the library (now linked on this device).` : ""),
      });
    } catch (err) {
      setMsg({ kind: "rejected", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    void add(list);
  };

  async function addFolder() {
    if (!canRememberFolder()) {
      folderInput.current?.click();
      return;
    }
    try {
      const picked = await pickFolder();
      setFolder(picked.name);
      await add(picked.files);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setMsg({ kind: "rejected", text: (err as Error).message });
    }
  }

  async function relink() {
    setBusy(true);
    try {
      const n = await relinkSavedFolder();
      setMsg({ kind: n ? "accepted" : "rejected", text: n ? `Linked ${n} files from “${folder}”.` : "No audio files found in that folder." });
    } catch (err) {
      setMsg({ kind: "rejected", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="local-files">
      <div className="library-head">
        <span className="metric-label">Local files · on this laptop</span>
        <span className="cta-row">
          <button type="button" className="btn compact" disabled={!ready || busy} onClick={() => void addFolder()}>
            📁 Add music folder
          </button>
          <button type="button" className="btn ghost compact" disabled={!ready || busy} onClick={() => filesInput.current?.click()}>
            Add files
          </button>
          {folder && unlinked.length > 0 && (
            <button type="button" className="btn primary compact" disabled={!ready || busy} onClick={() => void relink()}>
              ↻ Re-link “{folder}”
            </button>
          )}
        </span>
      </div>
      <input ref={filesInput} type="file" multiple accept={ACCEPT} hidden onChange={onFiles} aria-label="Audio files" />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        onChange={onFiles}
        aria-label="Music folder"
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
      />
      {unlinked.length > 0 && (
        <p className="host-sub local-unlinked">
          {unlinked.length} local song{unlinked.length === 1 ? " isn't" : "s aren't"} linked on this device — add{" "}
          {folder ? "or re-link" : ""} their folder to play {unlinked.length === 1 ? "it" : "them"} here.
        </p>
      )}
      {analyzing && (
        <p className="host-sub" role="status">
          Measuring tempo &amp; key for the AI DJ: “{analyzing.title}”{analyzing.left > 1 ? ` (+${analyzing.left - 1} more)` : ""}…
        </p>
      )}
      <div role="status" aria-live="polite">
        {msg && <p className={`feedback feedback-${msg.kind}`}>{msg.text}</p>}
      </div>
    </div>
  );
}
