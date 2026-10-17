import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { devices, expect, test, type Browser, type Page } from "@playwright/test";

const HOST_KEY = "e2e-host-key";
const evidence = (name: string) =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../evidence/frontend", name);

async function openStage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/stage/demo");
  await expect(page.getByText("SwampHacks Main Stage")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
  return page;
}

async function openPhone(browser: Browser): Promise<Page> {
  const { defaultBrowserType: _ignored, ...iphone } = devices["iPhone 13"];
  const ctx = await browser.newContext(iphone);
  const page = await ctx.newPage();
  await page.goto("/join/demo");
  await expect(page.getByRole("heading", { name: "SwampHacks Main Stage" })).toBeVisible();
  await page.getByRole("button", { name: /Wild/ }).click();
  await page.getByRole("button", { name: "Continue to vote" }).click();
  return page;
}

test.beforeEach(async ({ request }) => {
  const r = await request.post("/api/host/sessions/demo/reset", { headers: { "x-host-key": HOST_KEY } });
  expect(r.status()).toBe(200);
});

test("FE-01/02/03 BE-05 E2E-01/02/03/11: a phone joins and votes; the stage updates without refresh (Gemini off)", async ({ browser }) => {
  const stage = await openStage(browser);
  const phone = await openPhone(browser);

  const t0 = Date.now();
  await phone.getByRole("button", { name: "Vote: Stage Lightning" }).click();
  await expect(phone.getByRole("button", { name: "Voted ✓: Stage Lightning" })).toBeVisible();
  await expect(stage.locator(".stage-queue")).toContainText("Stage Lightning");
  const ms = Date.now() - t0;
  // BE-05: both clients converge on the same server-computed count.
  await expect(stage.locator(".stage-queue li", { hasText: "Stage Lightning" })).toContainText("DJ Hydra · 1");
  await expect(phone.locator(".track-row", { hasText: "Stage Lightning" })).toContainText("1 vote ·");
  console.log(`vote click → stage shows it: ${ms} ms (includes UI round trip)`);
  expect(ms).toBeLessThan(2000);

  await phone.screenshot({ path: evidence("join-and-vote.png"), fullPage: true });
  await stage.screenshot({ path: evidence("stage-updated.png") });
});

test("FE-04 / E2E-12: a vote made offline is sent once on reconnect, and missed updates are restored", async ({
  browser,
  request,
}) => {
  const phone = await openPhone(browser);
  await phone.context().setOffline(true);
  await expect(phone.getByRole("status").filter({ hasText: /Reconnecting|Disconnected/ })).toBeVisible();

  // Vote while offline: it waits in the outbox.
  await phone.getByRole("button", { name: "Vote: Spanish Moss" }).click();
  await expect(phone.getByRole("button", { name: "Sending…: Spanish Moss" })).toBeVisible();

  // Someone else votes while this phone is away.
  await request.post("/api/sessions/demo/votes", {
    data: { sessionId: "demo", trackId: "track_06", eventId: randomUUID(), participantId: "participant_other1" },
  });

  await phone.context().setOffline(false);
  await expect(phone.getByRole("status").filter({ hasText: "Live" })).toBeVisible({ timeout: 15_000 });
  await expect(phone.getByRole("button", { name: "Voted ✓: Spanish Moss" })).toBeVisible();
  // Counted exactly once, and the vote made while offline elsewhere is visible without reload.
  await expect(phone.locator(".track-row", { hasText: "Spanish Moss" })).toContainText("1 vote ·");
  await expect(phone.locator(".track-row", { hasText: "Crowd Current" })).toContainText("1 vote ·");
});

test("FE-08: the host changes the stage theme and the projector follows", async ({ browser }) => {
  const stage = await openStage(browser);
  const host = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
  await host.goto("/host/demo");
  await host.getByLabel(/Dev host key/).fill(HOST_KEY);
  await host.getByRole("button", { name: "sunset" }).click();
  await host.getByRole("button", { name: "Apply to stage" }).click();
  await expect(host.getByText("Stage updated")).toBeVisible();
  await expect(stage.locator("canvas.stage-canvas")).toHaveAttribute("data-theme", "sunset");
  await host.screenshot({ path: evidence("host-dashboard.png"), fullPage: true });
});

test("E2E-09: an attendee can't call host actions, and the stage doesn't change", async ({ browser, request }) => {
  const stage = await openStage(browser);
  const before = await stage.locator("canvas.stage-canvas").getAttribute("data-theme");
  const r = await request.post("/api/host/sessions/demo/visual", { data: { visual: { theme: "neon_pulse", intensity: 1 } } });
  expect(r.status()).toBe(401);
  await stage.waitForTimeout(500);
  await expect(stage.locator("canvas.stage-canvas")).toHaveAttribute("data-theme", before!);
});

test("Simulated crowd traffic is labelled as demo data on the stage", async ({ browser, request }) => {
  const stage = await openStage(browser);
  await expect(stage.getByText(/Demo data/)).toHaveCount(0);
  await request.post("/api/sessions/demo/votes", {
    data: { sessionId: "demo", trackId: "track_01", eventId: randomUUID(), participantId: "sim_e2e00001" },
  });
  await expect(stage.getByText("Demo data · 1 simulated attendees")).toBeVisible();
});

