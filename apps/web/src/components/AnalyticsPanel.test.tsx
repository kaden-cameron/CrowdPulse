import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SessionMetrics } from "@crowdpulse/shared";
import { AnalyticsPanel } from "./AnalyticsPanel";

const now = new Date("2026-10-17T01:00:00Z");
const at = (secondsAgo: number) => new Date(now.getTime() - secondsAgo * 1000).toISOString();

const tiger: SessionMetrics = {
  persistence: "tigerdata",
  generatedAt: now.toISOString(),
  queryMs: 12.3,
  latestEventAt: at(2),
  eventsLast10s: 4,
  totalEvents: 57,
  votesByTrack: [
    { trackId: "track_07", votes: 5 },
    { trackId: "track_01", votes: 2 },
  ],
  buckets: [
    { bucket: at(30), eventCount: 6, votes: 2, taps: 10, avgEnergy: 55, source: "aggregate" },
    { bucket: at(5), eventCount: 3, votes: 1, taps: 0, avgEnergy: 61, source: "raw" },
  ],
  aggregate: { latestBucket: at(30), lagSeconds: 23 },
};

describe("AnalyticsPanel", () => {
  it("says persistence is off in memory mode instead of showing fake metrics", () => {
    render(<AnalyticsPanel metrics={{ persistence: "memory" }} error={null} tracks={[]} />);
    expect(screen.getByText("Persistence off")).toBeInTheDocument();
  });

  it("TD-05: shows SQL-backed counts, freshness, and both chart sources", () => {
    render(
      <AnalyticsPanel
        metrics={tiger}
        error={null}
        tracks={[{ id: "track_07", title: "Stage Lightning", artist: "DJ Hydra", genre: "dnb", bpm: 174, energy: 0.95, votes: 0, boosts: 0, status: "open" }]}
      />,
    );
    expect(screen.getByText("57")).toBeInTheDocument();
    expect(screen.getByText("23s behind newest event")).toBeInTheDocument();
    expect(screen.getByText("Stage Lightning")).toBeInTheDocument();
    expect(screen.getByText(/Raw \(not yet aggregated\)/)).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2 buckets in the table view
  });

  it("TD-07: keeps the last good data visible when a poll fails", () => {
    render(<AnalyticsPanel metrics={tiger} error="Metrics unavailable" tracks={[]} />);
    expect(screen.getByRole("alert")).toHaveTextContent("showing the last good result");
    expect(screen.getByText("57")).toBeInTheDocument();
  });
});
