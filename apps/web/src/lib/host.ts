import type {
  AiStatus,
  HostTarget,
  Recommendation,
  SessionState,
  VisualState,
} from "@crowdpulse/shared";

// Temporary host gate until Auth0 (Doc 06). The key is typed by the host and kept
// in sessionStorage only; it is never part of the bundle.
async function hostPost(path: string, hostKey: string, body: object = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-host-key": hostKey },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as { status: "accepted"; state: SessionState };
}

export const hostSetVisual = (sessionId: string, hostKey: string, visual: VisualState | null) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/visual`, hostKey, { visual });

export const hostAdvance = (sessionId: string, hostKey: string) =>
  hostPost(`/api/host/sessions/${encodeURIComponent(sessionId)}/advance`, hostKey);

export type AiSnapshot = { ai: AiStatus; recommendations: Recommendation[] };

async function hostGet<T>(path: string, hostKey: string): Promise<T> {
  const res = await fetch(path, { headers: { "x-host-key": hostKey } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

const recPath = (sessionId: string) => `/api/host/sessions/${encodeURIComponent(sessionId)}/recommendations`;

export const fetchRecommendations = (sessionId: string, hostKey: string) =>
  hostGet<AiSnapshot>(recPath(sessionId), hostKey);

export async function requestRecommendation(sessionId: string, hostKey: string, hostTarget: HostTarget) {
  const res = await fetch(recPath(sessionId), {
    method: "POST",
    headers: { "content-type": "application/json", "x-host-key": hostKey },
    body: JSON.stringify({ hostTarget }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as { ai: AiStatus; recommendation: Recommendation };
}

export async function decideRecommendation(
  sessionId: string,
  hostKey: string,
  id: string,
  decision: "approve" | "reject",
) {
  const res = await fetch(`${recPath(sessionId)}/${encodeURIComponent(id)}/${decision}`, {
    method: "POST",
    headers: { "x-host-key": hostKey },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as { recommendation: Recommendation; state?: SessionState };
}
