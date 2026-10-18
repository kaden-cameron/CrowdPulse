import { describe, expect, it, vi } from "vitest";
import { SpotifyPlayer, type SdkState, type SpotifySdk } from "./spotifyPlayer";

const URI = "spotify:track:4uLU6hMCjMI75M1A2tKUQC";
const track = { id: "song_1", title: "Real Song", artist: "Real Artist", genre: "house", bpm: 124, energy: 0.8 };
const state = (over: Partial<SdkState> & { uri?: string; prev?: string[] } = {}): SdkState => ({
  paused: false,
  position: 1000,
  duration: 200_000,
  track_window: {
    current_track: over.uri === "" ? null : { uri: over.uri ?? URI, duration_ms: 200_000 },
    previous_tracks: (over.prev ?? []).map((uri) => ({ uri })),
  },
  ...over,
});

/** Fake Web Playback SDK: emits "ready", lets the test push state changes. */
function fakeSdk(opts: { accountError?: boolean } = {}) {
  const listeners: Record<string, ((arg: unknown) => void)[]> = {};
  const pause = vi.fn(async () => {});
  const resume = vi.fn(async () => {});
  const sdk: SpotifySdk = {
    Player: class {
      addListener(ev: string, cb: (arg: never) => void) {
        (listeners[ev] ??= []).push(cb as (arg: unknown) => void);
      }
      async connect() {
        setTimeout(() => {
          if (opts.accountError) listeners.account_error?.forEach((cb) => cb({ message: "Premium required" }));
          else listeners.ready?.forEach((cb) => cb({ device_id: "dev123" }));
        }, 0);
        return true;
      }
      disconnect() {}
      pause = pause;
      resume = resume;
      async setVolume() {}
      async activateElement() {}
    } as unknown as SpotifySdk["Player"],
  };
  return {
    sdk,
    pause,
    resume,
    emit: (s: SdkState | null) => listeners.player_state_changed?.forEach((cb) => cb(s)),
    fire: (ev: string, arg: unknown) => listeners[ev]?.forEach((cb) => cb(arg)),
  };
}

function setup(apiImpl?: (url: string, init?: RequestInit) => Response, sdkOpts = {}) {
  const f = fakeSdk(sdkOpts);
  const calls: { url: string; init?: RequestInit }[] = [];
  const api = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return apiImpl ? apiImpl(url, init) : new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const player = new SpotifyPlayer({ getToken: async () => "tok", loadSdk: async () => f.sdk, api });
  return { player, calls, ...f };
}

