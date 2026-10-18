import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Attendee ids are handed out by the server and signed, so a script can't invent new ids to get
// around the per-person vote limit. How many ids one address may get is limited (generously: a
// whole venue may share one Wi-Fi address). Format: "ps_" + 24 hex (random) + "_" + 16 hex (HMAC).
// The demo crowd simulator gets "sim_…" ids the same way (counted as demo data).

const ID = /^(ps|sim)_([0-9a-f]{24})_([0-9a-f]{16})$/;

export class ParticipantIds {
  private secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  issue(simulated = false): string {
    const prefix = simulated ? "sim" : "ps";
    const r = randomBytes(12).toString("hex");
    return `${prefix}_${r}_${this.sign(`${prefix}:${r}`)}`;
  }

  valid(id: string): boolean {
    const m = ID.exec(id);
    if (!m) return false;
    const want = Buffer.from(this.sign(`${m[1]}:${m[2]}`));
    const got = Buffer.from(m[3]);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  private sign(r: string): string {
    return createHmac("sha256", this.secret).update(`participant:${r}`).digest("hex").slice(0, 16);
  }
}
