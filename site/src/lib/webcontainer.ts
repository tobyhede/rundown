import { WebContainer } from '@webcontainer/api';

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

  // Fetch pre-built snapshot (includes node_modules with @rundown/cli)
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
 */
export async function mountRunbook(
  container: WebContainer,
  path: string,
  content: string
): Promise<void> {
  // Use container.fs.mkdir to avoid race condition (recursive: true creates parents)
  await container.fs.mkdir('.claude/rundown/runbooks', { recursive: true });
  await container.fs.writeFile(`.claude/rundown/runbooks/${path}`, content);
}

/**
 * Clean up runbook state between scenario runs.
 *
 * @param container - The WebContainer instance to clean up
 */
export async function cleanRundownState(container: WebContainer): Promise<void> {
  try {
    // Remove state files to ensure clean slate
    await container.fs.rm('.claude/rundown/runs', { recursive: true });
    await container.fs.rm('.claude/rundown/session.json');
  } catch {
    // Ignore errors if files don't exist
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
 * @param container - The WebContainer instance to run the command in
 * @param args - Arguments to pass to the rd command
 * @param onOutput - Optional callback for streaming output
 * @returns Object containing command output and exit code
 */
export async function runRdCommand(
  container: WebContainer,
  args: string[],
  onOutput?: (chunk: string) => void
): Promise<{ output: string; exitCode: number }> {
  // Use node to run the CLI script directly (avoids execute permission issues)
  const cliPath = './node_modules/@rundown/cli/dist/cli.js';
  console.log(`[WebContainer] Running rd via node: ${cliPath} ${args.join(' ')}`);
  return runCommand(container, 'node', [cliPath, ...args], 10000, onOutput);
}