describe("SpotifyPlayer", () => {
  it("plays the catalog's URI on this tab's device and reports Spotify's duration", async () => {
    const { player, calls, emit } = setup();
    await player.unlock();
    const p = player.play({ ...track, spotifyUri: URI }, { startAtMs: 5000 });
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].url).toBe("https://api.spotify.com/v1/me/player/play?device_id=dev123");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ uris: [URI], position_ms: 5000 });
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe("Bearer tok");
    emit(state());
    expect(await p).toEqual({ durationMs: 200_000, source: "spotify" });
  });

  it("finds a track by title + artist when the catalog has no URI", async () => {
    const { player, calls, emit } = setup((url) =>
      url.includes("/search") ? Response.json({ tracks: { items: [{ uri: URI }] } }) : new Response(null, { status: 204 }),
    );
    await player.unlock();
    const p = player.play(track);
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(decodeURIComponent(calls[0].url)).toContain('q=track:"Real Song" artist:"Real Artist"');
    emit(state());
    await p;
  });

  it("says clearly when a song isn't on Spotify", async () => {
    const { player } = setup(() => Response.json({ tracks: { items: [] } }));
    await player.unlock();
    await expect(player.play(track)).rejects.toThrow(/wasn't found on Spotify/);
  });

  it("explains a 403 (Premium / app user list)", async () => {
    const { player } = setup(() => Response.json({ error: { message: "Forbidden" } }, { status: 403 }));
    await player.unlock();
    await expect(player.play({ ...track, spotifyUri: URI })).rejects.toThrow(/Premium required/);
  });

  it("detects the end of the track and pauses so Spotify doesn't autoplay something else", async () => {
    const { player, emit, pause, calls } = setup();
    const ended = vi.fn();
    player.onEnded(ended);
    await player.unlock();
    const p = player.play({ ...track, spotifyUri: URI });
    await vi.waitFor(() => expect(calls.length).toBe(1)); // Spotify reports state after the play request
    emit(state());
    await p;
    emit(state({ position: 150_000 })); // still playing: not ended
    expect(ended).not.toHaveBeenCalled();
    emit(state({ position: 197_000 })); // the last seconds
    emit(state({ paused: true, position: 0, uri: "", prev: [URI] })); // Spotify's end-of-track state
    expect(ended).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalled();
    emit(state({ paused: true, position: 0, uri: "", prev: [URI] })); // repeated event: still once
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("treats Spotify moving on to another song (autoplay) as the end", async () => {
    const { player, emit, calls } = setup();
    const ended = vi.fn();
    player.onEnded(ended);
    await player.unlock();
    const p = player.play({ ...track, spotifyUri: URI });
    await vi.waitFor(() => expect(calls.length).toBe(1));
    emit(state());
    await p;
    emit(state({ position: 198_000 }));
    emit(state({ uri: "spotify:track:0000000000000000000000" }));
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("a non-Premium account fails at Start audio with a clear message", async () => {
    const { player } = setup(undefined, { accountError: true });
    await expect(player.unlock()).rejects.toThrow(/Spotify Premium is required/);
  });
});

describe("SpotifyPlayer reconnects (start → stop → start)", () => {
  it("picks up Spotify's reconnect after the device drops, and plays on the new device id", async () => {
    const { player, calls, emit, fire } = setup();
    await player.unlock();
    player.stop();
    fire("not_ready", { device_id: "dev123" });
    fire("ready", { device_id: "dev456" }); // Spotify brings the device back
    await player.unlock(); // Start audio again: no new connection needed
    const p = player.play({ ...track, spotifyUri: URI });
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].url).toBe("https://api.spotify.com/v1/me/player/play?device_id=dev456");
    emit(state());
    await p;
  });

  it("a refused play (no Premium) is a player problem, not a bad song", async () => {
    const { player } = setup(() => Response.json({ error: { message: "Premium required" } }, { status: 403 }));
    await player.unlock();
    const err = await player.play({ ...track, spotifyUri: URI }).catch((e: Error & { playerUnavailable?: boolean }) => e);
    expect(err).toMatchObject({ playerUnavailable: true });
  });

  it("seek moves Spotify to the new position", async () => {
    const { player, calls, emit } = setup();
    await player.unlock();
    const p = player.play({ ...track, spotifyUri: URI });
    await vi.waitFor(() => expect(calls.length).toBe(1));
    emit(state());
    await p;
    await player.seek(61_000);
    expect(calls[1].url).toBe("https://api.spotify.com/v1/me/player/seek?position_ms=61000&device_id=dev123");
    expect(calls[1].init?.method).toBe("PUT");
  });
});

describe("SpotifyPlayer: a song that stops right away isn't 'finished'", () => {
  async function started() {
    const ctx = setup();
    const ended = vi.fn();
    const problem = vi.fn();
    ctx.player.onEnded(ended);
    ctx.player.onProblem(problem);
    await ctx.player.unlock();
    const p = ctx.player.play({ ...track, spotifyUri: URI });
    await vi.waitFor(() => expect(ctx.calls.length).toBe(1));
    ctx.emit(state({ position: 0 }));
    await p;
    return { ...ctx, ended, problem };
  }

  it("an early 'paused at 0:00' (Spotify loading or no audio) resumes instead of skipping", async () => {
    const { emit, ended, problem, resume } = await started();
    emit(state({ paused: true, position: 0 }));
    expect(ended).not.toHaveBeenCalled();
    expect(problem).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledOnce();
    emit(state({ position: 3_000 })); // it plays after all
    emit(state({ position: 60_000 }));
    expect(ended).not.toHaveBeenCalled();
  });

  it("stopping early again is reported as a problem, never as the song finishing", async () => {
    const { emit, ended, problem } = await started();
    emit(state({ paused: true, position: 0 }));
    emit(state({ paused: true, position: 0 }));
    expect(ended).not.toHaveBeenCalled();
    expect(problem).toHaveBeenCalledOnce();
    expect(problem.mock.calls[0][0]).toMatch(/Spotify stopped “Real Song” after 0s/);
  });

  it("a mid-song pause (someone paused Spotify) is left alone", async () => {
    const { emit, ended, problem } = await started();
    emit(state({ position: 60_000 }));
    emit(state({ paused: true, position: 61_000 }));
    expect(ended).not.toHaveBeenCalled();
    expect(problem).not.toHaveBeenCalled();
  });

  it("ignores states while Spotify is still loading", async () => {
    const { emit, ended, problem, resume } = await started();
    emit(state({ paused: true, position: 0, loading: true }));
    expect(ended).not.toHaveBeenCalled();
    expect(problem).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });
});

describe("SpotifyPlayer hold (host pressed ⏸)", () => {
  it("a paused-at-0:00 state while held is not a problem or an ending", async () => {
    const ctx = setup();
    const ended = vi.fn();
    const problem = vi.fn();
    ctx.player.onEnded(ended);
    ctx.player.onProblem(problem);
    await ctx.player.unlock();
    const p = ctx.player.play({ ...track, spotifyUri: URI });
    await vi.waitFor(() => expect(ctx.calls.length).toBe(1));
    ctx.emit(state({ position: 0 }));
    await p;
    await ctx.player.hold();
    expect(ctx.pause).toHaveBeenCalled();
    ctx.emit(state({ paused: true, position: 0 }));
    ctx.emit(state({ paused: true, position: 0 }));
    expect(ended).not.toHaveBeenCalled();
    expect(problem).not.toHaveBeenCalled();
    await ctx.player.unhold();
    expect(ctx.resume).toHaveBeenCalled();
  });
});
