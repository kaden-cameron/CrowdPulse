import { defineConfig, devices } from "@playwright/test";

// Browser E2E for the core loop (Doc 08). Starts its own isolated server + web app:
// in-memory, no Gemini/Auth0/Solana, dev host key — so runs are repeatable and never
// touch the real database. Screenshots land in /evidence/frontend.
const API_PORT = 8790;
const WEB_PORT = 5190;
const isolatedEnv = {
  PORT: String(API_PORT),
  DATABASE_URL: "",
  GEMINI_API_KEY: "",
  AUTH0_DOMAIN: "",
  AUTH0_AUDIENCE: "",
  BOOST_RECIPIENT: "",
  HOST_DEV_KEY: "e2e-host-key",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: "npm start --workspace=@crowdpulse/server",
      cwd: "../..",
      url: `http://localhost:${API_PORT}/api/health`,
      env: isolatedEnv,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      env: { PORT: String(API_PORT) },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
