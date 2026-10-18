import { useSyncExternalStore } from "react";
import { GENRE_PATTERN, LOCAL_AUDIO_EXTENSIONS, type LocalTrackInput } from "@crowdpulse/shared";

// Local files: audio on the host's laptop. The files stay in this browser tab (never uploaded); the
// library only gets each song's details. A song's id comes from its file name and size, so the same
// file gets the same id again after a reload — the host just re-links the folder.
// In Chrome / Edge the folder is remembered (re-linking is one click); other browsers pick it again.

const files = new Map<string, File>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

/** The file for a local song, if it's linked on this device. */
export const localFile = (id: string): File | undefined => files.get(id);
export const hasLocalFile = (id: string) => files.has(id);
export const linkedCount = () => files.size;

/** Re-render when files are linked (returns a counter that changes). */
export function useLocalFiles(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version,
  );
}

export function isAudioFile(f: { name: string }): boolean {
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  return (LOCAL_AUDIO_EXTENSIONS as readonly string[]).includes(ext) && !f.name.startsWith("._");
}

/** "lf_" + 16 hex: FNV-1a (64-bit) of the file's name and size. */
export function localIdFor(f: { name: string; size: number }): string {
  let h = 0xcbf29ce484222325n;
  for (const ch of new TextEncoder().encode(`${f.name}|${f.size}`)) {
    h ^= BigInt(ch);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `lf_${h.toString(16).padStart(16, "0")}`;
}

/** "03 - Daft Punk - One More Time.mp3" → { artist: "Daft Punk", title: "One More Time" }. */
export function guessFromName(name: string): { title: string; artist: string } {
  const base = name.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
  const parts = base
    .split(/\s+[-–—]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  // A leading track number ("03", "03.") is not the artist.
  if (parts.length > 1 && /^\d{1,3}\.?$/.test(parts[0])) parts.shift();
  if (parts.length >= 2) return { artist: parts[0].slice(0, 120), title: parts.slice(1).join(" - ").slice(0, 120) };
  const t = (parts[0] ?? base).replace(/^\d{1,3}[.\s-]+/, "").trim() || base;
  return { title: t.slice(0, 120), artist: "Unknown artist" };
}

/** Title / artist / genre / BPM from the file's tags, else from its name. Never throws. */
export async function readTags(file: File): Promise<Omit<LocalTrackInput, "id">> {
  const fallback = guessFromName(file.name);
  try {
    const { parseBlob } = await import("music-metadata");
    const { common } = await parseBlob(file, { duration: false, skipCovers: true });
    const genre = common.genre?.[0]?.trim().toLowerCase().slice(0, 30);
    const bpm = typeof common.bpm === "number" && common.bpm >= 40 && common.bpm <= 250 ? common.bpm : undefined;
    return {
      title: (common.title?.trim() || fallback.title).slice(0, 120),
      artist: (common.artist?.trim() || common.albumartist?.trim() || fallback.artist).slice(0, 120),
      ...(genre && GENRE_PATTERN.test(genre) ? { genre } : {}),
      ...(bpm ? { bpm } : {}),
    };
  } catch {
    return fallback;
  }
}

/** Link files on this device (no tag reading): returns the ids of audio files linked. */
export function linkFiles(list: Iterable<File>): string[] {
  const ids: string[] = [];
  for (const f of list) {
    if (!isAudioFile(f)) continue;
    const id = localIdFor(f);
    files.set(id, f);
    ids.push(id);
  }
  if (ids.length) changed();
  return ids;
}

/** Link files and read their details, a few at a time. */
export async function registerFiles(list: Iterable<File>, onProgress?: (done: number, total: number) => void): Promise<LocalTrackInput[]> {
  const audio = [...list].filter(isAudioFile);
  linkFiles(audio);
  const out: LocalTrackInput[] = new Array(audio.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < audio.length) {
      const i = next++;
      out[i] = { id: localIdFor(audio[i]), ...(await readTags(audio[i])) };
      onProgress?.(++done, audio.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

// --- Remembering the folder (Chrome / Edge: File System Access API) ---

interface DirHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterable<DirHandle | { kind: "file"; name: string; getFile(): Promise<File> }>;
  queryPermission?(o: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(o: { mode: "read" }): Promise<PermissionState>;
}
type PickerWindow = Window & { showDirectoryPicker?: (o?: { mode?: "read"; id?: string }) => Promise<DirHandle> };

export const canRememberFolder = () => typeof window !== "undefined" && typeof (window as PickerWindow).showDirectoryPicker === "function";

async function walk(dir: DirHandle, out: File[], depth = 0): Promise<void> {
  if (depth > 6) return;
  for await (const entry of dir.values()) {
    if (entry.kind === "file") {
      if (isAudioFile(entry)) out.push(await entry.getFile());
    } else await walk(entry, out, depth + 1);
  }
}

const DB = "crowdpulse-local";
const STORE = "folders";
function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = fn(open.result.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

/** Pick a music folder (and remember it). Must run in a click handler. Returns its audio files. */
export async function pickFolder(): Promise<{ name: string; files: File[] }> {
  const dir = await (window as PickerWindow).showDirectoryPicker!({ mode: "read", id: "crowdpulse-music" });
  const out: File[] = [];
  await walk(dir, out);
  await idb("readwrite", (s) => s.put(dir, "music")).catch(() => undefined);
  return { name: dir.name, files: out };
}

/** The remembered folder's name, if any. */
export async function savedFolderName(): Promise<string | null> {
  if (!canRememberFolder()) return null;
  const dir = (await idb<DirHandle | undefined>("readonly", (s) => s.get("music")).catch(() => undefined)) ?? null;
  return dir?.name ?? null;
}

/** Re-link the remembered folder (asks the browser for permission: run in a click handler). */
export async function relinkSavedFolder(): Promise<number> {
  const dir = await idb<DirHandle | undefined>("readonly", (s) => s.get("music")).catch(() => undefined);
  if (!dir) return 0;
  const perm = (await dir.queryPermission?.({ mode: "read" })) ?? "granted";
  if (perm !== "granted" && (await dir.requestPermission?.({ mode: "read" })) !== "granted") throw new Error("Permission to read the folder was denied");
  const out: File[] = [];
  await walk(dir, out);
  return linkFiles(out).length;
}
