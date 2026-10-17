import { useEffect, useState } from "react";

export interface PublicConfig {
  publicUrl: string | null;
  lanIp: string | null;
  spotifyClientId: string | null;
  /** True when the server can search Spotify for everyone (Client Credentials). */
  spotifySearch: boolean;
}

let cached: Promise<PublicConfig> | null = null;

/** Public server settings (no secrets): public URL, dev LAN IP, Spotify Client ID. */
export function fetchPublicConfig(): Promise<PublicConfig> {
  cached ??= fetch("/api/public-config")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .catch((err) => {
      cached = null;
      throw err;
    });
  return cached;
}

export function usePublicConfig(): PublicConfig | null {
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  useEffect(() => {
    fetchPublicConfig().then(setCfg, () =>
      setCfg({ publicUrl: null, lanIp: null, spotifyClientId: null, spotifySearch: false }),
    );
  }, []);
  return cfg;
}
