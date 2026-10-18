import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForVerification } from "./solana";

afterEach(() => vi.unstubAllGlobals());

describe("waitForVerification", () => {
  it.each([
    ["right after an update", (ctrl: AbortController) => ctrl.abort()],
    ["while waiting to poll again", (ctrl: AbortController) => void setTimeout(() => ctrl.abort(), 10)],
  ])("stops polling when aborted %s and doesn't report again", async (_when, abort) => {
    const fetchMock = vi.fn(async () => Response.json({ status: "pending", signature: "sig", explorerUrl: "x" }, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctrl = new AbortController();
    const onUpdate = vi.fn(() => abort(ctrl));
    await expect(waitForVerification("demo", "intent", "sig", onUpdate, { intervalMs: 60_000, signal: ctrl.signal })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});
