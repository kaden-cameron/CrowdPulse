import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { clipWindow } from "@crowdpulse/shared";
import { createApp } from "../src/app.js";
import type { EventRecord } from "../src/db.js";
import { fetchSyncedLyrics, findHighlight, parseLrc } from "../src/highlightFinder.js";
import { SessionStore } from "../src/session.js";

const HOST = { "x-host-key": "k" };
const LRC = ["[00:12.00] verse one", "[00:30.50] verse two", "[00:48.20] here comes the chorus", "[01:05.00] chorus again", "[01:30.00] bridge"].join("\n");
const model = (answer: object, seen: unknown[] = []) =>
  ({
    model: "fake",
    generate: vi.fn(async (i: { user: string }) => (seen.push(JSON.parse(i.user)), { text: JSON.stringify(answer), responseId: "r", modelVersion: "v", latencyMs: 1, usage: null })),
  }) as never;

describe("finding a song's highlight", () => {
  it("parses time-synced lyrics", () => {
    const lines = parseLrc(LRC + "\n[02:00.00]\nnot a line");
    expect(lines).toHaveLength(5);
    expect(lines[2]).toEqual({ i: 2, t: 48.2, text: "here comes the chorus", repeats: 1 });
    // Repeated lines (choruses) are counted, ignoring case and punctuation.
    const rep = parseLrc("[00:10.00] Verse\n[00:40.00] Oh, the chorus!\n[01:20.00] oh the chorus\n[01:30.00] end");
    expect(rep.map((l) => l.repeats)).toEqual([1, 2, 2, 1]);
  });

  it("fetches synced lyrics from LRCLIB (and copes with failures)", async () => {
    const ok = vi.fn(async () => Response.json([{ syncedLyrics: null }, { syncedLyrics: LRC, duration: 212 }]));
    expect(await fetchSyncedLyrics("Song", "Artist feat. X", ok as never)).toMatchObject({ durationSec: 212 });
    expect((await fetchSyncedLyrics("Song", "Artist feat. X", ok as never))?.lines).toHaveLength(5);
    expect(String((ok.mock.calls[0] as unknown[])[0])).toContain("artist_name=Artist");
    expect(await fetchSyncedLyrics("Song", "Artist", (async () => new Response("", { status: 500 })) as never)).toBeNull();
    expect(await fetchSyncedLyrics("Song", "Artist", (async () => { throw new Error("offline"); }) as never)).toBeNull();
  });

  it("with lyrics, Gemini picks the chorus line and its timestamp gives the start (with a short lead-in)", async () => {
    const seen: { lyric_lines: unknown[] }[] = [];
    const h = await findHighlight(
      model({ start_line_text: "here comes the chorus", end_line_text: "chorus again", start_seconds: 50, end_seconds: 80, lead_in_seconds: 0, confidence: 0.9 }, seen),
      { title: "S", artist: "A" },
      "chorus",
      parseLrc(LRC),
    );
    // Starts a beat before the chorus line; ends when the line after the section's last line begins.
    expect(h).toEqual({ startMs: 48_200 - 1_500, endMs: 90_000, source: "lyrics" });
    // Gemini quotes the chorus words: those win over a wrong line number.
    const quoted = await findHighlight(
      model({ start_line_text: "Chorus again!", end_line_text: "", start_seconds: 10, end_seconds: 90, lead_in_seconds: 0, confidence: 0.8 }),
      { title: "S", artist: "A" },
      "chorus",
      parseLrc(LRC),
    );
    expect(quoted).toEqual({ startMs: 65_000 - 1_500, endMs: 90_000, source: "lyrics" });
    // A song with a build-up: Gemini asks for a lead-in, so the clip starts before the section lands.
    const built = await findHighlight(
      model({ start_line_text: "here comes the chorus", end_line_text: "chorus again", start_seconds: 48, end_seconds: 80, lead_in_seconds: 12, confidence: 0.8 }),
      { title: "S", artist: "A" },
      "chorus",
      parseLrc(LRC),
    );
    expect(built.startMs).toBe(48_200 - 12_000);
    expect(seen[0].lyric_lines).toHaveLength(5);
  });

  it("without lyrics (e.g. a drop), uses Gemini's estimate; failures give 'unknown'", async () => {
    // A drop with a 10 s build-up worth hearing: starts 10 s before the drop.
    expect(
      await findHighlight(model({ start_line_text: "", end_line_text: "", start_seconds: 62, end_seconds: 100, lead_in_seconds: 10, confidence: 0.6 }), { title: "S", artist: "A" }, "drop", null),
    ).toEqual({ startMs: 52_000, endMs: 100_000, source: "gemini" });
    expect(await findHighlight(model({ nonsense: true }), { title: "S", artist: "A" }, "auto", null)).toEqual({ startMs: null, endMs: null, source: "default" });
    expect(await findHighlight(undefined, { title: "S", artist: "A" }, "auto", null)).toEqual({ startMs: null, endMs: null, source: "default" });
    // An estimate in the last 25 s of the song is rejected.
    expect(
      await findHighlight(model({ start_line_text: "", end_line_text: "", start_seconds: 196, end_seconds: 199, lead_in_seconds: 0, confidence: 0.5 }), { title: "Levels", artist: "Avicii" }, "drop", { lines: null, durationSec: 200 }),
    ).toEqual({ startMs: null, endMs: null, source: "default" });
  });

  it("clip window: starts at the highlight, fits inside the song, unknown starts ~30% in", () => {
    // No section end known: the target length.
    expect(clipWindow({ startMs: 60_000 }, 200_000, 45)).toEqual({ start: 60_000, end: 105_000 });
    expect(clipWindow({ startMs: null }, 200_000, 45)).toEqual({ start: 60_000, end: 105_000 });
    // The clip follows the section: a 32 s chorus plays 32 s…
    expect(clipWindow({ startMs: 50_000, endMs: 82_000 }, 200_000, 45)).toEqual({ start: 50_000, end: 82_000 });
    // …kept between half and 1.5× the target.
    expect(clipWindow({ startMs: 50_000, endMs: 55_000 }, 200_000, 45)).toEqual({ start: 50_000, end: 72_500 });
    expect(clipWindow({ startMs: 50_000, endMs: 190_000 }, 200_000, 45)).toEqual({ start: 50_000, end: 117_500 });
    // Too close to the end: moved back to fit.
    expect(clipWindow({ startMs: 190_000 }, 200_000, 45)).toEqual({ start: 154_000, end: 199_000 });
  });
});

