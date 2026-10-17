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
