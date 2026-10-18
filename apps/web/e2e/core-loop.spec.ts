import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { devices, expect, test, type Browser, type Page } from "@playwright/test";
import type { SessionState } from "@crowdpulse/shared";

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
  await expect(phone.getByRole("button", { name: "Take back your vote for Stage Lightning" })).toBeVisible();
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
  await expect(phone.getByRole("button", { name: "Take back your vote for Spanish Moss" })).toBeVisible();
  // Counted exactly once, and the vote made while offline elsewhere is visible without reload.
  await expect(phone.locator(".track-row", { hasText: "Spanish Moss" })).toContainText("1 vote ·");
  await expect(phone.locator(".track-row", { hasText: "Crowd Current" })).toContainText("1 vote ·");
});

test("FE-08: the host changes the stage theme and the projector follows", async ({ browser }) => {
  const stage = await openStage(browser);
  const host = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
  await host.goto("/host/demo");
  // Signed out, the host page is just a sign-in screen.
  await expect(host.getByRole("heading", { name: "Host sign in" })).toBeVisible();
  await expect(host.locator(".player-card")).toHaveCount(0);
  await host.getByLabel(/Dev host key/).fill(HOST_KEY);
  await expect(host.locator(".player-card")).toBeVisible();
  await host.getByRole("button", { name: /^Settings/ }).click(); // ⚙︎ in the menu bar
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
  await expect(phone.getByRole("button", { name: "Take back your vote for Stage Lightning" })).toBeEnabled();

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
  await expect(phone.getByRole("button", { name: "Take back your vote for Spanish Moss" })).toBeVisible();
  expect((await request.post("/api/host/sessions/demo/reset", { headers: host })).status()).toBe(200);
  await expect(phone.getByText(/new run just started/)).toBeVisible();
  await phone.getByRole("button", { name: "Continue to vote" }).click();
  await expect(phone.getByRole("button", { name: "Vote: Spanish Moss" })).toBeEnabled();
  await expect(phone.getByText(/Rejected:/)).toHaveCount(0);
});

test("Attendees have 3 votes at once, can take one back, and a reload remembers them", async ({ browser }) => {
  const phone = await openPhone(browser);
  for (const t of ["Gator Glow", "Midnight Cypress", "Spanish Moss"]) {
    await phone.getByRole("button", { name: `Vote: ${t}` }).click();
    await expect(phone.getByRole("button", { name: `Take back your vote for ${t}` })).toBeVisible();
  }
  await expect(phone.getByText(/All 3 votes used/)).toBeVisible();
  await expect(phone.getByRole("button", { name: "Vote: Voltage Swamp" })).toBeDisabled();

  await phone.getByRole("button", { name: "Take back your vote for Gator Glow" }).click();
  await expect(phone.getByRole("button", { name: "Vote: Gator Glow" })).toBeVisible();
  await expect(phone.getByText(/1 of 3 votes left/)).toBeVisible();
  await expect(phone.getByRole("button", { name: "Vote: Voltage Swamp" })).toBeEnabled();

  // One identity per device: a reload goes straight back to voting, with the same votes.
  await phone.reload();
  await expect(phone.getByRole("button", { name: "Take back your vote for Spanish Moss" })).toBeVisible();
  await expect(phone.getByRole("button", { name: "Continue to vote" })).toHaveCount(0);

  // A second tab on the same device takes over; the first one steps aside.
  const second = await phone.context().newPage();
  await second.goto("/join/demo");
  await expect(second.getByRole("button", { name: "Take back your vote for Spanish Moss" })).toBeVisible();
  await expect(phone.getByText("CrowdPulse is open in another tab")).toBeVisible();
});

