import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalPlayer } from "./localPlayer";

const files = new Map<string, File>();
vi.mock("../local/files", () => ({ localFile: (id: string) => files.get(id) }));

const param = () => ({ value: 0, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} });
const node = () => ({ connect: (n: unknown) => n });

/** Minimal Web Audio stand-in: the real graph doesn't matter here, only the audio elements. */
class FakeAudioContext {
  state = "running";
  currentTime = 0;
  destination = {};
  createGain() {
    return { ...node(), gain: param() };
  }
  createDynamicsCompressor() {
    return { ...node(), threshold: param(), ratio: param() };
  }
  createMediaElementSource() {
    return node();
  }
  async resume() {}
  async close() {}
}

const track = { id: "lf_0123456789abcdef", title: "Mine", artist: "Me", genre: "", bpm: 0, energy: 0, source: "local" as const };
const elements: HTMLAudioElement[] = [];

beforeEach(() => {
  elements.length = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  // jsdom has no object URLs.
  URL.createObjectURL ??= () => "blob:x";
  URL.revokeObjectURL ??= () => {};
  const RealAudio = window.Audio;
  vi.stubGlobal(
    "Audio",
    class {
      constructor() {
        const el = new RealAudio();
        Object.defineProperty(el, "duration", { value: 180 });
        let paused = true;
        Object.defineProperty(el, "paused", { get: () => paused });
        el.play = async () => {
          paused = false;
        };
        el.pause = () => {
          paused = true;
        };
        elements.push(el);
        return el;
      }
    },
  );
  files.set(track.id, new File(["x"], "mine.mp3"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  files.clear();
});

/** The next play() loads into whichever slot is idle: answer it with loadedmetadata. */
const loaded = async () => {
  await vi.waitFor(() => expect(elements.some((e) => e.getAttribute("src"))).toBe(true));
  for (const e of elements) if (e.getAttribute("src")) e.dispatchEvent(new Event("loadedmetadata"));
};

describe("LocalPlayer", () => {
  it("reports a file that breaks mid-song, so the party doesn't just go quiet", async () => {
    const p = new LocalPlayer();
    const problems: string[] = [];
    p.onProblem((m) => problems.push(m));
    await p.unlock();
    const playing = p.play(track);
    await loaded();
    expect(await playing).toEqual({ durationMs: 180_000, source: "file" });
    const active = elements.find((e) => !e.paused)!;
    active.dispatchEvent(new Event("error"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Mine/);
  });

  it("stopping during a load is a quiet cancel, not a failed song", async () => {
    const p = new LocalPlayer();
    await p.unlock();
    const playing = p.play(track);
    p.stop();
    await loaded();
    await expect(playing).rejects.toMatchObject({ cancelled: true });
  });

  it("a song whose file isn't linked (after a reload) stops the speaker instead of failing the song", async () => {
    const p = new LocalPlayer();
    await p.unlock();
    files.clear();
    await expect(p.play(track)).rejects.toMatchObject({ playerUnavailable: true, message: expect.stringMatching(/re-link/) });
  });
});
