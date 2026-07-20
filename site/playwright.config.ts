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
  workers: process.env.CI ? 1 : undefined,
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
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
    // Astro 7's `astro dev` daemonizes and exits 0 whenever it thinks it was
    // launched by an agent — `am-i-vibing` sniffs CLAUDECODE/CURSOR_TRACE_ID/etc
    // and Astro then forces `--background` (see astro/dist/cli/dev/index.js).
    // Playwright treats that exit as "process exited early" and fails every
    // test in this suite before it starts. `ASTRO_DEV_BACKGROUND` is the flag
    // Astro sets on its own daemon child, and its presence short-circuits the
    // agent sniff, so setting it here pins the foreground path. There is no
    // `--no-background` equivalent: that flag only clears `flags.background`
    // and leaves agent detection to re-enable daemonizing.
    env: { ASTRO_DEV_BACKGROUND: '1' },
  },
});
