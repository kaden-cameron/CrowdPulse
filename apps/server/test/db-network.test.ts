import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Database } from "../src/db.js";

// A dropped network mid-write must fail that one write, not crash the server.
describe("Database survives a dropped connection", () => {
  it("handles an error emitted by a checked-out client and discards that connection", async () => {
    const db = new Database("postgres://127.0.0.1:1/none");
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN") {
          // pg emits "error" on the client when the socket dies (EADDRNOTAVAIL), then the query fails.
          client.emit("error", Object.assign(new Error("read EADDRNOTAVAIL"), { code: "EADDRNOTAVAIL" }));
          throw new Error("Connection terminated unexpectedly");
        }
        return { rowCount: 1 };
      }),
      release: vi.fn(),
    });
    (db as unknown as { pool: { connect: () => Promise<unknown> } }).pool.connect = async () => client;

    await expect(
      db.persist({ eventId: "e1", sessionId: "s", participantId: null, eventType: "vote", value: null, metadata: {} }),
    ).rejects.toThrow("Connection terminated");
    expect(client.release).toHaveBeenCalledWith(expect.objectContaining({ message: "read EADDRNOTAVAIL" }));
    expect(client.listenerCount("error")).toBe(0);
    expect(db.isHealthy).toBe(false);
    await db.close();
  });
});
