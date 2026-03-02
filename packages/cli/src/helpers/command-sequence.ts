/**
 * Shared command execution logic for scenario and suite runners.
 *
 * Extracts duplicated execution logic into a reusable module used by
 * both scenario-workflow and scenario-suite command handlers.
 *
 * @module helpers/command-sequence
 */

import { spawn } from 'node:child_process';
import { parse as shellParse } from 'shell-quote';
import type { StepAssertion } from '../schemas/scenarios.js';

/** A captured step transition from JSON output. */
export interface CapturedTransition {
  /** Transition type (e.g. "CONTINUE", "GOTO", "RETRY", "STOP", "COMPLETE"). */
  action?: string;
  /** Qualified step position before the transition (e.g. "1", "1.2"). */
  from?: string;
  /** Qualified step position after the transition. */
  at?: string;
  /** Step outcome that triggered the transition. */
  result?: 'PASS' | 'FAIL';
  /** The CLI command string that triggered this transition, if any. */
  command?: string;
}

/** Result of matching a single step assertion against the event stream. */
export interface StepAssertionResult {
  /** The assertion that was evaluated */
  assertion: StepAssertion;
  /** Whether a matching event was found */
  matched: boolean;
  /** The event that matched (if any) */
  matchedEvent?: CapturedTransition;
}

/** Result of executing a command sequence. */
export interface CommandSequenceResult {
  /** Terminal outcome determined from JSON output */
  terminalResult: 'COMPLETE' | 'STOP' | 'UNKNOWN';
  /** All captured step transitions */
  transitions: CapturedTransition[];
  /** Tokens captured from RD_CLAIM_TOKEN= markers */
  capturedTokens: string[];
}

/** Options for command sequence execution. */
export interface CommandSequenceOptions {
  /** Commands to execute in order */
  commands: string[];
  /** Working directory for execution */
  cwd: string;
  /** Path to the CLI entry point (node [cliPath]) */
  cliPath: string;
  /** Whether to suppress child stdout/stderr passthrough */
  quiet: boolean;
  /** Optional callback before each command executes */
  onCommandStart?: (command: string) => void;
}

/**
 * Inject `--json` flag into an args array if not already present.
 *
 * @param args - The argument array to inject into
 * @returns New array with `--json` appended, or original if already present
 */
export function injectJsonFlag(args: string[]): string[] {
  if (args.includes('--json')) return args;
  return [...args, '--json'];
}

/**
 * Substitute captured token placeholders in a command string.
 *
 * `${TOKEN}` maps to `tokens[0]`, `${TOKEN_2}` maps to `tokens[1]`, etc.
 *
 * @param cmd - The command string with optional token placeholders
 * @param tokens - Array of captured tokens in order
 * @returns The command string with placeholders replaced by actual tokens
 * @throws {Error} When a placeholder references a token that hasn't been captured yet
 */
export function substituteTokens(cmd: string, tokens: string[]): string {
  return cmd.replace(
    /\$\{TOKEN(?:_([1-9]\d*))?\}/g,
    (match: string, indexStr: string | undefined) => {
      const idx = indexStr ? parseInt(indexStr, 10) - 1 : 0; // ${TOKEN} = index 0, ${TOKEN_2} = index 1
      if (idx < 0 || idx >= tokens.length) {
        throw new Error(
          `Token placeholder ${match} references uncaptured token (have ${String(tokens.length)} tokens)`,
        );
      }
      return tokens[idx];
    },
  );
}

/**
 * Run a single command and capture its stdout, optionally forwarding output.
 *
 * @param command - Command descriptor: either an rd command with parsed args or a raw shell command
 * @param options - Execution options including cwd, quiet flag, and CLI path
 * @returns Promise resolving to stdout string and exit code
 */
