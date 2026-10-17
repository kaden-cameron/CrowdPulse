import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { VisualState } from "@crowdpulse/shared";
import { StageCanvas } from "./StageCanvas";

const canvas = (container: HTMLElement) => container.querySelector("canvas")!;

describe("StageCanvas", () => {
  it("renders a known theme and intensity from valid visual state", () => {
    const { container } = render(
      <StageCanvas visual={{ theme: "neon_pulse", intensity: 0.8 }} />,
    );
    expect(canvas(container)).toHaveAttribute("data-theme", "neon_pulse");
    expect(canvas(container)).toHaveAttribute("data-intensity", "0.8");
  });

  it("falls back to calm_waves for unknown themes and clamps intensity", () => {
    const bad = { theme: "url(javascript:alert(1))", intensity: 7 } as unknown as VisualState;
    const { container } = render(<StageCanvas visual={bad} />);
    expect(canvas(container)).toHaveAttribute("data-theme", "calm_waves");
    expect(canvas(container)).toHaveAttribute("data-intensity", "1");
  });

  it("dims when paused", () => {
    const { container } = render(
      <StageCanvas visual={{ theme: "sunset", intensity: 0.5 }} paused />,
    );
    expect(canvas(container)).toHaveClass("paused");
  });
});
