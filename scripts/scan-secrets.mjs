// AU-07 / VU-05: scan the built frontend and the repo for secret-looking values.
// Usage: npm run scan:secrets   (build the web app first so apps/web/dist exists)
// Covers committed files plus new files that aren't git-ignored; .env is ignored and never scanned.
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PATTERNS = [
  ["Google API key", /AIza[0-9A-Za-z_-]{30,}/],
  ["Postgres URL with password", /postgres(?:ql)?:\/\/[^\s:@/"'`]+:[^\s@"'`…]+@/],
  // Requires a base64 key body, so libraries that merely check for the PEM header don't match.
  ["Private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=\s]{64,}/],
  ["Solana keypair array", /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/],
  ["Auth0 client secret assignment", /AUTH0_CLIENT_SECRET\s*[=:]\s*["']?[A-Za-z0-9_-]{20,}/],
  ["JWT literal", /eyJhbGciOi[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  // Real values only — documented placeholders (change-me, <...>, values elided with …) are fine.
  ["Env file value", /^(?:DATABASE_URL|GEMINI_API_KEY|HOST_DEV_KEY|AUTH0_CLIENT_SECRET)=(?!change-me\b|<)[^\s…]+$/m],
];

const files = [];
const dist = path.join(root, "apps/web/dist");
if (existsSync(dist)) {
  const walk = (d) =>
    readdirSync(d).forEach((f) => {
      const p = path.join(d, f);
      statSync(p).isDirectory() ? walk(p) : files.push(p);
    });
  walk(dist);
} else {
  console.warn("apps/web/dist not found — run `npm run build` first to scan the bundle.");
}
const tracked = execSync("git ls-files --cached --others --exclude-standard", { cwd: root })
  .toString()
  .split("\n")
  .filter((f) => f && !f.endsWith("package-lock.json") && !f.startsWith("scripts/scan-secrets"));
for (const f of tracked) files.push(path.join(root, f));

let hits = 0;
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  for (const [name, re] of PATTERNS) {
    const m = text.match(re);
    if (m) {
      hits++;
      // Print only a short prefix so a real secret never ends up in logs.
      console.log(`✗ ${name} in ${path.relative(root, f)}: ${m[0].slice(0, 10)}…`);
    }
  }
}
console.log(
  `${hits ? "FAIL" : "PASS"}: scanned ${files.length} files (${existsSync(dist) ? "web bundle + " : ""}repo), ${hits} finding(s)`,
);
process.exit(hits ? 1 : 0);