async function runCommandWithTee(
  command: { kind: 'rd'; args: string[] } | { kind: 'shell'; cmd: string },
  options: { cwd: string; quiet: boolean; cliPath: string },
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;

    if (command.kind === 'rd') {
      child = spawn('node', [options.cliPath, ...command.args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: options.cwd,
        env: { ...process.env, RUNDOWN_LOG: '0' },
      });
    } else {
      child = spawn(process.env.SHELL ?? '/bin/sh', ['-lc', command.cmd], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: options.cwd,
        env: { ...process.env, RUNDOWN_LOG: '0' },
      });
    }

    const stdoutChunks: Buffer[] = [];

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      if (!options.quiet) {
        process.stdout.write(chunk);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (!options.quiet) {
        process.stderr.write(chunk);
      }
    });

    child.on('close', (code) => {
      resolve({ stdout: Buffer.concat(stdoutChunks).toString('utf-8'), exitCode: code ?? 1 });
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Process a single parsed JSON object to extract transitions and terminal state.
 *
 * @param obj - A parsed JSON object from command output
 * @param transitions - Array to push extracted transitions into
 * @returns Terminal state detected from this object, or null
 */
function processJsonObject(
  obj: Record<string, unknown>,
  transitions: CapturedTransition[],
): 'COMPLETE' | 'STOP' | null {
  let terminal: 'COMPLETE' | 'STOP' | null = null;

  // Streamed execution event lines have a `type` field
  if (obj.type === 'step_transitioned') {
    transitions.push({
      action: obj.action as string,
      from: obj.from as string,
      at: obj.at as string,
      result: obj.result as 'PASS' | 'FAIL',
      command: obj.command as string | undefined,
    });
  } else if (obj.type === 'runbook_completed') {
    terminal = 'COMPLETE';
  } else if (obj.type === 'runbook_stopped') {
    terminal = 'STOP';
  }

  // Flushed object — terminal detection only (no transition extraction)
  if (!obj.type) {
    if (obj.complete === true) terminal = 'COMPLETE';
    if (obj.stopped === true) terminal = 'STOP';
  }

  return terminal;
}

/**
 * Parse NDJSON lines from command stdout to extract transitions and terminal state.
 *
 * Handles two output formats:
 * - NDJSON: Multiple compact JSON objects, one per line (execution events + flushed object)
 * - Pretty-printed: A single multi-line JSON object (flushed object only, e.g., from `rd pass --json`)
 *
 * Transitions are extracted ONLY from streamed `step_transitioned` events.
 * The flushed JSON object (without a `type` field) is used ONLY for terminal detection.
 *
 * @param stdout - Raw stdout string from an rd command run with `--json`
 * @returns Object with extracted transitions and terminal result (or null if not determined)
 */
export function parseJsonLines(stdout: string): {
  transitions: CapturedTransition[];
  terminal: 'COMPLETE' | 'STOP' | null;
} {
  const trimmed = stdout.trim();
  if (!trimmed) return { transitions: [], terminal: null };

  const transitions: CapturedTransition[] = [];
  let terminal: 'COMPLETE' | 'STOP' | null = null;

  // Try parsing as a single JSON object first (handles pretty-printed output)
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Not a JSON object');
    }
    const obj = parsed as Record<string, unknown>;
    terminal = processJsonObject(obj, transitions);
    return { transitions, terminal };
  } catch {
    // Not a single JSON object — fall through to line-by-line parsing
  }

  // Line-by-line NDJSON parsing
  const lines = trimmed.split('\n').filter(Boolean);
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // Non-JSON line — skip
    }

    const detected = processJsonObject(obj, transitions);
    if (detected !== null) {
      terminal = detected;
    }
  }

  return { transitions, terminal };
}

/**
 * Determine whether a single captured transition event matches a step assertion.
 *
 * Only specified (non-undefined) assertion fields are checked.
 *
 * @param event - The captured transition event to test
 * @param assertion - The assertion to match against
 * @returns True when all specified assertion fields match the event
 */
function eventMatchesAssertion(event: CapturedTransition, assertion: StepAssertion): boolean {
  if (assertion.at !== undefined && event.at !== assertion.at) return false;
  if (assertion.from !== undefined && event.from !== assertion.from) return false;
  if (assertion.action !== undefined && event.action !== assertion.action) return false;
  if (assertion.result !== undefined && event.result !== assertion.result) return false;
  if (assertion.command !== undefined && event.command !== assertion.command) return false;
  return true;
}

/**
 * Match step assertions against a captured event stream using ordered skip-matching.
 *
 * Assertions are matched in order against the event stream. Each assertion
 * skips forward through the events until a match is found (or the event
 * stream is exhausted). Preserves relative ordering: assertion N can only
 * match events after the event that matched assertion N-1.
 *
 * @param assertions - Ordered list of step assertions to evaluate
 * @param events - Captured transitions from command execution
 * @returns Array of assertion results in the same order as input assertions
 */
