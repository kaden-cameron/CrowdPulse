import { useEffect, useState } from "react";

// Album cover for a library song that was added before covers were saved: the server looks it up
// on Spotify (client credentials) and caches it. Remembered per tab so each song is asked once.

const seen = new Map<string, string | null>();

export function useSpotifyCover(spotifyUri: string | undefined, known: string | undefined): string | undefined {
  const id = !known ? spotifyUri?.match(/^spotify:track:([A-Za-z0-9]{22})$/)?.[1] : undefined;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!id || seen.has(id)) return;
    let cancelled = false;
    fetch(`/api/spotify/cover/${id}`)
      .then((r) => (r.ok ? r.json() : { imageUrl: null }))
      .then((d: { imageUrl?: string | null }) => {
        seen.set(id, d.imageUrl ?? null);
        if (!cancelled) setTick((n) => n + 1);
      })
      .catch(() => {
        /* no cover — the placeholder stays */
      });
    return () => {
      cancelled = true;
    };
  }, [id]);
  return known ?? (id ? (seen.get(id) ?? undefined) : undefined);
}