test("Music: the player plays through Spotify only, and the host's queue + skip pick the song", async ({ browser, request }) => {
  const host = { "x-host-key": HOST_KEY };
  const state = async () => (await (await request.get("/api/sessions/demo/state")).json()) as {
    nowPlaying: { trackId: string } | null;
    queue: { trackId: string; hostPick?: boolean }[];
  };

  // The speaker laptop: no "this laptop" option, and Start audio waits for Spotify.
  const laptop = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await laptop.goto("/player/demo");
  await laptop.getByLabel(/Dev host key/).fill(HOST_KEY);
  await expect(laptop.getByRole("button", { name: /This laptop/ })).toHaveCount(0);
  await expect(laptop.locator(".player-start")).toBeDisabled();

  // The host's queue plays before votes; Skip works with or without a queue.
  await request.post("/api/sessions/demo/votes", {
    data: { sessionId: "demo", trackId: "track_05", eventId: randomUUID(), participantId: "participant_music1" },
  });
  expect((await request.put("/api/host/sessions/demo/queue", { headers: host, data: { trackIds: ["track_02"] } })).status()).toBe(200);
  expect((await request.post("/api/host/sessions/demo/advance", { headers: host })).status()).toBe(200);
  expect((await state()).nowPlaying?.trackId).toBe("track_02");
  await expect(laptop.locator(".player-title")).toHaveText("Midnight Cypress");
  expect((await request.post("/api/host/sessions/demo/advance", { headers: host })).status()).toBe(200);
  expect((await state()).nowPlaying?.trackId).toBe("track_05");
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

test("Spotify explains what's missing instead of failing silently", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/player/demo");
  await page.getByLabel(/Dev host key/).fill(HOST_KEY);
  // This test server has no SPOTIFY_CLIENT_ID.
  await expect(page.getByText(/Spotify isn't set up on this server/)).toBeVisible();
  await expect(page.locator(".player-start")).toBeDisabled();
});

test("The host picks the look; the big screen and attendee phones follow it live", async ({ browser, request }) => {
  const stage = await openStage(browser);
  const phone = await openPhone(browser);
  for (const p of [stage, phone]) {
    await expect(p.locator("html")).toHaveAttribute("data-preset", "sky");
    await expect(p.locator("html")).toHaveAttribute("data-mode", "light");
  }
  // Attendees and the projector don't get their own theme control.
  await expect(phone.getByRole("button", { name: /Theme/ })).toHaveCount(0);

  const host = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
  await host.goto("/host/demo");
  // Signed out, the host page is just a sign-in screen.
  await expect(host.getByRole("heading", { name: "Host sign in" })).toBeVisible();
  await expect(host.locator(".player-card")).toHaveCount(0);
  await host.getByLabel(/Dev host key/).fill(HOST_KEY);
  await expect(host.locator(".player-card")).toBeVisible();
  await host.getByRole("button", { name: /^Settings/ }).click(); // ⚙︎ in the menu bar
  const card = host.locator(".appearance-card");
  await card.getByText("Green").click();
  await expect(host.getByText(/Look changed to Green · light/)).toBeVisible();
  await card.getByText("Dark", { exact: true }).click();
  await expect(host.getByText(/Look changed to Green · dark/)).toBeVisible();

  // Both other screens switch without reloading.
  for (const p of [stage, phone, host]) {
    await expect(p.locator("html")).toHaveAttribute("data-preset", "mint");
    await expect(p.locator("html")).toHaveAttribute("data-mode", "dark");
  }
  await expect(phone.locator("body")).toHaveCSS("background-color", "rgb(10, 43, 30)");
  await phone.reload();
  await expect(phone.locator("html")).toHaveAttribute("data-preset", "mint");

  // Put the default back for other tests.
  await request.post("/api/host/sessions/demo/appearance", { headers: { "x-host-key": HOST_KEY }, data: { preset: "sky", mode: "light" } });
});

test("With crowd energy off, the projector shows a quiet screen: song, QR code and queue", async ({ browser, request }) => {
  const host = { "x-host-key": HOST_KEY };
  const stage = await openStage(browser);
  await expect(stage.locator(".energy-block")).toHaveCount(1);
  await request.post("/api/host/sessions/demo/appearance", { headers: host, data: { preset: "sky", mode: "light", showEnergy: false } });
  await expect(stage.locator(".energy-block")).toHaveCount(0);
  await expect(stage.locator(".stage-quiet canvas.stage-canvas")).toHaveCount(1); // the visuals stay, behind the song
  await expect(stage.locator(".stage-song-title")).toBeVisible();
  await expect(stage.locator(".join-qr-code img")).toBeVisible();
  await expect(stage.locator(".stage-queue")).toBeVisible();
  // The timer shows how far into the song it is.
  await request.post("/api/host/sessions/demo/advance", { headers: host, data: { trackId: "track_02" } });
  await request.post("/api/host/sessions/demo/playback/report", {
    headers: host,
    data: { event: "started", trackId: "track_02", round: 1, positionMs: 65_000, durationMs: 200_000 },
  });
  await expect(stage.locator(".stage-timer")).toHaveText(/1:0[5-9] \/ 3:20/);
    await stage.screenshot({ path: evidence("stage-quiet.png") });
  await request.post("/api/host/sessions/demo/appearance", { headers: host, data: { preset: "sky", mode: "light", showEnergy: true } });
  await expect(stage.locator(".energy-block")).toHaveCount(1);
});

test("The projector shows an empty song bar (0:00 / 0:00) when nothing is playing", async ({ browser }) => {
  const stage = await openStage(browser);
  await expect(stage.locator(".stage-timer")).toHaveText("0:00 / 0:00");
  await expect(stage.locator(".song-progress")).toBeVisible();
});

test("The projector shows only the next 4 songs, with a count of the rest", async ({ browser, request }) => {
  await request.put("/api/host/sessions/demo/queue", {
    headers: { "x-host-key": HOST_KEY },
    data: { trackIds: ["track_01", "track_02", "track_03", "track_04", "track_05", "track_06"] },
  });
  const stage = await openStage(browser);
  await expect(stage.locator(".stage-queue li")).toHaveCount(4);
  await expect(stage.getByText("+2 more in the queue")).toBeVisible();
});

test("Playlists: save the library under a name, clear it, load it back", async ({ browser }) => {
  const host = await (await browser.newContext({ viewport: { width: 1300, height: 1400 } })).newPage();
  host.on("dialog", (d) => void d.accept());
  await host.goto("/host/demo");
  await host.getByLabel(/Dev host key/).fill(HOST_KEY);
  const card = host.locator(".playlists-card");
  await card.getByPlaceholder(/Name it/).fill(`Warm-up ${Date.now() % 10000}`);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByText(/Saved “Warm-up/)).toBeVisible();
  await host.locator(".library-card").getByRole("button", { name: "Clear library" }).click();
  await expect(host.locator(".library-card").getByText("Library · 0 songs")).toBeVisible();
  await card.getByRole("button", { name: /^Load Warm-up/ }).first().click();
  await expect(host.locator(".library-card").getByText("Library · 7 songs")).toBeVisible();
  await host.screenshot({ path: evidence("playlists.png"), fullPage: true });
});

test("The host can reset the crowd mood (votes stay)", async ({ browser, request }) => {
  const phone = await openPhone(browser); // joins as Wild
  await phone.getByRole("button", { name: "Vote: Stage Lightning" }).click();
  const host = await (await browser.newContext({ viewport: { width: 1300, height: 1400 } })).newPage();
  host.on("dialog", (d) => void d.accept());
  await host.goto("/host/demo");
  await host.getByLabel(/Dev host key/).fill(HOST_KEY);
  const crowd = host.locator(".crowd-card");
  await expect(crowd.locator(".mood-bars li", { hasText: "wild" })).toContainText("1");
  await crowd.getByRole("button", { name: /Reset mood/ }).click();
  await expect(crowd.getByText("Crowd mood reset.")).toBeVisible();
  await expect(crowd.locator(".mood-bars li", { hasText: "wild" })).toContainText("0");
  const state = await (await request.get("/api/sessions/demo/state")).json();
  expect(state.tracks.find((t: { id: string }) => t.id === "track_07").votes).toBe(1);
  // The phone stays on the vote screen.
  await expect(phone.getByRole("heading", { name: "Shape the queue" })).toBeVisible();
});

test("The host switches the projector to the vote count", async ({ browser, request }) => {
  const host = { "x-host-key": HOST_KEY };
  for (const [t, p] of [["track_05", "v1"], ["track_05", "v2"], ["track_02", "v3"]]) {
    await request.post("/api/sessions/demo/votes", { data: { sessionId: "demo", trackId: t, eventId: randomUUID(), participantId: `participant_${p}xxxx` } });
  }
  const stage = await openStage(browser);
  await expect(stage.locator(".stage-queue").getByRole("heading", { name: "Up next" })).toBeVisible();
  await request.post("/api/host/sessions/demo/stage-view", { headers: host, data: { panel: "votes", auto: false } });
  const votes = stage.locator(".stage-votes");
  await expect(votes.getByRole("heading", { name: "Vote count" })).toBeVisible();
  await expect(votes.locator(".vote-bars li").first()).toContainText("Voltage Swamp");
  await expect(votes.locator(".vote-bars li").first()).toContainText("2");
  await stage.screenshot({ path: evidence("stage-vote-count.png") });
  await request.post("/api/host/sessions/demo/stage-view", { headers: host, data: { panel: "queue", auto: false } });
  await expect(stage.locator(".stage-queue").getByRole("heading", { name: "Up next" })).toBeVisible();
});

// --- Local files ---

/** A synthetic song as a 16-bit mono WAV: kick on every beat (accented bar starts), an A minor pad, a quiet outro. */
function wavSong(bpm: number, seconds: number, outroFromS: number): Buffer {
  const rate = 22_050;
  const n = Math.round(seconds * rate);
  const x = new Float32Array(n);
  const beat = 60 / bpm;
  for (let k = 0; 0.5 + k * beat < seconds; k++) {
    const t0 = 0.5 + k * beat;
    const amp = (k % 4 === 0 ? 0.9 : 0.5) * (t0 >= outroFromS ? 0.25 : 1);
    for (let i = 0; i < 0.15 * rate && Math.round(t0 * rate) + i < n; i++) {
      x[Math.round(t0 * rate) + i] += amp * Math.sin((2 * Math.PI * 55 * i) / rate) * Math.exp(-i / (0.04 * rate));
    }
  }
  for (let i = 0; i < n; i++) {
    const q = i / rate >= outroFromS ? 0.25 : 1;
    for (const f of [220, 261.63, 329.63]) x[i] += 0.05 * q * Math.sin((2 * Math.PI * f * i) / rate);
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  return buf;
}

test("Local files: songs from this laptop are added, play without Spotify, and can be renamed", async ({ browser, request }) => {
  test.setTimeout(90_000);
  const host = { "x-host-key": HOST_KEY };
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1100 } })).newPage();
  await page.goto("/host/demo");
  await page.getByLabel(/Dev host key/).fill(HOST_KEY);
  await expect(page.locator(".player-card")).toBeVisible();
  const stateNow = async () => (await (await request.get("/api/sessions/demo/state")).json()) as SessionState;
  let ids: string[] = [];
  try {
    await page.getByLabel("Audio files").setInputFiles([
      { name: "E2E DJ - Alpha.wav", mimeType: "audio/wav", buffer: wavSong(120, 20, 15) },
      { name: "E2E DJ - Beta.wav", mimeType: "audio/wav", buffer: wavSong(122, 20, 15) },
    ]);
    await expect(page.getByText(/Added 2 local songs/)).toBeVisible();
    const lib = page.locator(".library-list");
    await expect(lib.locator("li", { hasText: "Alpha" })).toContainText("local");
    const tracks = (await stateNow()).tracks.filter((t) => t.source === "local");
    ids = tracks.map((t) => t.id);
    const alpha = tracks.find((t) => t.title === "Alpha")!;
    expect(alpha.artist).toBe("E2E DJ");

    // No Spotify here: Start audio still works for local songs, and the song plays from the file.
    await page.getByRole("button", { name: "▶ Start audio on this device" }).click();
    await expect(page.getByText("● This tab is the player")).toBeVisible();
    expect((await request.post("/api/host/sessions/demo/advance", { headers: host, data: { trackId: alpha.id } })).status()).toBe(200);
    await expect.poll(async () => (await stateNow()).playback.status, { timeout: 15_000 }).toBe("playing");
    expect((await stateNow()).playback.source).toBe("file");

    // ✎ Rename: the library (and now playing) show the new name.
    await page.getByRole("button", { name: "Rename Alpha" }).click();
    await page.getByRole("textbox", { name: "New title for Alpha" }).fill("Sunrise");
    await page.getByRole("button", { name: "Save the new name" }).click();
    await expect(lib.locator("li", { hasText: "Sunrise" })).toContainText("local");
    await expect.poll(async () => (await stateNow()).nowPlaying?.title).toBe("Sunrise");
    await page.locator(".player-card").screenshot({ path: evidence("local-files.png") });
  } finally {
    await request.post("/api/host/sessions/demo/advance", { headers: host, data: { trackId: "track_01" } });
    for (const id of ids) await request.delete(`/api/host/sessions/demo/library/${id}`, { headers: host });
  }
});
