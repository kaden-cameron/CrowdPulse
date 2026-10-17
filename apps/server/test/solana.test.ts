import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import type { BoostIntent } from "@crowdpulse/shared";
import { createApp, type Sessions } from "../src/app.js";
import { SessionStore } from "../src/session.js";
import { BoostVerifier, DEVNET_GENESIS_HASH, RpcError, type RpcCall } from "../src/solana.js";

const RECIPIENT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const PAYER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const LAMPORTS = 1_000_000;
const sig = () => "5" + Array.from({ length: 87 }, () => "abcdefghijkmnopqrstuvwxyz123456789"[Math.floor(Math.random() * 34)]).join("");

type FakeTx = {
  confirmation?: "processed" | "confirmed" | "finalized";
  err?: unknown;
  destination?: string;
  lamports?: number;
  memo?: string | null;
};

/** Fake devnet: signatures map to transactions the test describes. */
function fakeRpc(txs: Map<string, FakeTx>, opts: { genesis?: string; down?: boolean } = {}): RpcCall {
  return async (method, params) => {
    if (opts.down) throw new RpcError("Solana RPC timeout");
    if (method === "getGenesisHash") return opts.genesis ?? DEVNET_GENESIS_HASH;
    const s = method === "getSignatureStatuses" ? (params[0] as string[])[0] : (params[0] as string);
    const tx = txs.get(s);
    if (method === "getSignatureStatuses") {
      return { value: [tx ? { err: tx.err ?? null, confirmationStatus: tx.confirmation ?? "confirmed" } : null] };
    }
    if (method === "getTransaction") {
      if (!tx) return null;
      const ixs: unknown[] = [
        {
          program: "system",
          parsed: {
            type: "transfer",
            info: { source: PAYER, destination: tx.destination ?? RECIPIENT, lamports: tx.lamports ?? LAMPORTS },
          },
        },
      ];
      if (tx.memo !== null) ixs.push({ program: "spl-memo", parsed: tx.memo });
      return { slot: 123, meta: { err: tx.err ?? null }, transaction: { message: { instructions: ixs } } };
    }
    throw new Error(`unexpected ${method}`);
  };
}

let now = Date.parse("2026-10-17T02:00:00Z");
let store: SessionStore;
let other: SessionStore;
let txs: Map<string, FakeTx>;
let verifier: BoostVerifier;
let app: ReturnType<typeof createApp>["app"];

function setup(rpcOpts: Parameters<typeof fakeRpc>[1] = {}) {
  store = new SessionStore("demo", "Demo", { now: () => now });
  other = new SessionStore("other", "Other", { now: () => now });
  const sessions: Sessions = new Map([
    ["demo", store],
    ["other", other],
  ]);
  txs = new Map();
  verifier = new BoostVerifier({
    rpcUrl: "https://api.devnet.solana.com",
    recipient: RECIPIENT,
    lamports: LAMPORTS,
    sessions,
    rpc: fakeRpc(txs, rpcOpts),
    now: () => now,
  });
  ({ app } = createApp({ sessions, hostKey: "k", boosts: verifier, now: () => now }));
}

beforeEach(() => {
  now = Date.parse("2026-10-17T02:00:00Z");
  setup();
});

async function intent(trackId = "track_02", sessionId = "demo"): Promise<BoostIntent> {
  const res = await request(app)
    .post(`/api/sessions/${sessionId}/boosts/intents`)
    .send({ trackId, participantId: "participant_boost1" });
  expect(res.status).toBe(201);
  return res.body;
}

const verify = (i: BoostIntent, signature: string, sessionId = i.sessionId) =>
  request(app).post("/api/solana/boost/verify").send({ sessionId, intentId: i.intentId, signature });

const boostsOn = (s: SessionStore, trackId: string) => s.getState().tracks.find((t) => t.id === trackId)!.boosts;

