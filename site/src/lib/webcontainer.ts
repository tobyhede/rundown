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
 * Clean up workflow state between scenario runs.
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
 * @returns Object containing command output and exit code
 */
export async function runCommand(
  container: WebContainer,
  command: string,
  args: string[]
): Promise<{ output: string; exitCode: number }> {
  const process = await container.spawn(command, args);

  let output = '';

  // Capture stdout (WebContainer API returns strings directly)
  const reader = process.output.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += value;
  }

  const exitCode = await process.exit;
  return { output, exitCode };
}

/**
 * Run an rd command using the direct binary path (avoids npx overhead).
 *
 * @param container - The WebContainer instance to run the command in
 * @param args - Arguments to pass to the rd command
 * @returns Object containing command output and exit code
 */
export async function runRdCommand(
  container: WebContainer,
  args: string[]
): Promise<{ output: string; exitCode: number }> {
  // Use direct path to avoid npx overhead and prompts
  return runCommand(container, './node_modules/.bin/rd', args);
}
