import { useEffect, useState } from "react";

// A song's album cover at full size (640 px). Songs saved before covers were stored large have a
// 300 px link (blurry when shown big on a sharp screen), and Spotify's image links can't be
// converted between sizes — so the server looks the big one up once per song (client credentials,
// cached). Until it arrives (or if it can't), the saved cover shows. Remembered per tab.

const seen = new Map<string, string | null>();

export function useSpotifyCover(spotifyUri: string | undefined, known: string | undefined): string | undefined {
  const id = spotifyUri?.match(/^spotify:track:([A-Za-z0-9]{22})$/)?.[1];
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
        /* no lookup — the saved cover (or placeholder) stays */
      });
    return () => {
      cancelled = true;
    };
  }, [id]);
  return (id ? seen.get(id) : undefined) ?? known;
}
