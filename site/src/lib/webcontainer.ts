import { WebContainer } from '@webcontainer/api';
import { DB_FILES, LOCKS_DIR, RUNBOOKS_DIR, RUNS_DIR } from './rundown-paths';

let webcontainerInstance: WebContainer | null = null;
let bootPromise: Promise<WebContainer> | null = null;
let isRundownMounted = false;

/**
 * Get or boot the singleton WebContainer instance.
 * Only one WebContainer can exist per page.
 *
 * @returns The singleton WebContainer instance
 */
export async function getWebContainer(): Promise<WebContainer> {
  if (webcontainerInstance) {
    return webcontainerInstance;
  }

  if (bootPromise) {
    return bootPromise;
  }

  bootPromise = WebContainer.boot();
  webcontainerInstance = await bootPromise;
  return webcontainerInstance;
}

/**
 * Mount the pre-built Rundown environment from snapshot.
 * Uses build-time snapshot to avoid runtime npm install (~5-15s → <1s).
 *
 * @param container - The WebContainer instance to mount to
 * @throws Error if snapshot fetch fails
 */
export async function setupRundown(container: WebContainer): Promise<void> {
  // Guard: only mount once per session
  if (isRundownMounted) {
    return;
  }

  // Fetch pre-built snapshot (includes node_modules with @rundown-org/cli)
  const response = await fetch('/rundown-snapshot.bin');
  if (!response.ok) {
    throw new Error(`Failed to fetch snapshot: ${response.status} ${response.statusText}`);
  }

  const snapshotData = await response.arrayBuffer();

  // Mount entire environment instantly - NO npm install needed!
  await container.mount(snapshotData);

  isRundownMounted = true;
}

/**
 * Mount a runbook file into the container.
 *
 * @param container - The WebContainer instance to mount to
 * @param path - Relative path within the runbooks directory
 * @param content - The runbook file content
 * @throws {Error} If the runbook path is empty, contains traversal segments (`..`), or has invalid segments (`.`, empty)
 */
export async function mountRunbook(
  container: WebContainer,
  path: string,
  content: string
): Promise<void> {
  // Normalize separators, strip leading slashes, and guard against path traversal.
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/');
  if (!normalized || segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new Error(`Invalid runbook path: ${path}`);
  }
  const fullPath = `${RUNBOOKS_DIR}/${normalized}`;
  // Create parent directories (handles nested paths like planning/write-plan.runbook.md)
  const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
  await container.fs.mkdir(dir, { recursive: true });
  await container.fs.writeFile(fullPath, content);
}

/**
 * Paths removed by {@link cleanRundownState}, in the order their failures are
 * reported. Unreleased JSON locations are inert and deliberately untouched.
 *
 * Every path is derived from `./rundown-paths`, which is parity-checked against
 * `packages/core/src/paths.ts` at compile time — so a core rename fails
 * `astro check` rather than quietly leaving state behind. The database entry is
 * `DB_FILES`, not a bare `DB_FILE`, because the WAL sidecars are state too: drop
 * `-wal` and the next demo run boots on a replayable log of the previous one.
 *
 * `.rundown/runs` no longer holds run authority — post-cutover it is purely the
 * per-run captured-output tree (RUNS_DIR in packages/core/src/paths.ts, torn
 * down per run by RunbookStateManager). Dropping the database without it would
 * orphan those files: their state and manifest records go, the bytes stay, and
 * every reset adds more to browser storage.
 */
const RUNDOWN_STATE_PATHS: ReadonlyArray<{ path: string; recursive?: boolean }> = [
  ...DB_FILES.map((path) => ({ path })),
  { path: RUNS_DIR, recursive: true },
  { path: LOCKS_DIR, recursive: true },
];

/**
 * Clean up runbook state between scenario runs.
 *
 * Removes the SQLite authority and lock files. A path that does not exist is
 * not a failure; anything else is, and is propagated so the caller can block
 * the next run rather than silently reusing stale state.
 *
 * @param container - The WebContainer instance to clean up
 * @throws {Error} If any path could not be removed for a reason other than not
 *   existing (e.g. a locked or undeletable database). Every path is still
 *   attempted first; the message aggregates all failures.
 */
