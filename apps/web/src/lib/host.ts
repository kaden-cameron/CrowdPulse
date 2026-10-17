import type { SessionState, VisualState } from "@crowdpulse/shared";

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
