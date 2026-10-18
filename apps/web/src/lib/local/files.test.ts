import { describe, expect, it } from "vitest";
import { guessFromName, localIdFor } from "./files";

describe("local files", () => {
  it("the same file always gets the same id", () => {
    const a = localIdFor({ name: "One More Time.mp3", size: 1234 });
    expect(a).toMatch(/^lf_[0-9a-f]{16}$/);
    expect(localIdFor({ name: "One More Time.mp3", size: 1234 })).toBe(a);
    expect(localIdFor({ name: "One More Time.mp3", size: 1235 })).not.toBe(a);
  });

  it("guesses artist and title from the file name", () => {
    expect(guessFromName("03 - Daft Punk - One More Time.mp3")).toEqual({ artist: "Daft Punk", title: "One More Time" });
    expect(guessFromName("Kaytranada – Glowed Up.flac")).toEqual({ artist: "Kaytranada", title: "Glowed Up" });
    expect(guessFromName("07 Untitled.wav")).toEqual({ artist: "Unknown artist", title: "Untitled" });
  });
});