test("Vote buttons come back after a track plays, and a new run starts fresh on every phone", async ({ browser, request }) => {
  const host = { "x-host-key": HOST_KEY };
  const phone = await openPhone(browser);

  await phone.getByRole("button", { name: "Vote: Stage Lightning" }).click();
  await expect(phone.getByRole("button", { name: "Voted ✓: Stage Lightning" })).toBeDisabled();

  // Host plays Stage Lightning, then another track: Stage Lightning is votable again.
  expect((await request.post("/api/host/sessions/demo/advance", { headers: host })).status()).toBe(200);
  await request.post("/api/sessions/demo/votes", {
    data: { sessionId: "demo", trackId: "track_01", eventId: randomUUID(), participantId: "participant_other2" },
  });
  expect((await request.post("/api/host/sessions/demo/advance", { headers: host })).status()).toBe(200);
  await expect(phone.getByRole("button", { name: "Vote: Stage Lightning" })).toBeEnabled();

  // The playing track can't be voted on from the page.
  await expect(phone.getByRole("button", { name: "Vote: Gator Glow" })).toBeDisabled();

  // "Start new run" sends the phone back to pick a mood, with fresh buttons.
  await phone.getByRole("button", { name: "Vote: Spanish Moss" }).click();
  await expect(phone.getByRole("button", { name: "Voted ✓: Spanish Moss" })).toBeVisible();
  expect((await request.post("/api/host/sessions/demo/reset", { headers: host })).status()).toBe(200);
  await expect(phone.getByText(/new run just started/)).toBeVisible();
  await phone.getByRole("button", { name: "Continue to vote" }).click();
  await expect(phone.getByRole("button", { name: "Vote: Spanish Moss" })).toBeEnabled();
  await expect(phone.getByText(/Rejected:/)).toHaveCount(0);
});

test("Music: the player plays the host's pick, auto mode moves on by itself, DJ mode waits", async ({ browser, request }) => {
  const host = { "x-host-key": HOST_KEY };
  const state = async () => (await (await request.get("/api/sessions/demo/state")).json()) as {
    nowPlaying: { trackId: string } | null;
    playback: { status: string; source: string | null; playerOnline: boolean; mode: string };
  };

  // The laptop plugged into the speakers: sign in, then press Start audio (browsers need a click).
  const laptop = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await laptop.goto("/player/demo?demoSeconds=4");
  await laptop.getByLabel(/Dev host key/).fill(HOST_KEY);
  await laptop.getByRole("button", { name: /Start audio/ }).click();
  await expect(laptop.getByText("Nothing playing")).toBeVisible();

  // Auto play, a crowd favourite, and the host starts the music.
  expect((await request.post("/api/host/sessions/demo/playback/mode", { headers: host, data: { mode: "auto" } })).status()).toBe(200);
  await request.post("/api/sessions/demo/votes", {
    data: { sessionId: "demo", trackId: "track_05", eventId: randomUUID(), participantId: "participant_music1" },
  });
  expect((await request.post("/api/host/sessions/demo/advance", { headers: host })).status()).toBe(200);

  await expect(laptop.locator(".player-title")).toHaveText("Voltage Swamp");
  await expect.poll(async () => (await state()).playback).toMatchObject({ status: "playing", source: "generated", playerOnline: true });
  await laptop.screenshot({ path: evidence("player-playing.png") });

  // ~4s later the song ends and auto mode starts another one with no host action.
  await expect.poll(async () => (await state()).nowPlaying?.trackId, { timeout: 12_000 }).not.toBe("track_05");
  await expect.poll(async () => (await state()).playback.status, { timeout: 8_000 }).toBe("playing");

  // DJ picks: when this song ends, nothing else starts.
  expect((await request.post("/api/host/sessions/demo/playback/mode", { headers: host, data: { mode: "dj" } })).status()).toBe(200);
  const current = (await state()).nowPlaying?.trackId;
  await expect.poll(async () => (await state()).playback.status, { timeout: 12_000 }).toBe("ended");
  expect((await state()).nowPlaying?.trackId).toBe(current);
  await expect(laptop.getByText("Song finished")).toBeVisible();
});

test("The stage QR code decodes to the join link, even when small in a phone's camera", async ({ browser }) => {
  const jsQR = (await import("jsqr")).default;
  const { PNG } = await import("pngjs");
  const stage = await openStage(browser);
  await stage.setViewportSize({ width: 1920, height: 1080 });
  await stage.waitForTimeout(500);
  const shot = PNG.sync.read(await stage.screenshot());
  // Simulate a phone a few metres back: the projected code covers ~1/3 as many camera pixels.
  const f = 0.35;
  const w = Math.round(shot.width * f);
  const h = Math.round(shot.height * f);
  const small = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const si = (Math.floor(y / f) * shot.width + Math.floor(x / f)) * 4;
      small.set(shot.data.subarray(si, si + 4), (y * w + x) * 4);
    }
  const code = jsQR(small, w, h);
  expect(code?.data).toMatch(/\/join\/demo$/);
  // Opened at localhost, the code must not send phones to localhost.
  expect(code?.data).not.toMatch(/localhost|127\.0\.0\.1/);
});

test("Spotify source explains what's missing instead of failing silently", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/player/demo");
  await page.getByLabel(/Dev host key/).fill(HOST_KEY);
  await page.getByRole("button", { name: /^Spotify/ }).click();
  // This test server has no SPOTIFY_CLIENT_ID.
  await expect(page.getByText(/Spotify isn't set up on this server/)).toBeVisible();
  await expect(page.locator(".player-start")).toBeDisabled();
  // Switching back to the laptop's own audio works immediately.
  await page.getByRole("button", { name: /^This laptop/ }).click();
  await expect(page.locator(".player-start")).toBeEnabled();
});
