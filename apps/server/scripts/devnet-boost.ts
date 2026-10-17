// Sends a real Solana devnet boost through the running server (SOL-01 evidence).
// Usage: npm run boost:devnet --workspace=@crowdpulse/server -- <keypair.json> [trackId] [serverUrl]
// The keypair is a devnet test wallet (fund it at https://faucet.solana.com). Never commit it.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import type { BoostIntent, BoostVerifyResult } from "@crowdpulse/shared";

const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const [keyPath, trackId = "track_02", server = "http://localhost:8787"] = process.argv.slice(2);
if (!keyPath) {
  console.error("Usage: devnet-boost <keypair.json> [trackId] [serverUrl]");
  process.exit(1);
}
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
const participantId = `p_cli_${randomUUID().slice(0, 8)}`;

const post = async <T>(path: string, body: object) => {
  const res = await fetch(`${server}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
};

const intentRes = await post<BoostIntent & { error?: string }>(`/api/sessions/demo/boosts/intents`, { trackId, participantId });
if (intentRes.status !== 201) {
  console.error("Intent failed:", intentRes.body.error);
  process.exit(1);
}
const intent = intentRes.body;
console.log(`Intent ${intent.intentId}: send ${intent.lamports} lamports to ${intent.recipient} with memo "${intent.memo}"`);

const conn = new Connection(intent.rpcUrl, "confirmed");
const balance = await conn.getBalance(payer.publicKey);
console.log(`Payer ${payer.publicKey.toBase58()} has ${balance / 1e9} devnet SOL`);
if (balance < intent.lamports + 10_000) {
  console.error("Not enough devnet SOL — fund this address at https://faucet.solana.com");
  process.exit(1);
}

const tx = new Transaction().add(
  SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(intent.recipient), lamports: intent.lamports }),
  new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(intent.memo, "utf8") }),
);
const t0 = Date.now();
const signature = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
console.log(`Confirmed on devnet in ${Date.now() - t0} ms: ${signature}`);

for (let attempt = 1; attempt <= 20; attempt++) {
  const r = await post<BoostVerifyResult>(`/api/solana/boost/verify`, { sessionId: "demo", intentId: intent.intentId, signature });
  console.log(`Verify attempt ${attempt}: ${r.body.status}${r.body.reason ? ` (${r.body.reason})` : ""}`);
  if (r.body.status === "verified" || r.body.status === "rejected") {
    console.log(`Explorer: ${r.body.explorerUrl}`);
    const replay = await post<BoostVerifyResult>(`/api/solana/boost/verify`, {
      sessionId: "demo",
      intentId: (await post<BoostIntent>(`/api/sessions/demo/boosts/intents`, { trackId, participantId })).body.intentId,
      signature,
    });
    console.log(`Replay with a new intent: ${replay.body.status} (${replay.body.reason})`);
    process.exit(r.body.status === "verified" ? 0 : 1);
  }
  await new Promise((res) => setTimeout(res, 2000));
}
console.error("Still not verified after 40s");
process.exit(1);
