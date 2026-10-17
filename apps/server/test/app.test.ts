import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp, type Sessions } from "../src/app.js";
import { SessionStore } from "../src/session.js";

const HOST_KEY = "test-host-key";
let store: SessionStore;
let app: ReturnType<typeof createApp>["app"];
let handleEvent: ReturnType<typeof createApp>["handleEvent"];

const vote = (trackId: string, overrides: Record<string, unknown> = {}) => ({
  sessionId: "demo",
  trackId,
  eventId: randomUUID(),
  participantId: "participant_aaaa",
  ...overrides,
});

const votesFor = (trackId: string) =>
  store.getState().tracks.find((t) => t.id === trackId)?.votes;

beforeEach(() => {
  store = new SessionStore("demo", "Demo");
  const sessions: Sessions = new Map([["demo", store]]);
  ({ app, handleEvent } = createApp({ sessions, hostKey: HOST_KEY }));
});

describe("votes", () => {
  it("FE-02: accepts a valid vote and puts the track in the queue", async () => {
    const res = await request(app).post("/api/sessions/demo/votes").send(vote("track_07"));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("accepted");
    expect(res.body.state.queue[0]).toMatchObject({ trackId: "track_07", votes: 1 });
  });

  it("FE-05/BE-02: rejects an unknown track without changing state", async () => {
    const before = store.getState();
    const res = await request(app).post("/api/sessions/demo/votes").send(vote("nope"));
    expect(res.status).toBe(400);
    expect(store.getState().tracks).toEqual(before.tracks);
    expect(store.getState().version).toBe(before.version);
  });

  it("rejects a vote missing participantId or with a non-UUID eventId", async () => {
    const { participantId: _omit, ...noParticipant } = vote("track_01");
    expect((await request(app).post("/api/sessions/demo/votes").send(noParticipant)).status).toBe(400);
    expect(
      (await request(app).post("/api/sessions/demo/votes").send(vote("track_01", { eventId: "evt_123" }))).status,
    ).toBe(400);
  });

  it("BE-01: a vote missing sessionId gets 400 and is not counted", async () => {
    const { sessionId: _omit, ...body } = vote("track_01");
    const res = await request(app).post("/api/sessions/demo/votes").send(body);
    expect(res.status).toBe(400);
    expect(store.getState().tracks.every((t) => t.votes === 0)).toBe(true);
  });

  it("rejects unknown fields", async () => {
    const res = await request(app).post("/api/sessions/demo/votes").send(vote("track_01", { css: "body{}" }));
    expect(res.status).toBe(400);
  });

  it("BE-03: counts a retried event ID only once (no duplicate votes on reconnect, FE-04)", async () => {
    const body = vote("track_03");
    await request(app).post("/api/sessions/demo/votes").send(body);
    const retry = await request(app).post("/api/sessions/demo/votes").send(body);
    expect(retry.body.status).toBe("duplicate");
    expect(votesFor("track_03")).toBe(1);
  });

  it("allows one vote per participant per track", async () => {
    await request(app).post("/api/sessions/demo/votes").send(vote("track_03"));
    const again = await request(app).post("/api/sessions/demo/votes").send(vote("track_03"));
    expect(again.status).toBe(409);
    expect(votesFor("track_03")).toBe(1);
  });

  it("BE-04: rate limits bursts from one participant", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++) {
      const res = await request(app)
        .post("/api/sessions/demo/taps")
        .send({ sessionId: "demo", count: 1, eventId: randomUUID(), participantId: "participant_bbbb" });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });

  it("returns 404 for an unknown session instead of creating one", async () => {
    const res = await request(app).post("/api/sessions/nope/votes").send(vote("track_01", { sessionId: "nope" }));
    expect(res.status).toBe(404);
    expect((await request(app).get("/api/sessions/nope/state")).status).toBe(404);
  });
});

describe("websocket event path", () => {
  it("uses the same validation as HTTP", async () => {
    expect((await handleEvent({ type: "vote.submit", ...vote("nope") }, "1.2.3.4", "ws")).result.status).toBe("rejected");
    const ok = await handleEvent({ type: "vote.submit", ...vote("track_02") }, "1.2.3.4", "ws");
    expect(ok.result.status).toBe("accepted");
    expect((await handleEvent({ type: "vote.submit", ...vote("track_02"), extra: 1 }, "1.2.3.4", "ws")).httpStatus).toBe(400);
  });
});

describe("moods and taps", () => {
  it("counts each participant's latest mood once", async () => {
    const base = { type: "session.join", sessionId: "demo", participantId: "participant_cccc" };
    await handleEvent({ ...base, eventId: randomUUID(), mood: "chill" }, "ip", "ws");
    await handleEvent({ ...base, eventId: randomUUID(), mood: "wild" }, "ip", "ws");
    expect(store.getState().moods).toEqual({ chill: 0, hyped: 0, focused: 0, wild: 1 });
  });

  it("completes a quest and starts the next one", async () => {
    for (let i = 0; i < 4; i++) {
      await handleEvent(
        { type: "tap.batch", sessionId: "demo", participantId: "participant_dddd", eventId: randomUUID(), count: 25 },
        "ip",
        "ws",
      );
    }
    const state = store.getState();
    expect(state.latestEvent?.type).toBe("quest.complete");
    expect(state.crowdQuest).toMatchObject({ progress: 0, goal: 200 });
  });
});

describe("host actions", () => {
  const visual = (body: unknown, key?: string) => {
    const req = request(app).post("/api/host/sessions/demo/visual");
    return (key ? req.set("x-host-key", key) : req).send(body as object);
  };

  it("rejects requests without the host key", async () => {
    const res = await visual({ visual: { theme: "sunset", intensity: 0.5 } });
    expect(res.status).toBe(401);
    expect(store.getState().visualMode).toBe("auto");
  });

  it("FE-08: applies a validated visual state, then returns to auto", async () => {
    const res = await visual({ visual: { theme: "neon_pulse", intensity: 0.8 } }, HOST_KEY);
    expect(res.status).toBe(200);
    expect(store.getState()).toMatchObject({ visualMode: "host", visualState: { theme: "neon_pulse", intensity: 0.8 } });
    await visual({ visual: null }, HOST_KEY);
    expect(store.getState().visualMode).toBe("auto");
  });

  it("rejects themes outside the allowlist", async () => {
    const res = await visual({ visual: { theme: "url(javascript:alert(1))", intensity: 0.5 } }, HOST_KEY);
    expect(res.status).toBe(400);
  });

  it("clamps intensity into 0–1", async () => {
    await visual({ visual: { theme: "sunset", intensity: 4 } }, HOST_KEY);
    expect(store.getState().visualState.intensity).toBe(1);
  });

  it("advances the top-voted track to now playing", async () => {
    await request(app).post("/api/sessions/demo/votes").send(vote("track_05"));
    const res = await request(app).post("/api/host/sessions/demo/advance").set("x-host-key", HOST_KEY);
    expect(res.status).toBe(200);
    const state = store.getState();
    expect(state.nowPlaying?.trackId).toBe("track_05");
    expect(state.tracks.find((t) => t.id === "track_05")?.status).toBe("playing");
    expect(state.queue).toHaveLength(0);
  });
});