export async function cleanRundownState(container: WebContainer): Promise<void> {
  // `force: true` is the not-found discriminator, and the only reliable one
  // available: WebContainer's `fs.rm` forwards options verbatim to its
  // Node-compatible fs (FileSystemAPIClient.rm is a pass-through), where
  // `force` ignores a missing path and suppresses nothing else. Discriminating
  // client-side is not an option — @webcontainer/api's RPC bridge serializes
  // only `message`/`name`/`stack`, so `err.code` never survives the worker
  // boundary and only a fragile message match would remain.
  //
  // `allSettled` (not `all`) keeps the property that one failing path does not
  // skip the others; genuine failures are aggregated and thrown afterwards
  // instead of being swallowed.
  //
  // `recursive` is spread in only when it is true, never passed as `undefined`.
  // WebContainer type-checks the option strictly — an explicit `undefined`
  // rejects with `The "options.recursive" property must be of type boolean`,
  // which Node tolerates but this fs does not.
  const results = await Promise.allSettled(
    RUNDOWN_STATE_PATHS.map(({ path, recursive }) =>
      container.fs.rm(path, { force: true, ...(recursive === true && { recursive: true }) })
    )
  );

  const failures = results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [
          `${RUNDOWN_STATE_PATHS[index].path}: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`,
        ]
      : []
  );

  if (failures.length > 0) {
    throw new Error(`Failed to clean runbook state — ${failures.join('; ')}`);
  }
}

/**
 * Run a command in the container and capture output.
 *
 * @param container - The WebContainer instance to run the command in
 * @param command - The command to execute
 * @param args - Arguments to pass to the command
 * @param timeoutMs - Timeout in milliseconds (default: 10000)
 * @param onOutput - Optional callback for streaming output
 * @returns Object containing command output and exit code
 * @throws Error - Rejects if {@link WebContainer.spawn} fails or if the
 *   spawned process's `exit` promise itself rejects. Non-zero exit codes
 *   are NOT thrown — they are returned in the resolved `exitCode` field.
 *   Timeouts also resolve (with `output: '(command timed out)'` and
 *   `exitCode: -1`) rather than throwing.
 */
export async function runCommand(
  container: WebContainer,
  command: string,
  args: string[],
  timeoutMs = 10000,
  onOutput?: (chunk: string) => void
): Promise<{ output: string; exitCode: number }> {
  console.log(`[WebContainer] Running: ${command} ${args.join(' ')}`);
  const process = await container.spawn(command, args);

  let output = '';
  let exitCode = 0;
  let resolved = false;

  return new Promise((resolve, reject) => {
    // Timeout handler
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.log(`[WebContainer] Command timed out, returning captured output`);
        process.kill();
        resolve({ output: output || '(command timed out)', exitCode: -1 });
      }
    }, timeoutMs);

    // Read output asynchronously
    const reader = process.output.getReader();
    const readOutput = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          output += value;
          if (onOutput) onOutput(value);
          console.log(`[WebContainer] Output chunk:`, value);
        }
      } catch (err) {
        console.error(`[WebContainer] Read error:`, err);
      } finally {
        reader.releaseLock();
      }
    };

    // Handle process exit
    process.exit.then((code) => {
      console.log(`[WebContainer] Process exited with code:`, code);
      exitCode = code;
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        // Small delay to ensure all output is captured
        setTimeout(() => resolve({ output, exitCode }), 100);
      }
    }).catch((err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    // Start reading output
    readOutput();
  });
}

/**
 * Run an rd command using node to invoke the CLI directly (avoids permission issues).
 *
 * The `mode` parameter controls the CLI's output format:
 *
 * - `'text'` (default) appends `--text` to the args. The site's interactive demo
 *   relies on this for the status footer regex parser in `RunbookRunner.tsx`,
 *   which extracts step/result info from text-mode output patterns
 *   (`At: <stepId>`, `Runbook: STATUS`).
 * - `'json'` leaves args untouched, so the CLI emits its default JSONL event
 *   stream. The footer regex parser does not fire in JSON mode (those lines
 *   aren't in the JSON output); footer values stay at placeholders.
 *
 * The parameter is optional and last-position so existing callers compile unchanged.
 *
 * @param container - The WebContainer instance to run the command in
 * @param args - Arguments to pass to the rd command
 * @param onOutput - Optional callback for streaming output
 * @param mode - Output mode (default: `'text'`)
 * @returns Object containing command output and exit code
 * @throws Error - Rejects with the underlying error from {@link runCommand}
 *   if the WebContainer fails to spawn the `node` process or the process's
 *   `exit` promise rejects. Non-zero exit codes are NOT thrown — they are
 *   returned in the resolved `exitCode` field. Timeouts also resolve (with
 *   `exitCode: -1`) rather than throwing.
 */
export async function runRdCommand(
  container: WebContainer,
  args: string[],
  onOutput?: (chunk: string) => void,
  mode: 'text' | 'json' = 'text'
): Promise<{ output: string; exitCode: number }> {
  // Use node to run the CLI script directly (avoids execute permission issues)
  const cliPath = './node_modules/@rundown-org/cli/dist/cli.js';
  const finalArgs = mode === 'text' ? [...args, '--text'] : args;
  console.log(`[WebContainer] Running rd via node (${mode}): ${cliPath} ${finalArgs.join(' ')}`);
  return runCommand(container, 'node', [cliPath, ...finalArgs], 10000, onOutput);
}
