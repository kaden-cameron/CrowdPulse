import type {
  AiStatus,
  Appearance,
  HostTarget,
  LibraryAddResult,
  LibraryTrackInput,
  PlaybackMode,
  PlaybackReportEvent,
  Recommendation,
  SessionState,
  SongRequest,
  FoundSong,
  Highlight,
  HighlightPart,
  HighlightSettings,
  LocalTrackInput,
  PlaylistSummary,
  StageView,
  VisualState,
} from "@crowdpulse/shared";

// Host API calls. `auth` comes from HostAccess: an Auth0 bearer token, or the local dev key.
type HostHeaders = Record<string, string>;
async function hostPost(path: string, auth: HostHeaders, body: object = {}, method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST") {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as { status: "accepted"; state: SessionState };
}

export const hostSetVisual = (sessionId: string, auth: HostHeaders, visual: VisualState | null) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/visual`, auth, { visual });

/** Reset crowd energy levels and genre picks. Votes, queue and library stay. */
export const hostResetCrowd = (sessionId: string, auth: HostHeaders) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/crowd/reset`, auth);

export const hostReset = (sessionId: string, auth: HostHeaders) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/reset`, auth);

export const hostAdvance = (sessionId: string, auth: HostHeaders, trackId?: string) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/advance`, auth, trackId ? { trackId } : {});

/** Skip / play next: the host queue, then votes, then the least recently played song. */
export const hostSkip = (sessionId: string, auth: HostHeaders) => hostAdvance(sessionId, auth);

/** The host's own queue, in play order (plays before voted songs). */
export const hostSetQueue = (sessionId: string, auth: HostHeaders, trackIds: string[]) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/queue`, auth, { trackIds }, "PUT");

export const hostClearLibrary = (sessionId: string, auth: HostHeaders) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/library`, auth, {}, "DELETE");

export const hostPause = (sessionId: string, auth: HostHeaders) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/playback/pause`, auth);
export const hostResume = (sessionId: string, auth: HostHeaders) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/playback/resume`, auth);
/** ⏮: back to the start of the song, or the song before it. */
export const hostPrevious = (sessionId: string, auth: HostHeaders) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/previous`, auth);

/** 🔁: replay songs when they finish. */
export const hostSetRepeat = (sessionId: string, auth: HostHeaders, repeat: boolean) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/playback/repeat`, auth, { repeat });

/** Where a song's highlight starts (worked out once by the server, then saved). */
export async function fetchHighlight(sessionId: string, auth: HostHeaders, trackId: string, part: HighlightPart): Promise<Highlight> {
  const res = await fetch(`/api/host/sessions/${encodeURIComponent(sessionId)}/highlight/${encodeURIComponent(trackId)}?part=${part}`, { headers: auth });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Highlight lookup failed (${res.status})`);
  return data as Highlight;
}

/** The host nudged a song's highlight start: save it for next time. */
export const hostSaveHighlight = (sessionId: string, auth: HostHeaders, trackId: string, part: HighlightPart, startMs: number, endMs?: number) =>
  fetch(`/api/host/sessions/${encodeURIComponent(sessionId)}/highlight/${encodeURIComponent(trackId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ part, startMs: Math.round(startMs), ...(endMs != null ? { endMs: Math.round(endMs) } : {}) }),
  }).then(async (res) => {
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Couldn't save (${res.status})`);
  });

export const hostSetHighlights = (sessionId: string, auth: HostHeaders, settings: HighlightSettings) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/playback/highlights`, auth, settings);

/** What the projector shows where the queue is: the queue or the vote count, or both in turn (auto). */
export const hostSetStageView = (sessionId: string, auth: HostHeaders, view: StageView) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/stage-view`, auth, view);

export const hostSeek = (sessionId: string, auth: HostHeaders, positionMs: number) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/playback/seek`, auth, { positionMs: Math.round(positionMs) });

/** Lyrics / a description (or a surprise) → songs Gemini names, each looked up on Spotify. */
export async function hostFindSongs(
  sessionId: string,
  auth: HostHeaders,
  query: {
    text?: string;
    surprise?: boolean;
    count?: number;
    genres: string[];
    artists: string[];
    includeFeatures: boolean;
    artistHint?: string;
    minStreams: number | null;
    maxStreams: number | null;
  },
) {
  const res = await fetch(`/api/host/sessions/${encodeURIComponent(sessionId)}/find-songs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify(query),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as { songs: FoundSong[]; note: string | null };
}

// --- Saved playlists ---
const plPath = (sessionId: string, rest = "") => `/api/host/sessions/${encodeURIComponent(sessionId)}/playlists${rest}`;

export const fetchPlaylists = (sessionId: string, auth: HostHeaders) =>
  hostGet<{ playlists: PlaylistSummary[] }>(plPath(sessionId), auth).then((r) => r.playlists);

