// Playwright runs against a real miner: the real upstream and the real chain.
//
// By default it starts the local server and tests that. Point E2E_BASE at the
// deployment to test what is actually serving:
//
//   E2E_BASE=https://amanat-miner.vercel.app npm run test:e2e
//
// One worker and no retries on purpose. These tests spend a free upstream's
// quota and read a rate-limited public RPC; running them four-wide would make
// the suite flaky for reasons that have nothing to do with the code, and a retry
// would hide it.

import { defineConfig, devices } from "@playwright/test";

const local = !process.env.E2E_BASE;

export default defineConfig({
  testDir: "./test",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],

  // Browser engines differ in layout, focus order and CSS support, so anything
  // that touches a page is worth running on all three. Nothing else is: the API
  // tests drive HTTP directly through the request fixture and would return the
  // identical bytes on every engine, so running them three times would only
  // spend a free upstream quota three times over.
  projects: [
    { name: "api", grepInvert: /@ui/, use: { ...devices["Desktop Chrome"] } },
    { name: "ui-chromium", grep: /@ui/, use: { ...devices["Desktop Chrome"] } },
    { name: "ui-firefox", grep: /@ui/, use: { ...devices["Desktop Firefox"] } },
    { name: "ui-webkit", grep: /@ui/, use: { ...devices["Desktop Safari"] } },
  ],
  use: {
    baseURL: process.env.E2E_BASE ?? "http://127.0.0.1:8799",
    trace: "retain-on-failure",
  },
  ...(local
    ? {
        webServer: {
          command: "node miner/server.mjs",
          url: "http://127.0.0.1:8799/health",
          env: { PORT: "8799" },
          reuseExistingServer: true,
          timeout: 30_000,
        },
      }
    : {}),
});