describe("Highlights mode on the server", () => {
  function setup(answer: object = { start_line_text: "here comes the chorus", end_line_text: "chorus again", start_seconds: 50, end_seconds: 80, lead_in_seconds: 0, confidence: 0.9 }) {
    const saved: Required<EventRecord>[] = [];
    let n = Date.now();
    const store = new SessionStore("demo", "Demo", {
      persist: async (r) => (saved.push({ ...r, time: new Date((n += 10)) } as Required<EventRecord>), "stored"),
    });
    const m = model(answer);
    const lyrics = vi.fn(async () => ({ lines: parseLrc(LRC), durationSec: 200 }));
    const { app } = createApp({ sessions: new Map([["demo", store]]), hostKey: "k", trackEstimator: m, lyrics });
    return { store, app, saved, m, lyrics };
  }

  it("settings are host-only, validated, broadcast and saved", async () => {
    const { app, store, saved } = setup();
    const body = { enabled: true, clipSec: 60, part: "auto", transition: "cut" };
    expect((await request(app).post("/api/host/sessions/demo/playback/highlights").send(body)).status).toBe(401);
    expect((await request(app).post("/api/host/sessions/demo/playback/highlights").set(HOST).send({ ...body, clipSec: 33 })).status).toBe(400);
    expect((await request(app).post("/api/host/sessions/demo/playback/highlights").set(HOST).send(body)).status).toBe(200);
    expect(store.getState().playback.highlights).toEqual(body);
    // The part is always Gemini's choice ("auto"), even if an older client sends another.
    await request(app).post("/api/host/sessions/demo/playback/highlights").set(HOST).send({ ...body, part: "drop" });
    expect(store.getState().playback.highlights.part).toBe("auto");
    await request(app).post("/api/host/sessions/demo/playback/highlights").set(HOST).send(body);
    const restored = new SessionStore("demo", "Demo");
    restored.replay(saved);
    expect(restored.getState().playback.highlights).toEqual(body);
  });

  it("a song's highlight is worked out once, saved, and survives a restart", async () => {
    const { app, m, lyrics, saved } = setup();
    const first = await request(app).get("/api/host/sessions/demo/highlight/track_03?part=chorus").set(HOST);
    expect(first.body).toEqual({ startMs: 46_700, endMs: 90_000, source: "lyrics" });
    const again = await request(app).get("/api/host/sessions/demo/highlight/track_03?part=chorus").set(HOST);
    expect(again.body).toEqual(first.body);
    expect((m as unknown as { generate: { mock: { calls: unknown[] } } }).generate.mock.calls).toHaveLength(1);
    expect(lyrics).toHaveBeenCalledTimes(1);
    const restored = new SessionStore("demo", "Demo");
    restored.replay(saved);
    expect(restored.getHighlight("track_03", "chorus")).toEqual({ startMs: 46_700, endMs: 90_000, source: "lyrics" });
    expect((await request(app).get("/api/host/sessions/demo/highlight/nope").set(HOST)).status).toBe(404);
    expect((await request(app).get("/api/host/sessions/demo/highlight/track_03")).status).toBe(401);
  });

  it("the host's ±10 s nudge is saved and used next time", async () => {
    const { app, store } = setup();
    const r = await request(app).put("/api/host/sessions/demo/highlight/track_03").set(HOST).send({ part: "auto", startMs: 75_000, endMs: 110_000 });
    expect(r.status).toBe(200);
    expect(store.getHighlight("track_03", "auto")).toEqual({ startMs: 75_000, endMs: 110_000, source: "host" });
    expect((await request(app).get("/api/host/sessions/demo/highlight/track_03?part=auto").set(HOST)).body).toEqual({ startMs: 75_000, endMs: 110_000, source: "host" });
  });

  it("the player's clip shows up in playback state (for the projector), and a new song clears it", async () => {
    const { app, store } = setup();
    await store.advance("track_03");
    await request(app)
      .post("/api/host/sessions/demo/playback/report")
      .set(HOST)
      .send({ event: "started", trackId: "track_03", round: 1, positionMs: 60_000, durationMs: 200_000, clipStartMs: 60_000, clipEndMs: 105_000 });
    expect(store.getState().playback).toMatchObject({ clipStartMs: 60_000, clipEndMs: 105_000 });
    await store.advance("track_04");
    expect(store.getState().playback).toMatchObject({ clipStartMs: null, clipEndMs: null });
  });
});

describe("highlight model fallback", () => {
  it("tries the everyday model when the larger one is busy", async () => {
    const busy = { model: "big", generate: vi.fn(async () => { throw new Error("Gemini HTTP 503: high demand"); }) } as never;
    const h = await findHighlight(busy, { title: "S", artist: "A" }, "drop", null, model({ start_line_text: "", end_line_text: "", start_seconds: 45, end_seconds: 75, lead_in_seconds: 0, confidence: 0.6 }));
    expect(h).toEqual({ startMs: 45_000, endMs: 75_000, source: "gemini" });
  });
});
