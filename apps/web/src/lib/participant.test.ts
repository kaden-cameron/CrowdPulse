import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Attendee ids come from the server (signed). Fresh module per test: the id is cached in memory.
const SIGNED = "ps_0123456789abcdef01234567_0123456789abcdef";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

describe("attendee id", () => {
  it("asks the server once, keeps the signed id, and replaces it when the server refuses it", async () => {
    const fetchMock = vi.fn(async () => Response.json({ participantId: SIGNED }));
    vi.stubGlobal("fetch", fetchMock);
    const ws = await import("./ws");
    expect(await ws.ensureParticipantId()).toBe(SIGNED);
    expect(await ws.ensureParticipantId()).toBe(SIGNED);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("crowdpulse.participant")).toBe(SIGNED);
    // Refused (e.g. made before ids were signed): a new one is fetched.
    await ws.resetParticipantId();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an old made-up id is swapped for a signed one; an older server without ids keeps it", async () => {
    localStorage.setItem("crowdpulse.participant", "p_oldmadeupid123");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const ws = await import("./ws");
    expect(await ws.ensureParticipantId()).toBe("p_oldmadeupid123");
  });
});
