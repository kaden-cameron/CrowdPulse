import { useEffect, useRef, useState } from "react";
import {
  BOOST_VOTE_WEIGHT,
  MAX_BOOSTS_PER_TRACK,
  type BoostConfig,
  type BoostIntent,
  type BoostVerifyResult,
  type SessionState,
} from "@crowdpulse/shared";
import { getParticipantId } from "../lib/ws";
import {
  createBoostIntent,
  detectWallet,
  payWithWallet,
  waitForVerification,
} from "../lib/solana";

type Phase =
  | { kind: "loading" }
  | { kind: "ready"; intent: BoostIntent }
  | { kind: "paying"; intent: BoostIntent }
  | { kind: "checking"; intent: BoostIntent; result: BoostVerifyResult | null; signature: string }
  | { kind: "done"; intent: BoostIntent; result: BoostVerifyResult }
  | { kind: "error"; message: string };

const STATUS_TEXT: Record<BoostVerifyResult["status"], string> = {
  pending: "Waiting for devnet confirmation…",
  verified: "Verified on devnet ✓ Boost applied",
  rejected: "Rejected — no boost applied",
  unknown: "Can't reach Solana right now — still unverified",
};

export function BoostPanel({
  sessionId,
  trackId,
  trackTitle,
  config,
  blockedReason = null,
  onState,
  onClose,
}: {
  sessionId: string;
  trackId: string;
  trackTitle: string;
  config: BoostConfig;
  /** Set when boosting no longer makes sense (e.g. the track started playing). */
  blockedReason?: string | null;
  onState: (s: SessionState) => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [manualSig, setManualSig] = useState("");
  const wallet = detectWallet();
  // Stops verification polling (and its state updates) once the panel closes.
  const closed = useRef(new AbortController());
  useEffect(() => {
    const ctrl = new AbortController();
    closed.current = ctrl;
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    let cancelled = false;
    createBoostIntent(sessionId, trackId, getParticipantId())
      .then((intent) => !cancelled && setPhase({ kind: "ready", intent }))
      .catch((err) => !cancelled && setPhase({ kind: "error", message: (err as Error).message }));
    return () => {
      cancelled = true;
    };
  }, [sessionId, trackId]);

  async function check(intent: BoostIntent, signature: string) {
    const signal = closed.current.signal;
    if (signal.aborted) return;
    setPhase({ kind: "checking", intent, result: null, signature });
    const result: BoostVerifyResult = await waitForVerification(
      sessionId,
      intent.intentId,
      signature,
      (r) => setPhase({ kind: "checking", intent, result: r, signature }),
      { signal },
    ).catch((err): BoostVerifyResult => ({
      status: "unknown" as const,
      signature,
      reason: (err as Error).message,
      explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    }));
    if (signal.aborted) return;
    if (result.state) onState(result.state);
    setPhase({ kind: "done", intent, result });
  }

  async function pay(intent: BoostIntent) {
    if (!wallet) return;
    setPhase({ kind: "paying", intent });
    try {
      const signature = await payWithWallet(wallet, intent);
      await check(intent, signature);
    } catch (err) {
      setPhase({ kind: "error", message: `Wallet: ${(err as Error).message}` });
    }
  }

  const sol = (config.lamports / 1e9).toLocaleString(undefined, { maximumFractionDigits: 6 });
  const result = phase.kind === "checking" ? phase.result : phase.kind === "done" ? phase.result : null;
  const signature = phase.kind === "checking" ? phase.signature : result?.signature;

  return (
    <section className="boost-panel" aria-labelledby="boost-title">
      <div className="boost-head">
        <h2 id="boost-title">⚡ Boost “{trackTitle}”</h2>
        <button type="button" className="btn ghost compact" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="boost-note">
        <strong>Optional · Solana devnet · test SOL only.</strong> No real money. Voting stays free. A verified boost
        counts like {BOOST_VOTE_WEIGHT} extra votes (max {MAX_BOOSTS_PER_TRACK} boosts per track) and never overrides
        the host.
      </p>

      {phase.kind === "loading" && <p className="track-meta">Preparing boost…</p>}
      {phase.kind === "error" && <p className="feedback feedback-rejected">{phase.message}</p>}

      {phase.kind === "ready" && blockedReason && (
        <p className="feedback feedback-warn" role="status">
          {blockedReason}
        </p>
      )}

      {phase.kind === "ready" && !blockedReason && (
        <>
          {wallet ? (
            <button type="button" className="btn primary wide" onClick={() => pay(phase.intent)}>
              Pay {sol} devnet SOL with wallet
            </button>
          ) : (
            <p className="track-meta">
              No Solana wallet found in this browser. Use Phantom (set to devnet), or send it manually:
            </p>
          )}
          <details className="boost-manual" open={!wallet}>
            <summary>Send manually from any devnet wallet</summary>
            <dl>
              <dt>Amount</dt>
              <dd>{sol} SOL ({phase.intent.lamports.toLocaleString()} lamports) on devnet</dd>
              <dt>To</dt>
              <dd>
                <code>{phase.intent.recipient}</code>
              </dd>
              <dt>Memo (required, exactly)</dt>
              <dd>
                <code>{phase.intent.memo}</code>
              </dd>
            </dl>
            <label className="host-field">
              <span className="metric-label">Transaction signature</span>
              <input
                type="text"
                value={manualSig}
                onChange={(e) => setManualSig(e.target.value.trim())}
                placeholder="Paste the devnet signature"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              className="btn ghost"
              disabled={!manualSig}
              onClick={() => check(phase.intent, manualSig)}
            >
              Verify signature
            </button>
          </details>
          <p className="track-meta">
            Need test SOL? <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">faucet.solana.com</a>
          </p>
        </>
      )}

      {phase.kind === "paying" && <p className="feedback feedback-pending">Approve the transaction in your wallet…</p>}

      {(phase.kind === "checking" || phase.kind === "done") && (
        <div role="status" aria-live="polite">
          <p
            className={`feedback ${
              result?.status === "verified"
                ? "feedback-accepted"
                : result?.status === "rejected"
                  ? "feedback-rejected"
                  : "feedback-pending"
            }`}
          >
            {result ? STATUS_TEXT[result.status] : "Submitting to server…"}
            {result?.reason && result.status !== "verified" && <> — {result.reason}</>}
          </p>
          {signature && (
            <p className="track-meta">
              <a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">
                View on Solana Explorer (devnet)
              </a>
            </p>
          )}
          {phase.kind === "done" && result?.status !== "verified" && result?.status !== "rejected" && (
            <button type="button" className="btn ghost" onClick={() => check(phase.intent, phase.result.signature)}>
              Check again
            </button>
          )}
        </div>
      )}
    </section>
  );
}
