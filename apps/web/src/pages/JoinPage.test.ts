import { describe, expect, it } from "vitest";
import { filterAndRank, PAGE_SIZE } from "./JoinPage";

const t = (title: string, votes: number, extra: Partial<{ artist: string; genre: string; boosts: number; status: string }> = {}) => ({
  title,
  artist: extra.artist ?? "A",
  genre: extra.genre ?? "pop",
  votes,
  boosts: extra.boosts ?? 0,
  status: extra.status ?? "open",
});

describe("attendee vote list", () => {
  it("shows the playing song, then most votes first (boosts break ties, then library order)", () => {
    const list = filterAndRank([t("Low", 1), t("Top", 5), t("Tie B", 2), t("Tie A", 2, { boosts: 1 }), t("Now", 0, { status: "playing" })], "");
    expect(list.map((x) => x.title)).toEqual(["Now", "Top", "Tie A", "Tie B", "Low"]);
  });

  it("searches title, artist and genre", () => {
    const tracks = [t("Levels", 0, { artist: "Avicii", genre: "edm" }), t("Strobe", 0, { artist: "deadmau5", genre: "house" })];
    expect(filterAndRank(tracks, "avicii").map((x) => x.title)).toEqual(["Levels"]);
    expect(filterAndRank(tracks, "HOUSE").map((x) => x.title)).toEqual(["Strobe"]);
    expect(filterAndRank(tracks, "zzz")).toEqual([]);
  });

  it("pages hold 15 songs", () => {
    expect(PAGE_SIZE).toBe(15);
  });
});

describe("attendee sort", () => {
  const list = [t("b song", 1, { artist: "Zed", genre: "pop" }), t("A song", 5, { artist: "amy", genre: "house" }), t("c song", 0, { artist: "Bob", genre: "edm", status: "playing" })];
  it("sorts by title, artist, genre or newest, keeping the playing song first", () => {
    const titles = (s: Parameters<typeof filterAndRank>[2]) => filterAndRank(list, "", s).map((x) => x.title);
    expect(titles("votes")).toEqual(["c song", "A song", "b song"]);
    expect(titles("title")).toEqual(["c song", "A song", "b song"]);
    expect(titles("artist")).toEqual(["c song", "A song", "b song"]);
    expect(titles("genre")).toEqual(["c song", "A song", "b song"]);
    expect(titles("newest")).toEqual(["c song", "A song", "b song"]);
    const notPlaying = list.map((x) => ({ ...x, status: "open" }));
    expect(filterAndRank(notPlaying, "", "newest").map((x) => x.title)).toEqual(["c song", "A song", "b song"]);
    expect(filterAndRank(notPlaying, "", "artist").map((x) => x.title)).toEqual(["A song", "c song", "b song"]);
    expect(filterAndRank(notPlaying, "", "genre").map((x) => x.title)).toEqual(["c song", "A song", "b song"]);
    expect(filterAndRank(notPlaying, "", "title").map((x) => x.title)).toEqual(["A song", "b song", "c song"]);
  });
});
