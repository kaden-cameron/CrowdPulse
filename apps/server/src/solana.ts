import { randomUUID } from "node:crypto";
import type { BoostConfig, BoostIntent, BoostVerifyResult, SessionState } from "@crowdpulse/shared";
import type { Database } from "./db.js";
import { log } from "./log.js";
import type { SessionStore } from "./session.js";

// Solana devnet boost verification (Doc 05). The server fetches the transaction from the
// configured devnet RPC and checks every detail before any boost is applied.

export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const DEFAULT_DEVNET_RPC = "https://api.devnet.solana.com";
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const INTENT_TTL_MS = 10 * 60_000;
/** How long "not found" counts as still propagating before we call it rejected. */
const NOT_FOUND_GRACE_MS = 90_000;

export class RpcError extends Error {}

/** Minimal JSON-RPC transport; tests substitute a fake. */
export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export function httpRpc(url: string, timeoutMs = 8_000): RpcCall {
  return async (method, params) => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new RpcError(`Solana RPC ${method} failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new RpcError(`Solana RPC ${method} HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null;
    if (!body) throw new RpcError(`Solana RPC ${method} returned invalid JSON`);
    if (body.error) throw new RpcError(`Solana RPC ${method}: ${body.error.message ?? "error"}`);
    return body.result;
  };
}

