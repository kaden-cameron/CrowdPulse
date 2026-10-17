import type { BoostConfig, BoostIntent, BoostVerifyResult } from "@crowdpulse/shared";

// Optional Solana devnet boosts (Doc 05). The browser never holds keys: a wallet extension
// (e.g. Phantom set to devnet) signs, and the server verifies the transaction on-chain.

const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

interface InjectedWallet {
  isPhantom?: boolean;
  publicKey?: { toBase58(): string; toString(): string } | null;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signAndSendTransaction(tx: unknown): Promise<{ signature: string }>;
}

export function detectWallet(): InjectedWallet | null {
  const w = window as unknown as { phantom?: { solana?: InjectedWallet }; solana?: InjectedWallet };
  return w.phantom?.solana ?? w.solana ?? null;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202 && res.status !== 409 && res.status !== 503) {
    throw new Error(body.error ?? body.reason ?? `Request failed (${res.status})`);
  }
  return body as T;
}

export async function fetchBoostConfig(): Promise<BoostConfig> {
  return json(await fetch("/api/solana/config"));
}

export async function createBoostIntent(sessionId: string, trackId: string, participantId: string): Promise<BoostIntent> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/boosts/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trackId, participantId }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 201) throw new Error(body.error ?? `Could not start boost (${res.status})`);
  return body as BoostIntent;
}

export async function verifyBoost(sessionId: string, intentId: string, signature: string): Promise<BoostVerifyResult> {
  return json(
    await fetch("/api/solana/boost/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, intentId, signature }),
    }),
  );
}

/**
 * Builds the transfer + memo transaction and asks the wallet to sign and send it.
 * web3.js is loaded only when someone actually boosts, so voting pages stay light.
 */
export async function payWithWallet(wallet: InjectedWallet, intent: BoostIntent): Promise<string> {
  const [{ Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction }, { Buffer }] = await Promise.all([
    import("@solana/web3.js"),
    import("buffer"),
  ]);
  const { publicKey } = await wallet.connect();
  const from = new PublicKey(publicKey.toString());
  const conn = new Connection(intent.rpcUrl, "confirmed");
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const tx = new Transaction({ feePayer: from, blockhash, lastValidBlockHeight }).add(
    SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(intent.recipient), lamports: intent.lamports }),
    new TransactionInstruction({
      programId: new PublicKey(MEMO_PROGRAM_ID),
      keys: [],
      data: Buffer.from(intent.memo, "utf8"),
    }),
  );
  const { signature } = await wallet.signAndSendTransaction(tx);
  return signature;
}

/** Polls verification until verified/rejected, or gives up (still unverified — never "success"). */
export async function waitForVerification(
  sessionId: string,
  intentId: string,
  signature: string,
  onUpdate: (r: BoostVerifyResult) => void,
  { attempts = 30, intervalMs = 2500 } = {},
): Promise<BoostVerifyResult> {
  let last: BoostVerifyResult | null = null;
  for (let i = 0; i < attempts; i++) {
    last = await verifyBoost(sessionId, intentId, signature);
    onUpdate(last);
    if (last.status === "verified" || last.status === "rejected") return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last!;
}