describe("Solana devnet boosts", () => {
  it("SOL-09: a confirmed matching transaction (fake RPC) is verified and boosts the track", async () => {
    const i = await intent("track_02");
    expect(i.memo).toBe(`crowdpulse:demo:track_02:${i.intentId}`);
    const s = sig();
    txs.set(s, { memo: i.memo });
    const res = await verify(i, s);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "verified" });
    expect(res.body.explorerUrl).toContain("cluster=devnet");
    expect(boostsOn(store, "track_02")).toBe(1);
    expect(store.getState().queue[0]).toMatchObject({ trackId: "track_02", boosts: 1, votes: 0 });
    expect(store.getState().latestEvent?.type).toBe("boost.verified");
  });

  it("SOL-02: an unconfirmed transaction stays pending and applies nothing", async () => {
    const i = await intent();
    const s = sig();
    txs.set(s, { memo: i.memo, confirmation: "processed" });
    const res = await verify(i, s);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending");
    expect(boostsOn(store, "track_02")).toBe(0);
    // Later it confirms and the same request succeeds.
    txs.set(s, { memo: i.memo, confirmation: "finalized" });
    expect((await verify(i, s)).body.status).toBe("verified");
  });

  it("SOL-03: a signature not on devnet stays pending, then is rejected", async () => {
    const i = await intent();
    const s = sig();
    expect((await verify(i, s)).body.status).toBe("pending");
    now += 120_000;
    const res = await verify(i, s);
    expect(res.body).toMatchObject({ status: "rejected", reason: "Transaction not found on devnet" });
    expect(boostsOn(store, "track_02")).toBe(0);
  });

  it("SOL-03: refuses to verify against an RPC that is not devnet", async () => {
    setup({ genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" }); // mainnet-beta
    const i = await intent();
    const s = sig();
    txs.set(s, { memo: i.memo });
    expect((await verify(i, s)).body).toMatchObject({ status: "rejected", reason: "Configured RPC is not Solana devnet" });
  });

  it("SOL-04: wrong recipient, too little SOL, wrong memo, or a failed tx are rejected", async () => {
    const cases: FakeTx[] = [
      { destination: PAYER },
      { lamports: LAMPORTS - 1 },
      { memo: "crowdpulse:demo:track_02:someone-elses-intent" },
      { memo: null },
      { err: { InstructionError: [0, "Custom"] } },
    ];
    for (const c of cases) {
      const i = await intent();
      const s = sig();
      txs.set(s, { memo: i.memo, ...c });
      const res = await verify(i, s);
      expect(res.body.status).toBe("rejected");
    }
    expect(boostsOn(store, "track_02")).toBe(0);
  });

  it("SOL-05: the same signature cannot create a second boost — same intent, other intent, or other session", async () => {
    const i = await intent();
    const s = sig();
    txs.set(s, { memo: i.memo });
    expect((await verify(i, s)).body.status).toBe("verified");
    expect((await verify(i, s)).body.status).toBe("verified"); // idempotent re-check
    expect(boostsOn(store, "track_02")).toBe(1);

    const i2 = await intent();
    expect((await verify(i2, s)).body).toMatchObject({ status: "rejected", reason: "Signature already used for another boost" });
    const i3 = await intent("track_02", "other");
    expect((await verify(i3, s)).body.status).toBe("rejected");
    expect(boostsOn(store, "track_02")).toBe(1);
    expect(boostsOn(other, "track_02")).toBe(0);
  });

  it("an intent can't be used from another session", async () => {
    const i = await intent();
    const s = sig();
    txs.set(s, { memo: i.memo });
    expect((await verify(i, s, "other")).body.status).toBe("rejected");
  });

  it("SOL-06: random or malformed signatures are rejected without touching the RPC", async () => {
    const i = await intent();
    for (const bad of ["", "not-a-signature", "0OIl" + "a".repeat(84), "x".repeat(200)]) {
      const res = await verify(i, bad);
      expect(res.body.status).toBe("rejected");
    }
    expect(boostsOn(store, "track_02")).toBe(0);
  });

  it("SOL-07: an RPC outage reports unknown, never success", async () => {
    setup({ down: true });
    const i = await intent();
    const res = await verify(i, sig());
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unknown");
    expect(boostsOn(store, "track_02")).toBe(0);
  });

  it("SOL-08: voting works with no wallet and with boosts disabled", async () => {
    const sessions: Sessions = new Map([["demo", new SessionStore("demo", "Demo")]]);
    const { app: noBoost } = createApp({ sessions, hostKey: "k" });
    const vote = await request(noBoost)
      .post("/api/sessions/demo/votes")
      .send({ sessionId: "demo", trackId: "track_01", eventId: randomUUID(), participantId: "participant_nw" });
    expect(vote.body.status).toBe("accepted");
    expect((await request(noBoost).get("/api/solana/config")).body.enabled).toBe(false);
  });

  it("caps boost priority so boosts can't swamp votes", async () => {
    for (let n = 0; n < 5; n++) {
      const i = await intent("track_04");
      const s = sig();
      txs.set(s, { memo: i.memo });
      expect((await verify(i, s)).body.status).toBe("verified");
    }
    expect(boostsOn(store, "track_04")).toBe(3); // MAX_BOOSTS_PER_TRACK
    // 7 real votes outrank 3 capped boosts (worth 6).
    for (let v = 0; v < 7; v++) {
      await store.submitVote({ trackId: "track_01", eventId: randomUUID(), participantId: `participant_v${v}000` });
    }
    expect(store.getState().queue[0].trackId).toBe("track_01");
  });

  it("boosts survive a restart via replay and reset when the track plays", async () => {
    const saved: Parameters<SessionStore["replay"]>[0] = [];
    const persisting = new SessionStore("demo", "Demo", {
      persist: async (r) => (saved.push({ ...r, time: new Date() } as (typeof saved)[number]), "stored"),
    });
    await persisting.recordBoost({ trackId: "track_06", eventId: randomUUID(), participantId: "participant_r1", signature: sig(), lamports: LAMPORTS });
    const restored = new SessionStore("demo", "Demo");
    restored.replay(saved);
    expect(boostsOn(restored, "track_06")).toBe(1);
    await restored.advance("track_06");
    expect(boostsOn(restored, "track_06")).toBe(0);
  });
});
