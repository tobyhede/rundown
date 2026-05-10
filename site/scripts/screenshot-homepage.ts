/**
 * Capture a full-page screenshot of the homepage after the WebContainer
 * runner reports `Ready`. Single-command UX: reuse an existing dev server
 * on `URL` if one is reachable; otherwise spawn `npm run dev` and tear it
 * down on exit.
 *
 * Configuration (env):
 *   URL  - target origin (default: http://localhost:4321)
 *   OUT  - output path relative to site/ (default: screenshots/homepage.png)
 *
 * Run:
 *   npm run screenshot:home
 */
import { chromium } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(__dirname, '..');

const URL = process.env.URL ?? 'http://localhost:4321';
const OUT = process.env.OUT ?? 'screenshots/homepage.png';
const VIEWPORT = { width: 1280, height: 800 };
const READY_TIMEOUT_MS = 60_000;
const SERVER_BOOT_TIMEOUT_MS = 60_000;
const SERVER_POLL_INTERVAL_MS = 500;

const SNAPSHOT_PATH = resolve(siteRoot, 'public', 'rundown-snapshot.bin');

async function isServerRunning(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    // Any HTTP response (including 404) means a server is on the port.
    return res.status > 0;
  } catch {
    return false;
  }
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + SERVER_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isServerRunning(url)) return;
    await new Promise((r) => setTimeout(r, SERVER_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Dev server did not become reachable at ${url} within ${SERVER_BOOT_TIMEOUT_MS}ms`
  );
}

function spawnDevServer(): ChildProcess {
  const proc = spawn('npm', ['run', 'dev'], {
    cwd: siteRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  // Drain pipes so the child doesn't block on a full buffer; ignore content.
  proc.stdout?.on('data', () => {});
  proc.stderr?.on('data', () => {});
  return proc;
}

async function main() {
  if (!existsSync(SNAPSHOT_PATH)) {
    throw new Error(
      `Missing WebContainer snapshot at ${SNAPSHOT_PATH}. ` +
        `Run \`npm run build:snapshot\` first — without it the homepage will never reach \`Ready\`.`
    );
  }

  let devProcess: ChildProcess | undefined;

  const cleanup = () => {
    if (devProcess && devProcess.exitCode === null) {
      devProcess.kill('SIGTERM');
    }
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

  try {
    if (await isServerRunning(URL)) {
      console.log(`[screenshot] Reusing existing server at ${URL}`);
    } else {
      console.log(`[screenshot] No server on ${URL} — starting \`npm run dev\`...`);
      devProcess = spawnDevServer();
      await waitForServer(URL);
      console.log('[screenshot] Dev server ready.');
    }

    const outAbsolute = resolve(siteRoot, OUT);
    mkdirSync(dirname(outAbsolute), { recursive: true });

    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: VIEWPORT });
      const page = await context.newPage();
      await page.goto(URL);
      console.log('[screenshot] Waiting for runner to reach `Ready`...');
      await page.getByText('Ready', { exact: true }).waitFor({ timeout: READY_TIMEOUT_MS });
      await page.screenshot({ path: outAbsolute, fullPage: true });
      console.log(`[screenshot] Saved ${OUT}`);
    } finally {
      await browser.close();
    }
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error('[screenshot]', err instanceof Error ? err.message : err);
  process.exit(1);
});