export const explorerUrl = (signature: string) =>
  `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;

interface StoredIntent {
  intent: BoostIntent;
  participantId: string;
  createdAt: number;
  verifiedSignature: string | null;
}

interface ParsedInstruction {
  program?: string;
  programId?: string;
  parsed?: unknown;
}

export interface BoostVerifierOptions {
  rpcUrl: string;
  /** Public devnet address that receives boost payments. Not a secret. */
  recipient: string | null;
  lamports: number;
  sessions: Map<string, SessionStore>;
  db?: Database;
  rpc?: RpcCall;
  now?: () => number;
}

export class BoostVerifier {
  private intents = new Map<string, StoredIntent>();
  private usedSignatures = new Map<string, string>(); // signature -> intentId (memory mode / fast path)
  private inFlight = new Set<string>();
  private genesisOk: boolean | null = null;
  private opts: BoostVerifierOptions;
  private rpc: RpcCall;
  private now: () => number;

  constructor(opts: BoostVerifierOptions) {
    if (opts.recipient && !PUBKEY_RE.test(opts.recipient)) {
      throw new Error("BOOST_RECIPIENT is not a valid Solana address");
    }
    this.opts = opts;
    this.rpc = opts.rpc ?? httpRpc(opts.rpcUrl);
    this.now = opts.now ?? Date.now;
  }

  config(): BoostConfig {
    return {
      enabled: Boolean(this.opts.recipient),
      cluster: "devnet",
      lamports: this.opts.lamports,
      recipient: this.opts.recipient,
    };
  }

  /** Issues single-use instructions binding a future transaction to this session and track. */
  createIntent(sessionId: string, trackId: string, participantId: string): BoostIntent | { error: string; status: number } {
    if (!this.opts.recipient) return { error: "Boosts are disabled on this server", status: 503 };
    const session = this.opts.sessions.get(sessionId);
    if (!session) return { error: "Unknown session", status: 404 };
    if (!session.catalogTracks().some((t) => t.id === trackId)) return { error: "Unknown track ID", status: 400 };
    this.sweep();
    const intentId = randomUUID();
    const intent: BoostIntent = {
      intentId,
      sessionId,
      trackId,
      cluster: "devnet",
      rpcUrl: this.opts.rpcUrl,
      recipient: this.opts.recipient,
      lamports: this.opts.lamports,
      memo: `crowdpulse:${sessionId}:${trackId}:${intentId}`,
      expiresAt: new Date(this.now() + INTENT_TTL_MS).toISOString(),
    };
    this.intents.set(intentId, { intent, participantId, createdAt: this.now(), verifiedSignature: null });
    return intent;
  }

  /**
   * Verifies a submitted signature. Only returns "verified" after the transaction is confirmed
   * on devnet, succeeded, pays the configured recipient at least the boost amount, carries this
   * intent's memo, and the signature has never been used before.
   */
  async verify(input: { sessionId: string; intentId: string; signature: string }): Promise<BoostVerifyResult> {
    const { sessionId, intentId, signature } = input;
    const result = (status: BoostVerifyResult["status"], reason?: string, state?: SessionState): BoostVerifyResult => {
      log({ kind: "solana.verify", sessionId, intentId, signature: signature.slice(0, 16), status, reason });
      return { status, signature, reason, explorerUrl: explorerUrl(signature), state };
    };

    if (!this.opts.recipient) return result("rejected", "Boosts are disabled on this server");
    if (!SIGNATURE_RE.test(signature)) return result("rejected", "Malformed transaction signature");
    const stored = this.intents.get(intentId);
    if (!stored || stored.intent.sessionId !== sessionId) return result("rejected", "Unknown boost intent for this session");
    const session = this.opts.sessions.get(sessionId);
    if (!session) return result("rejected", "Unknown session");

    // Idempotent re-check of an already verified boost.
    if (stored.verifiedSignature === signature) return result("verified", undefined, session.getState());
    if (stored.verifiedSignature) return result("rejected", "This boost intent was already used by another transaction");
    if (this.usedSignatures.has(signature)) return result("rejected", "Signature already used for another boost");
    if (this.now() - stored.createdAt > INTENT_TTL_MS) return result("rejected", "Boost intent expired");
    if (this.inFlight.has(signature)) return result("pending", "Verification already in progress");

    this.inFlight.add(signature);
    try {
      if (!(await this.isDevnet())) return result("rejected", "Configured RPC is not Solana devnet");

      const statuses = (await this.rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }])) as {
        value: ({ err: unknown; confirmationStatus?: string } | null)[];
      };
      const st = statuses?.value?.[0] ?? null;
      if (!st) {
        return this.now() - stored.createdAt < NOT_FOUND_GRACE_MS
          ? result("pending", "Not visible on devnet yet")
          : result("rejected", "Transaction not found on devnet");
      }
      if (st.err) return result("rejected", "Transaction failed on-chain");
      if (st.confirmationStatus !== "confirmed" && st.confirmationStatus !== "finalized") {
        return result("pending", `Waiting for confirmation (${st.confirmationStatus ?? "processing"})`);
      }

      const tx = (await this.rpc("getTransaction", [
        signature,
        { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ])) as {
        slot?: number;
        meta?: { err: unknown } | null;
        transaction?: { message?: { instructions?: ParsedInstruction[] } };
      } | null;
      if (!tx) return result("pending", "Confirmed but transaction details not available yet");
      if (tx.meta?.err) return result("rejected", "Transaction failed on-chain");

      const ixs = tx.transaction?.message?.instructions ?? [];
      const transfer = ixs
        .map((ix) => (ix.program === "system" ? (ix.parsed as { type?: string; info?: Record<string, unknown> }) : null))
        .find(
          (p) =>
            p?.type === "transfer" &&
            p.info?.destination === this.opts.recipient &&
            Number(p.info?.lamports) >= this.opts.lamports,
        );
      if (!transfer) {
        return result(
          "rejected",
          `Transaction must transfer at least ${this.opts.lamports} lamports to the boost recipient`,
        );
      }
      const hasMemo = ixs.some((ix) => ix.program === "spl-memo" && ix.parsed === stored.intent.memo);
      if (!hasMemo) return result("rejected", "Transaction memo does not match this boost intent");
      const lamports = Number(transfer.info!.lamports);
      const payer = typeof transfer.info!.source === "string" ? transfer.info!.source : null;

      // Global replay protection: a signature can back exactly one boost, ever.
      if (this.opts.db) {
        const claim = await this.opts.db.claimBoostSignature({
          signature,
          sessionId,
          trackId: stored.intent.trackId,
          intentId,
          payer,
          lamports,
          slot: tx.slot ?? null,
        });
        if (!claim.claimed) {
          return claim.intentId === intentId
            ? result("verified", undefined, session.getState())
            : result("rejected", "Signature already used for another boost");
        }
      }

      const outcome = await session.recordBoost({
        trackId: stored.intent.trackId,
        eventId: randomUUID(),
        participantId: stored.participantId,
        signature,
        lamports,
      });
      if (outcome.status === "rejected") {
        await this.opts.db?.releaseBoostSignature(signature).catch(() => {});
        return result(outcome.httpStatus >= 500 ? "unknown" : "rejected", outcome.reason);
      }
      this.usedSignatures.set(signature, intentId);
      stored.verifiedSignature = signature;
      return result("verified", undefined, outcome.state);
    } catch (err) {
      if (err instanceof RpcError) return result("unknown", "Solana RPC unavailable — boost not verified yet");
      log({ kind: "solana.verify_error", message: (err as Error).message });
      return result("unknown", "Verification error — boost not verified yet");
    } finally {
      this.inFlight.delete(signature);
    }
  }

  /** Remembers signatures restored from the database so replays stay blocked after restarts. */
  markUsed(signature: string, intentId = "restored") {
    this.usedSignatures.set(signature, intentId);
  }

  private async isDevnet(): Promise<boolean> {
    if (this.genesisOk == null) {
      this.genesisOk = (await this.rpc("getGenesisHash", [])) === DEVNET_GENESIS_HASH;
    }
    return this.genesisOk;
  }

  private sweep() {
    const cutoff = this.now() - 2 * INTENT_TTL_MS;
    for (const [id, i] of this.intents) if (i.createdAt < cutoff) this.intents.delete(id);
  }
}

export function httpStatusFor(status: BoostVerifyResult["status"]): number {
  return { verified: 200, pending: 202, rejected: 409, unknown: 503 }[status];
}
