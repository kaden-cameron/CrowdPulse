import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("getParticipantId", () => {
  it("stays the same for the whole page even when storage is blocked", async () => {
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    };
    vi.stubGlobal("localStorage", blocked);
    const { getParticipantId } = await import("./ws");
    const a = getParticipantId();
    expect(a).toMatch(/^p_[0-9a-f]{32}$/);
    expect(getParticipantId()).toBe(a);
    expect(getParticipantId()).toBe(a);
  });
});
