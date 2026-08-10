import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 120000, // 2 min per test (WebContainer is slow)
  expect: {
    timeout: 10000, // 10s for assertions (override per-assertion as needed)
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // One worker EVERYWHERE, not just on CI. Nearly every test in this directory
  // boots its own WebContainer — a WASM runtime plus a ~10 MiB snapshot mount —
  // and each then waits up to 60s for the demo to report `Ready`. Run four of
  // those concurrently on a developer machine and the boots contend until some
  // of them blow that budget: measured here, a 4-worker run failed a different
  // homepage test on each of two consecutive attempts, while the identical
  // suite passed 19/19 at `--workers=1`. Parallelism buys a little wall clock
  // and costs determinism, so it is not worth having.
  //
  // CI already pinned this to 1; the previous CI-only spread is what let the
  // local suite drift into flakiness unnoticed.
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:4321',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:4321',
    reuseExistingServer:
      process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === '1' || !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
