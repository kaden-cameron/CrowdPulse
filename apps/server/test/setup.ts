import path from "node:path";
import { fileURLToPath } from "node:url";

// Same repo-root .env the server uses; integration tests skip when DATABASE_URL is absent.
try {
  process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env"));
} catch {
  /* no .env */
}
