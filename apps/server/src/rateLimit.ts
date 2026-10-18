// Sliding-window limiter: at most `limit` hits per `windowMs` per key. Keys are often chosen by
// clients (participant ids), so idle keys are swept out and the number of keys is capped —
// otherwise a script inventing a new key per request would grow memory without end.
const DEFAULT_MAX_KEYS = 50_000;

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private limit: number;
  private windowMs: number;
  private now: () => number;
  private maxKeys: number;
  private lastSweep = 0;

  constructor(limit: number, windowMs: number, now: () => number = Date.now, maxKeys = DEFAULT_MAX_KEYS) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.maxKeys = maxKeys;
  }

  allow(key: string): boolean {
    const t = this.now();
    this.sweep(t);
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    // Re-insert so the Map's order is "least recently used first" (for the cap below).
    this.hits.delete(key);
    this.hits.set(key, recent);
    while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value!);
    return true;
  }

  /** How many keys are tracked (for tests). */
  get size(): number {
    return this.hits.size;
  }

  private sweep(t: number) {
    if (t - this.lastSweep < this.windowMs) return;
    this.lastSweep = t;
    for (const [k, v] of this.hits) if (!v.length || t - v[v.length - 1] >= this.windowMs) this.hits.delete(k);
  }
}
