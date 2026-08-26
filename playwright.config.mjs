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

import { defineConfig } from "@playwright/test";

const local = !process.env.E2E_BASE;

export default defineConfig({
  testDir: "./test",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
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
