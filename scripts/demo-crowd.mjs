// Demo crowd simulator (Doc 08 §5: "create a visible change in engagement using a controlled set of
// demo events"). Drives the real API with simulated attendees whose IDs start with "sim_", so the
// stage and host pages label them "Demo data". Never present this traffic as real people.
//
// Usage: node scripts/demo-crowd.mjs [--url http://localhost:8787] [--session demo]
//          [--people 20] [--seconds 30] [--mood wild|hyped|focused|chill|mixed]

import { randomUUID } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const BASE = (args.url ?? "http://localhost:8787").replace(/\/$/, "");
const SESSION = args.session ?? "demo";
const PEOPLE = Math.min(200, Number(args.people ?? 20));
const SECONDS = Math.min(600, Number(args.seconds ?? 30));
const MOOD = args.mood ?? "mixed";
const MOODS = ["chill", "hyped", "focused", "wild"];

const post = (path, body) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.status);

const state = await fetch(`${BASE}/api/sessions/${SESSION}/state`).then((r) => {
  if (!r.ok) throw new Error(`Session "${SESSION}" not reachable at ${BASE} (HTTP ${r.status})`);
  return r.json();
});
const tracks = state.tracks.map((t) => t.id);
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
// A few favourite tracks so the queue shows a clear leader.
const favourites = [...tracks].sort(() => Math.random() - 0.5).slice(0, 3);

console.log(`DEMO DATA: simulating ${PEOPLE} attendees for ${SECONDS}s against ${BASE} (session "${SESSION}")`);
const people = Array.from({ length: PEOPLE }, () => `sim_${randomUUID().replaceAll("-", "").slice(0, 12)}`);
const tally = { moods: 0, votes: 0, taps: 0, rejected: 0 };
const count = (status, key, n = 1) => (status === 200 ? (tally[key] += n) : tally.rejected++);

// Everyone joins with a mood.
await Promise.all(
  people.map(async (participantId) => {
    const mood = MOOD === "mixed" ? pick(MOODS) : MOOD;
    count(await post(`/api/sessions/${SESSION}/moods`, { sessionId: SESSION, eventId: randomUUID(), participantId, mood }), "moods");
  }),
);

// Then votes trickle in and taps build up over the run.
const end = Date.now() + SECONDS * 1000;
const voted = new Map(people.map((p) => [p, new Set()]));
while (Date.now() < end) {
  const progress = 1 - (end - Date.now()) / (SECONDS * 1000);
  await Promise.all(
    people.map(async (participantId) => {
      if (Math.random() < 0.15) {
        const trackId = Math.random() < 0.7 ? pick(favourites) : pick(tracks);
        if (!voted.get(participantId).has(trackId)) {
          voted.get(participantId).add(trackId);
          count(await post(`/api/sessions/${SESSION}/votes`, { sessionId: SESSION, trackId, eventId: randomUUID(), participantId }), "votes");
        }
      }
      // Tap intensity ramps up through the run so the energy meter visibly climbs.
      if (Math.random() < 0.3 + 0.5 * progress) {
        const n = 1 + Math.floor(Math.random() * (3 + 6 * progress));
        count(await post(`/api/sessions/${SESSION}/taps`, { sessionId: SESSION, eventId: randomUUID(), participantId, count: n }), "taps", n);
      }
    }),
  );
  process.stdout.write(`\r  moods ${tally.moods}  votes ${tally.votes}  taps ${tally.taps}  rejected ${tally.rejected}   `);
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`\nDone. All of the above is simulated demo data (participant IDs start with "sim_").`);
