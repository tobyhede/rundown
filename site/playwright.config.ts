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
  // Spread rather than `workers: process.env.CI ? 1 : undefined`: omitting the
  // key and setting it to `undefined` mean the same thing to Playwright (fall
  // back to its default), but only the former is legal under
  // `exactOptionalPropertyTypes`.
  ...(process.env.CI ? { workers: 1 } : {}),
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
