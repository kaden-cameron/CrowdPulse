import type {
  AiStatus,
  Appearance,
  HostTarget,
  PlaybackMode,
  PlaybackReportEvent,
  Recommendation,
  SessionState,
  VisualState,
} from "@crowdpulse/shared";

// Host API calls. `auth` comes from HostAccess: an Auth0 bearer token, or the local dev key.
type HostHeaders = Record<string, string>;
async function hostPost(path: string, auth: HostHeaders, body: object = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as { status: "accepted"; state: SessionState };
}

export const hostSetVisual = (sessionId: string, auth: HostHeaders, visual: VisualState | null) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/visual`, auth, { visual });

export const hostReset = (sessionId: string, auth: HostHeaders) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/reset`, auth);

export const hostAdvance = (sessionId: string, auth: HostHeaders) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/advance`, auth);

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

export async function requestRecommendation(sessionId: string, auth: HostHeaders, hostTarget: HostTarget) {
  const res = await fetch(recPath(sessionId), {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ hostTarget }),
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
  source?: "file" | "generated" | "spotify";
  message?: string;
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

export const hostSetAppearance = (sessionId: string, auth: HostHeaders, appearance: Appearance) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/appearance`, auth, appearance);
