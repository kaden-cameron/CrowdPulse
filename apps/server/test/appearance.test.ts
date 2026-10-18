import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type Sessions } from "../src/app.js";
import type { EventRecord } from "../src/db.js";
import { SessionStore } from "../src/session.js";

describe("session appearance (set on the host page, followed by stage + phones)", () => {
  const setup = () => {
    const store = new SessionStore("demo", "Demo");
    const sessions: Sessions = new Map([["demo", store]]);
    const { app } = createApp({ sessions, hostKey: "k" });
    const set = (body: object, key?: string) => {
      const r = request(app).post("/api/host/sessions/demo/appearance");
      return (key ? r.set("x-host-key", key) : r).send(body);
    };
    return { store, set };
  };

  it("defaults to sky / light and is part of the broadcast state", () => {
    expect(setup().store.getState().appearance).toEqual({ preset: "sky", mode: "light", showEnergy: true });
  });

  it("the host can change it; it shows up in state for every client", async () => {
    const { store, set } = setup();
    let broadcasts = 0;
    store.onChange(() => broadcasts++);
    expect((await set({ preset: "mint", mode: "dark" }, "k")).status).toBe(200);
    expect(store.getState().appearance).toEqual({ preset: "mint", mode: "dark", showEnergy: true });
    expect(broadcasts).toBe(1);
  });

  it("is host-only and validated", async () => {
    const { store, set } = setup();
    expect((await set({ preset: "mint", mode: "dark" })).status).toBe(401);
    expect((await set({ preset: "neon", mode: "dark" }, "k")).status).toBe(400);
    expect((await set({ preset: "mint", mode: "auto" }, "k")).status).toBe(400);
    expect(store.getState().appearance).toEqual({ preset: "sky", mode: "light", showEnergy: true });
  });

  it("survives a restart and a new run", async () => {
    const saved: Required<EventRecord>[] = [];
    let t = Date.now();
    const store = new SessionStore("demo", "Demo", {
      persist: async (r) => (saved.push({ ...r, time: new Date((t += 10)) } as Required<EventRecord>), "stored"),
    });
    await store.setAppearance({ preset: "lavender", mode: "dark" });
    await store.reset();
    expect(store.getState().appearance).toEqual({ preset: "lavender", mode: "dark", showEnergy: true });
    const restored = new SessionStore("demo", "Demo");
    restored.replay(saved);
    expect(restored.getState().appearance).toEqual({ preset: "lavender", mode: "dark", showEnergy: true });
  });
});

describe("projector view (queue / vote count / auto)", () => {
  it("is host-only, validated, broadcast and saved", async () => {
    const saved: Required<EventRecord>[] = [];
    let n = Date.now();
    const store = new SessionStore("demo", "Demo", {
      persist: async (r) => (saved.push({ ...r, time: new Date((n += 10)) } as Required<EventRecord>), "stored"),
    });
    const { app } = createApp({ sessions: new Map([["demo", store]]), hostKey: "k" });
    expect(store.getState().stageView).toEqual({ panel: "queue", auto: false });
    expect((await request(app).post("/api/host/sessions/demo/stage-view").send({ panel: "votes", auto: false })).status).toBe(401);
    expect((await request(app).post("/api/host/sessions/demo/stage-view").set("x-host-key", "k").send({ panel: "chart", auto: false })).status).toBe(400);
    expect((await request(app).post("/api/host/sessions/demo/stage-view").set("x-host-key", "k").send({ panel: "votes", auto: true })).status).toBe(200);
    expect(store.getState().stageView).toEqual({ panel: "votes", auto: true });
    const restored = new SessionStore("demo", "Demo");
    restored.replay(saved);
    expect(restored.getState().stageView).toEqual({ panel: "votes", auto: true });
  });
});