export function matchStepAssertions(
  assertions: StepAssertion[],
  events: CapturedTransition[],
): StepAssertionResult[] {
  const results: StepAssertionResult[] = [];
  let eventIndex = 0;

  for (const assertion of assertions) {
    let matched = false;
    while (eventIndex < events.length) {
      if (eventMatchesAssertion(events[eventIndex], assertion)) {
        results.push({ assertion, matched: true, matchedEvent: events[eventIndex] });
        eventIndex++;
        matched = true;
        break;
      }
      eventIndex++;
    }
    if (!matched) {
      results.push({ assertion, matched: false });
    }
  }

  return results;
}

/**
 * Format a step assertion result for human-readable display.
 *
 * @param sa - The step assertion result to format
 * @returns A descriptive string like "step at=1.3 action=BREAK: matched"
 */
export function formatStepAssertionDescription(sa: StepAssertionResult): string {
  const parts: string[] = [];
  if (sa.assertion.at !== undefined) parts.push(`at=${sa.assertion.at}`);
  if (sa.assertion.from !== undefined) parts.push(`from=${sa.assertion.from}`);
  if (sa.assertion.action !== undefined) parts.push(`action=${sa.assertion.action}`);
  if (sa.assertion.result !== undefined) parts.push(`result=${sa.assertion.result}`);
  if (sa.assertion.command !== undefined) parts.push(`command=${sa.assertion.command}`);
  const desc = parts.length > 0 ? parts.join(' ') : '(empty assertion)';
  return `step ${desc}: ${sa.matched ? 'matched' : 'no match'}`;
}

/**
 * Execute a sequence of commands in order, accumulating transitions and tokens.
 *
 * Handles `rd` commands (routed through the CLI with `--json`) and generic
 * shell commands. Token placeholders (`${TOKEN}`, `${TOKEN_2}`, etc.) are
 * substituted with previously captured `RD_CLAIM_TOKEN=` values before each
 * command runs.
 *
 * @param options - Execution options including commands, working directory, CLI path, and quiet flag
 * @returns Promise resolving to the terminal result, all transitions, and captured tokens
 * @throws {Error} When a token placeholder references an uncaptured token
 * @throws {Error} When an rd command contains unsupported shell operators
 */
export async function executeCommandSequence(
  options: CommandSequenceOptions,
): Promise<CommandSequenceResult> {
  const capturedTokens: string[] = [];
  const transitions: CapturedTransition[] = [];
  let terminalResult: 'COMPLETE' | 'STOP' | 'UNKNOWN' = 'UNKNOWN';

  const { commands, cwd, cliPath, quiet } = options;

  for (const rawCmd of commands) {
    // Token substitution — replace ${TOKEN}, ${TOKEN_2}, etc. with captured values
    const cmd = substituteTokens(rawCmd, capturedTokens);

    options.onCommandStart?.(cmd);

    const rdMatch = /^rd\s+(.*)$/.exec(cmd);

    let stdout: string;

    if (rdMatch) {
      // rd command — parse args and inject --json
      const shellArgs = shellParse(rdMatch[1]);
      const hasOperators = shellArgs.some((entry) => typeof entry !== 'string');
      if (hasOperators) {
        throw new Error(
          `Unsupported shell operators in scenario command: ${cmd}. ` +
            'Split into separate commands instead of using &&, ||, |, etc.',
        );
      }
      const args = injectJsonFlag(shellArgs as string[]);
      const result = await runCommandWithTee({ kind: 'rd', args }, { cwd, quiet, cliPath });
      stdout = result.stdout;

      // Parse JSON output to extract transitions and terminal state
      const jsonResult = parseJsonLines(stdout);
      for (const t of jsonResult.transitions) {
        transitions.push(t);
      }
      if (jsonResult.terminal !== null) {
        terminalResult = jsonResult.terminal;
      }

      // If the command failed and no terminal result was parsed, propagate the failure
      if (result.exitCode !== 0 && jsonResult.terminal === null) {
        throw new Error(`Command failed with exit code ${String(result.exitCode)}: ${cmd}`);
      }
    } else {
      // Shell command — execute directly
      const result = await runCommandWithTee({ kind: 'shell', cmd }, { cwd, quiet, cliPath });
      stdout = result.stdout;
    }

    // Scan all command stdout for token markers
    const tokenPattern = /RD_CLAIM_TOKEN=(\S+)/g;
    for (const match of stdout.matchAll(tokenPattern)) {
      capturedTokens.push(match[1]);
    }
  }

  return { terminalResult, transitions, capturedTokens };
}
