import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMetrics } from "./useMetrics";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useMetrics", () => {
  it("uses the latest getHeaders on each poll", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const first = async () => ({ "x-host-key": "a" });
    const second = async () => ({ "x-host-key": "abc" });
    const { rerender } = renderHook(({ h }) => useMetrics("demo", true, h), { initialProps: { h: first } });
    await act(async () => {});
    expect(fetchMock).toHaveBeenLastCalledWith(expect.any(String), { headers: { "x-host-key": "a" } });
    rerender({ h: second });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetchMock).toHaveBeenLastCalledWith(expect.any(String), { headers: { "x-host-key": "abc" } });
  });
});
