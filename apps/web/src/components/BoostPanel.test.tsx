import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoostPanel } from "./BoostPanel";

const intent = {
  intentId: "11111111-2222-4333-8444-555555555555",
  sessionId: "demo",
  trackId: "track_02",
  cluster: "devnet",
  rpcUrl: "https://api.devnet.solana.com",
  recipient: "8g252KfhTk3V5Mif13DLamq97L4ZbXDcyR2UzY6u4TK6",
  lamports: 1_000_000,
  memo: "crowdpulse:demo:track_02:11111111-2222-4333-8444-555555555555",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};
const config = { enabled: true, cluster: "devnet" as const, lamports: 1_000_000, recipient: intent.recipient };

function mockServer(verifyStatus: "verified" | "rejected" | "pending") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/boosts/intents")) return new Response(JSON.stringify(intent), { status: 201 });
      const body = { status: verifyStatus, signature: "sig", reason: verifyStatus === "rejected" ? "Transaction memo does not match this boost intent" : undefined, explorerUrl: "x" };
      return new Response(JSON.stringify(body), { status: verifyStatus === "verified" ? 200 : verifyStatus === "pending" ? 202 : 409 });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

const renderPanel = () =>
  render(
    <BoostPanel sessionId="demo" trackId="track_02" trackTitle="Midnight Cypress" config={config} onState={() => {}} onClose={() => {}} />,
  );

describe("BoostPanel", () => {
  it("labels boosts as optional devnet test SOL and shows manual instructions without a wallet", async () => {
    mockServer("verified");
    renderPanel();
    expect(screen.getByText(/Optional · Solana devnet · test SOL only/)).toBeInTheDocument();
    expect(await screen.findByText(intent.memo)).toBeInTheDocument();
    expect(screen.getByText(intent.recipient)).toBeInTheDocument();
  });

  it("SOL-02: only reports success after the server verifies", async () => {
    mockServer("verified");
    renderPanel();
    await userEvent.type(await screen.findByPlaceholderText(/Paste the devnet signature/), "5abc");
    await userEvent.click(screen.getByRole("button", { name: "Verify signature" }));
    expect(await screen.findByText(/Verified on devnet ✓/)).toBeInTheDocument();
  });

  it("shows the server's rejection reason and no success", async () => {
    mockServer("rejected");
    renderPanel();
    await userEvent.type(await screen.findByPlaceholderText(/Paste the devnet signature/), "5abc");
    await userEvent.click(screen.getByRole("button", { name: "Verify signature" }));
    expect(await screen.findByText(/memo does not match/)).toBeInTheDocument();
    expect(screen.queryByText(/Verified on devnet/)).toBeNull();
  });
});