/** Save the current library: as a new playlist ({name}) or as an existing one's songs ({id}). */
export const hostSavePlaylist = (sessionId: string, auth: HostHeaders, body: { name?: string; id?: string }) =>
  hostPost(plPath(sessionId), auth, body);

export const hostRenamePlaylist = (sessionId: string, auth: HostHeaders, id: string, name: string) =>
  hostPost(plPath(sessionId, `/${encodeURIComponent(id)}`), auth, { name }, "PATCH");

export const hostDeletePlaylist = (sessionId: string, auth: HostHeaders, id: string) =>
  hostPost(plPath(sessionId, `/${encodeURIComponent(id)}`), auth, {}, "DELETE");

export const hostLoadPlaylist = (sessionId: string, auth: HostHeaders, id: string, opts: { replace: boolean; queue: boolean }) =>
  hostPost(plPath(sessionId, `/${encodeURIComponent(id)}/load`), auth, opts);

export type AiSnapshot = { ai: AiStatus; recommendations: Recommendation[] };

async function hostGet<T>(path: string, auth: HostHeaders): Promise<T> {
  const res = await fetch(path, { headers: auth });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

const recPath = (sessionId: string) => `/api/host/sessions/${encodeURIComponent(sessionId)}/recommendations`;

export const fetchRecommendations = (sessionId: string, auth: HostHeaders) =>
  hostGet<AiSnapshot>(recPath(sessionId), auth);

export async function requestRecommendation(sessionId: string, auth: HostHeaders, hostTarget: HostTarget | null, request?: SongRequest) {
  const res = await fetch(recPath(sessionId), {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify(request ? { hostTarget, request } : { hostTarget }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as { ai: AiStatus; recommendation: Recommendation };
}

export async function decideRecommendation(
  sessionId: string,
  auth: HostHeaders,
  id: string,
  decision: "approve" | "reject",
) {
  const res = await fetch(`${recPath(sessionId)}/${encodeURIComponent(id)}/${decision}`, {
    method: "POST",
    headers: auth,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as { recommendation: Recommendation; state?: SessionState };
}

export const hostPlaybackMode = (sessionId: string, auth: HostHeaders, mode: PlaybackMode) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/playback/mode`, auth, { mode });

export interface PlaybackReport {
  event: PlaybackReportEvent;
  trackId: string;
  round: number;
  positionMs?: number;
  durationMs?: number;
  source?: "spotify" | "file";
  message?: string;
  /** This tab's player id (one speaker at a time). */
  playerId?: string;
  /** Highlights mode: the part of the song being played. */
  clipStartMs?: number;
  clipEndMs?: number;
}

/** From the player page. 409 just means the server has moved on to another track. */
export async function reportPlayback(sessionId: string, auth: HostHeaders, report: PlaybackReport) {
  const res = await fetch(`/api/host/sessions/${encodeURIComponent(sessionId)}/playback/report`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify(report),
  });
  if (res.status === 409) return { stale: true as const };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Report failed (${res.status})`);
  return { stale: false as const };
}

/** Local files: add their details (read from tags on this laptop) to the library. */
export async function hostAddLocalTracks(sessionId: string, auth: HostHeaders, tracks: LocalTrackInput[]) {
  const res = await fetch(`/api/host/sessions/${encodeURIComponent(sessionId)}/local-tracks`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ tracks }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Couldn't add songs (${res.status})`);
  return data as LibraryAddResult;
}



export const hostSetAppearance = (sessionId: string, auth: HostHeaders, appearance: Appearance) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/appearance`, auth, appearance);

export async function hostAddToLibrary(sessionId: string, auth: HostHeaders, tracks: LibraryTrackInput[]) {
  const res = await fetch(`/api/host/sessions/${encodeURIComponent(sessionId)}/library`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ tracks }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Couldn't add songs (${res.status})`);
  return data as LibraryAddResult;
}

export async function hostRemoveFromLibrary(sessionId: string, auth: HostHeaders, trackId: string) {
  const res = await fetch(`/api/host/sessions/${encodeURIComponent(sessionId)}/library/${encodeURIComponent(trackId)}`, {
    method: "DELETE",
    headers: auth,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Couldn't remove the song (${res.status})`);
}

/** Rename a local song in the library (title / artist; the file itself is untouched). */
export const hostRenameTrack = (sessionId: string, auth: HostHeaders, trackId: string, title: string, artist: string) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/library/${encodeURIComponent(trackId)}`, auth, { title, artist }, "PATCH");

/** Play a specific song next (e.g. one just found in search). */
export const hostPlayTrack = (sessionId: string, auth: HostHeaders, trackId: string) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/advance`, auth, { trackId });
