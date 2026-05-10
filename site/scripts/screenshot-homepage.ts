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

const targetUrl: string = process.env.URL ?? 'http://localhost:4321';
const outputPath: string = process.env.OUT ?? 'screenshots/homepage.png';
const viewport: { width: number; height: number } = { width: 1280, height: 800 };
const readyTimeoutMs: number = 60_000;
const serverBootTimeoutMs: number = 60_000;
const serverPollIntervalMs: number = 500;

const snapshotPath: string = resolve(siteRoot, 'public', 'rundown-snapshot.bin');

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
  const deadline = Date.now() + serverBootTimeoutMs;
  while (Date.now() < deadline) {
    if (await isServerRunning(url)) return;
    await new Promise((r) => setTimeout(r, serverPollIntervalMs));
  }
  throw new Error(
    `Dev server did not become reachable at ${url} within ${serverBootTimeoutMs}ms`
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

async function main(): Promise<void> {
  if (!existsSync(snapshotPath)) {
    throw new Error(
      `Missing WebContainer snapshot at ${snapshotPath}. Run \`npm run build:snapshot\` first — without it the homepage will never reach \`Ready\`.`
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
    if (await isServerRunning(targetUrl)) {
      console.log(`[screenshot] Reusing existing server at ${targetUrl}`);
    } else {
      console.log(`[screenshot] No server on ${targetUrl} — starting \`npm run dev\`...`);
      devProcess = spawnDevServer();
      await waitForServer(targetUrl);
      console.log('[screenshot] Dev server ready.');
    }

    const outAbsolute = resolve(siteRoot, outputPath);
    mkdirSync(dirname(outAbsolute), { recursive: true });

    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.goto(targetUrl);
      console.log('[screenshot] Waiting for runner to reach `Ready`...');
      await page.getByText('Ready', { exact: true }).waitFor({ timeout: readyTimeoutMs });
      await page.screenshot({ path: outAbsolute, fullPage: true });
      console.log(`[screenshot] Saved ${outputPath}`);
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
