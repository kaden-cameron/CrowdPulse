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

/** Fake WebSocket: close() goes to CLOSING, and onclose fires later (like a real one). */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSocket.all.push(this);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  send() {}
  close() {
    if (this.readyState >= FakeSocket.CLOSING) return;
    this.readyState = FakeSocket.CLOSING;
    setTimeout(() => {
      this.readyState = FakeSocket.CLOSED;
      this.onclose?.();
    }, 50);
  }
}

describe("SessionSocket", () => {
  it("doesn't leak a second connection after a quick offline/online flip", async () => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    const { SessionSocket } = await import("./ws");
    const statuses: string[] = [];
    const s = new SessionSocket("demo", "host", { onState: () => {}, onStatus: (st) => statuses.push(st) });
    s.connect();
    FakeSocket.all[0].open();
    s.dropForOffline(); // socket #1 is CLOSING
    s.reconnectNow(); // socket #2
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].open();
    await vi.advanceTimersByTimeAsync(20_000); // socket #1's late close must not reconnect again
    expect(FakeSocket.all).toHaveLength(2);
    expect(statuses.at(-1)).toBe("connected");
    s.close();
    vi.useRealTimers();
  });
});
