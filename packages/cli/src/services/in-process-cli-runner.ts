import { CommanderError } from 'commander';
import { ConsoleWriter, getErrorMessage, resetColorCache, setWriter } from '@rundown-org/core';
import { resetPolicyContext } from './policy-context.js';

/** Result of running the CLI in the current Node process. */
export interface InProcessCliRunResult {
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
  /** Exit code observed from Commander, process.exit, or process.exitCode. */
  exitCode: number;
  /** Whether process.exit was intercepted during the invocation. */
  exitIntercepted?: boolean;
}

/** Options for running the CLI in the current Node process. */
export interface InProcessCliRunOptions {
  /** CLI arguments, excluding the executable name. */
  args: readonly string[];
  /** Working directory visible via process.cwd() during invocation. */
  cwd: string;
  /** Per-invocation environment overrides, restored after the command finishes. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Sentinel error thrown when a command calls process.exit() in-process. */
class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${String(code)})`);
    this.name = 'ExitSignal';
  }
}

/**
 * Strip in-process process.exit interception artefacts from a captured buffer.
 *
 * @param buf - Captured stdout or stderr buffer.
 * @returns The buffer with end-of-buffer artefacts removed.
 */
export function stripExitArtefact(buf: string): string {
  const artefactPattern =
    /(^|\n)\{\s*"error":\s*"process\.exit\(\d+\)",\s*"kind":\s*"error",\s*"code":\s*"UNKNOWN_ERROR"(?:,\s*"command":\s*"[^"]+")?\s*\}\s*$/;
  let out = buf.replace(artefactPattern, '$1');
  out = out.replace(/\s*process\.exit\(\d+\)\s*$/, '');
  return out;
}

function appendChunk(buffer: string, chunk: unknown): string {
  if (typeof chunk === 'string') {
    return buffer + chunk;
  }
  if (chunk instanceof Uint8Array) {
    return buffer + new TextDecoder().decode(chunk);
  }
  return buffer + String(chunk);
}

function restoreEnv(originalEnv: Readonly<Record<string, string | undefined>>): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Run the Rundown CLI in this Node process while capturing stdout/stderr.
 *
 * This exists for scenario execution in environments where nested process
 * spawning is expensive or unavailable. It mutates process globals during the
 * invocation and restores them before returning.
 *
 * @param options - Arguments, cwd, and environment for this invocation.
 * @returns Captured output and exit code.
 */
export async function runCliInProcess(
  options: InProcessCliRunOptions,
): Promise<InProcessCliRunResult> {
  const extraEnv = options.env ?? {};
  const envKeys = new Set([
    'NO_COLOR',
    'RUNDOWN_LOG',
    'CLAUDE_PLUGIN_ROOT',
    'PATH',
    'FORCE_COLOR',
    ...Object.keys(extraEnv),
  ]);
  const originalEnv = Object.fromEntries(
    [...envKeys].map((key) => [key, process.env[key]]),
  ) as Record<string, string | undefined>;

  const originalCwd = process.cwd();
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalExit = process.exit.bind(process);
  const originalConsoleError = console.error.bind(console);
  const originalConsoleLog = console.log.bind(console);

  let stdoutBuf = '';
  let stderrBuf = '';
  let exitCode = 0;
  const exit = { signalled: false };

  try {
    resetPolicyContext();
    resetColorCache();

    process.chdir(options.cwd);
    process.env.NO_COLOR = '1';
    process.env.RUNDOWN_LOG = '0';
    delete process.env.FORCE_COLOR;
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    process.stdout.write = (chunk: unknown, ...rest: unknown[]): boolean => {
      stdoutBuf = appendChunk(stdoutBuf, chunk);
      const cb = rest.find((arg) => typeof arg === 'function') as
        | ((err?: Error | null) => void)
        | undefined;
      cb?.();
      return true;
    };
    process.stderr.write = (chunk: unknown, ...rest: unknown[]): boolean => {
      stderrBuf = appendChunk(stderrBuf, chunk);
      const cb = rest.find((arg) => typeof arg === 'function') as
        | ((err?: Error | null) => void)
        | undefined;
      cb?.();
      return true;
    };

    setWriter(new ConsoleWriter());

    console.error = (...args: unknown[]) => {
      stderrBuf += `${args.map(String).join(' ')}\n`;
    };
    console.log = (...args: unknown[]) => {
      stdoutBuf += `${args.map(String).join(' ')}\n`;
    };

    process.exit = (code?: number) => {
      exit.signalled = true;
      throw new ExitSignal(code ?? 0);
    };

    const { createProgram } = await import('../cli.js');
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([...options.args], { from: 'user' });

    exitCode = Number(process.exitCode ?? 0);
    process.exitCode = undefined;
  } catch (err: unknown) {
    if (err instanceof ExitSignal) {
      exitCode = err.code;
    } else if (err instanceof CommanderError) {
      exitCode = err.exitCode;
    } else {
      exitCode = 1;
      stderrBuf += getErrorMessage(err);
    }
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exit = originalExit;
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    process.exitCode = undefined;
    process.chdir(originalCwd);
    restoreEnv(originalEnv);

    resetPolicyContext();
    resetColorCache();
    setWriter(new ConsoleWriter());
  }

  if (exit.signalled) {
    stdoutBuf = stripExitArtefact(stdoutBuf);
    stderrBuf = stripExitArtefact(stderrBuf);
  }

  return { stdout: stdoutBuf, stderr: stderrBuf, exitCode, exitIntercepted: exit.signalled };
}
