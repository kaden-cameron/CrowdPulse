import { useEffect, useRef } from "react";
import type { VisualState } from "@crowdpulse/shared";

type ThemePalette = {
  bg0: string;
  bg1: string;
  accent: string;
  accent2: string;
  particle: string;
};

const THEMES: Record<VisualState["theme"], ThemePalette> = {
  calm_waves: {
    bg0: "#04131c",
    bg1: "#0b3a4a",
    accent: "#5ec4c8",
    accent2: "#9ad8c8",
    particle: "rgba(157, 220, 210, 0.75)",
  },
  neon_pulse: {
    bg0: "#0a0612",
    bg1: "#1a0a2e",
    accent: "#3ddc97",
    accent2: "#ff6b4a",
    particle: "rgba(61, 220, 151, 0.85)",
  },
  sunset: {
    bg0: "#1a0b08",
    bg1: "#4a1d12",
    accent: "#ff8a4c",
    accent2: "#ffd29a",
    particle: "rgba(255, 180, 110, 0.8)",
  },
  electric_blue: {
    bg0: "#030914",
    bg1: "#0a2548",
    accent: "#4db7ff",
    accent2: "#7ad7f0",
    particle: "rgba(100, 190, 255, 0.85)",
  },
};

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
};

/** Only allowlisted themes render; intensity is clamped to 0–1. */
export function sanitizeVisual(visual: VisualState): VisualState {
  return {
    theme: visual.theme in THEMES ? visual.theme : "calm_waves",
    intensity: Math.max(0, Math.min(1, Number(visual.intensity) || 0)),
  };
}

export function StageCanvas({
  visual,
  paused = false,
}: {
  visual: VisualState;
  /** Freeze motion when data is stale so we never animate fake "live" activity. */
  paused?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const safe = sanitizeVisual(visual);
  const visualRef = useRef(safe);
  visualRef.current = safe;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let raf = 0;
    let w = 0;
    let h = 0;
    let particles: Particle[] = [];
    let t = 0;

    const resize = () => {
      const parent = canvas.parentElement;
      w = parent?.clientWidth ?? window.innerWidth;
      h = parent?.clientHeight ?? window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const spawn = (count: number) => {
      const palette = THEMES[visualRef.current.theme];
      for (let i = 0; i < count; i++) {
        const speed = 0.2 + visualRef.current.intensity * 1.8;
        particles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * speed,
          vy: (Math.random() - 0.5) * speed - visualRef.current.intensity,
          r: 1 + Math.random() * (2 + visualRef.current.intensity * 3),
          life: 0.4 + Math.random() * 0.6,
        });
        void palette;
      }
    };

    const draw = () => {
      if (pausedRef.current) {
        raf = requestAnimationFrame(draw);
        return;
      }
      const v = visualRef.current;
      const palette = THEMES[v.theme];
      t += 0.008 + v.intensity * 0.02;

      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, palette.bg0);
      grad.addColorStop(1, palette.bg1);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // soft orb
      const orbX = w * (0.5 + Math.sin(t * 0.7) * 0.08);
      const orbY = h * (0.42 + Math.cos(t * 0.5) * 0.06);
      const orbR = Math.min(w, h) * (0.18 + v.intensity * 0.12);
      const orb = ctx.createRadialGradient(orbX, orbY, 0, orbX, orbY, orbR);
      orb.addColorStop(0, `${palette.accent}88`);
      orb.addColorStop(0.45, `${palette.accent2}33`);
      orb.addColorStop(1, "transparent");
      ctx.fillStyle = orb;
      ctx.beginPath();
      ctx.arc(orbX, orbY, orbR, 0, Math.PI * 2);
      ctx.fill();

      // ring pulse
      ctx.strokeStyle = `${palette.accent}55`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(
        orbX,
        orbY,
        orbR * (0.7 + Math.sin(t * 2) * 0.05 * v.intensity),
        0,
        Math.PI * 2,
      );
      ctx.stroke();

      if (!reducedMotion) {
        const targetCount = Math.floor(18 + v.intensity * 90);
        if (particles.length < targetCount) spawn(4);
        if (particles.length > targetCount + 20) {
          particles = particles.slice(0, targetCount);
        }

        ctx.fillStyle = palette.particle;
        particles = particles.filter((p) => {
          p.x += p.vx;
          p.y += p.vy;
          p.life -= 0.003 + v.intensity * 0.004;
          if (p.x < 0 || p.x > w || p.y < 0 || p.y > h || p.life <= 0) {
            return false;
          }
          ctx.globalAlpha = Math.max(0, p.life);
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
          return true;
        });
        ctx.globalAlpha = 1;
      }

      raf = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener("resize", resize);
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={`stage-canvas${paused ? " paused" : ""}`}
      data-theme={safe.theme}
      data-intensity={safe.intensity}
      aria-hidden
    />
  );
}
