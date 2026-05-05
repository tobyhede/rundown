/**
 * Shared command execution logic for scenario and suite runners.
 *
 * Extracts duplicated execution logic into a reusable module used by
 * both scenario-workflow and scenario-suite command handlers.
 *
 * @module helpers/command-sequence
 */

import { spawn } from 'node:child_process';
import type { RunbookRef } from '@rundown-org/core';
import { parse as shellParse } from 'shell-quote';
import type { ErrorAssertion, StepAssertion } from '../schemas/scenarios.js';

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
  /** Whether this transition resulted from aggregation (deferred result evaluation). */
  aggregated?: boolean;
  /** Runbook that produced this transition (from event envelope). */
  runbook?: RunbookRef;
  /** Present for delegated/nested child runs — identifies the delegating parent step. */
  parentStepId?: string;
}

/** A captured JSON error response from command output. */
export interface CapturedError {
  /** Machine-readable error code. */
  code?: string;
  /** Human-readable error message. */
  error?: string;
  /** CLI command that triggered the error. */
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

/** Result of matching a single error assertion against captured JSON errors. */
export interface ErrorAssertionResult {
  /** The assertion that was evaluated */
  assertion: ErrorAssertion;
  /** Whether a matching error was found */
  matched: boolean;
  /** The error that matched (if any) */
  matchedError?: CapturedError;
}

/** Result of executing a command sequence. */
export interface CommandSequenceResult {
  /** Terminal outcome determined from JSON output */
  terminalResult: 'COMPLETE' | 'STOP' | 'UNKNOWN';
  /** All captured step transitions */
  transitions: CapturedTransition[];
  /** Tokens captured from delegate JSON responses */
  capturedTokens: string[];
  /** Claim IDs captured from claim JSON responses */
  capturedClaimIds: string[];
  /** JSON error responses captured from command output */
  errors: CapturedError[];
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
  /** Optional environment variables merged into spawn env (overrides process.env) */
  env?: Record<string, string | undefined>;
}

/** Parsed `rd` command with command-scoped environment assignments. */
export interface ParsedRdCommand {
  /** Arguments passed to the Rundown CLI, excluding the `rd` executable. */
  args: string[];
  /** Environment assignments that apply only to this command. */
  env: Record<string, string>;
}

const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*/;

function findExecutableAfterEnvAssignments(shellArgs: Array<string | object>): string | null {
  for (const entry of shellArgs) {
    if (typeof entry !== 'string') {
      return null;
    }
    if (ENV_ASSIGNMENT_PATTERN.test(entry)) {
      continue;
    }
    return entry;
  }
  return null;
}

function hasRdExecutableInOperatorSeparatedSegment(shellArgs: Array<string | object>): boolean {
  let segment: Array<string | object> = [];

  for (const entry of shellArgs) {
    if (typeof entry !== 'string') {
      const executable = findExecutableAfterEnvAssignments(segment);
      if (executable === 'rd' || executable === 'rundown') {
        return true;
      }
      segment = [];
      continue;
    }

    segment.push(entry);
  }

  const executable = findExecutableAfterEnvAssignments(segment);
  return executable === 'rd' || executable === 'rundown';
}

/**
 * Parse a scenario command as an `rd` command, allowing leading environment
 * assignments such as `FOO=bar rd claim ...`.
 *
 * @param cmd - Scenario command string after token substitution
 * @returns Parsed args/env for `rd`/`rundown`, or null for non-`rd` shell commands
 * @throws {Error} When shell operators are present in an `rd` command
 */
export function parseRdCommandWithEnv(cmd: string): ParsedRdCommand | null {
  const shellArgs = shellParse(cmd);
  const hasOperators = shellArgs.some((entry) => typeof entry !== 'string');
  if (hasOperators) {
    if (hasRdExecutableInOperatorSeparatedSegment(shellArgs)) {
      throw new Error(
        `Unsupported shell operators in scenario command: ${cmd}. ` +
          'Split into separate commands instead of using &&, ||, |, etc.',
      );
    }
    return null;
  }

  const args = shellArgs as string[];
  const env: Record<string, string> = {};
  let commandIndex = 0;

  while (commandIndex < args.length && ENV_ASSIGNMENT_PATTERN.test(args[commandIndex])) {
    const assignment = args[commandIndex];
    const equalsIndex = assignment.indexOf('=');
    env[assignment.slice(0, equalsIndex)] = assignment.slice(equalsIndex + 1);
    commandIndex++;
  }

  const executable = args[commandIndex];
  if (executable !== 'rd' && executable !== 'rundown') {
    return null;
  }

  return { args: args.slice(commandIndex + 1), env };
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
  return cmd.replace(/\$\{TOKEN(?:_(\d+))?\}/g, (match: string, indexStr: string | undefined) => {
    const idx = indexStr ? parseInt(indexStr, 10) - 1 : 0; // ${TOKEN} = index 0, ${TOKEN_2} = index 1
    if (idx < 0 || idx >= tokens.length) {
      throw new Error(
        `Token placeholder ${match} references uncaptured token (have ${String(tokens.length)} tokens)`,
      );
    }
    return tokens[idx];
  });
}

/**
 * Substitute captured claim id placeholders in a command string.
 *
 * `${CLAIM_ID}` maps to the first claim id, `${CLAIM_ID_2}` maps to the second.
 *
 * @param command - Command string with optional claim id placeholders
 * @param capturedClaimIds - Claim ids captured from earlier `rd claim` output
 * @returns Command string with claim id placeholders substituted
 * @throws {Error} If a placeholder references a claim id that has not been captured
 */
export function substituteClaimIds(command: string, capturedClaimIds: readonly string[]): string {
  return command.replace(/\$\{CLAIM_ID(?:_(\d+))?\}/g, (_match, index: string | undefined) => {
    const offset = index === undefined ? 0 : Number(index) - 1;
    if (offset < 0 || offset >= capturedClaimIds.length) {
      throw new Error(`Missing captured claim id for \${CLAIM_ID${index ? `_${index}` : ''}}`);
    }
    return capturedClaimIds[offset];
  });
}

/**
 * Capture a claim id from a parsed `rd claim` JSON object.
 *
 * @param value - Parsed JSON value to inspect
 * @param capturedClaimIds - Array to append captured claim ids into
 */
export function captureClaimIdFromJsonObject(value: unknown, capturedClaimIds: string[]): void {
  if (
    value !== null &&
    typeof value === 'object' &&
    'action' in value &&
    'claim_id' in value &&
    (value as { action?: unknown }).action === 'claimed' &&
    typeof (value as { claim_id?: unknown }).claim_id === 'string'
  ) {
    capturedClaimIds.push((value as { claim_id: string }).claim_id);
  }
}

/**
 * Run a single command and capture its stdout, optionally forwarding output.
 *
 * @param command - Command descriptor: either an rd command with parsed args or a raw shell command
 * @param options - Execution options including cwd, quiet flag, and CLI path
 * @param options.cwd - Working directory for command execution
 * @param options.quiet - Whether to suppress stdout/stderr passthrough
 * @param options.cliPath - Path to the CLI entry point for rd commands
 * @param options.env - Optional environment variables to merge into spawn env
 * @returns Promise resolving to stdout string and exit code
 */
async function runCommandWithTee(
  command: { kind: 'rd'; args: string[] } | { kind: 'shell'; cmd: string },
  options: {
    cwd: string;
    quiet: boolean;
    cliPath: string;
    env?: Record<string, string | undefined>;
  },
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    const spawnEnv = { ...process.env, ...(options.env ?? {}), RUNDOWN_LOG: '0' };

    if (command.kind === 'rd') {
      child = spawn('node', [options.cliPath, ...command.args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: options.cwd,
        env: spawnEnv,
      });
    } else {
      child = spawn(process.env.SHELL ?? '/bin/sh', ['-lc', command.cmd], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: options.cwd,
        env: spawnEnv,
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
 * @param tokens - Array to push captured delegation tokens into
 * @param claimIds - Array to push captured claim ids into
 * @param errors - Array to push captured JSON error responses into
 * @returns Terminal state detected from this object, or null
 */
function processJsonObject(
  obj: Record<string, unknown>,
  transitions: CapturedTransition[],
  tokens: string[],
  claimIds: string[],
  errors: CapturedError[],
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
      aggregated: obj.aggregated === true ? true : undefined,
      runbook: obj.runbook as RunbookRef | undefined,
      parentStepId: typeof obj.parentStepId === 'string' ? obj.parentStepId : undefined,
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

  // Extract delegation token from delegate response
  if (obj.action === 'delegated' && typeof obj.token === 'string') {
    tokens.push(obj.token);
  }
  captureClaimIdFromJsonObject(obj, claimIds);

  if (obj.kind === 'error') {
    errors.push({
      code: typeof obj.code === 'string' ? obj.code : undefined,
      error: typeof obj.error === 'string' ? obj.error : undefined,
      command: typeof obj.command === 'string' ? obj.command : undefined,
    });
  }

  // Extract pre-issued delegation tokens from STEP_ENTERED delegateFrontier.
  // Emitted when `rd run` enters a DELEGATE step: tokens are auto-issued for
  // each delegated substep so the agent can claim without a separate
  // `rd delegate` command.
  if (obj.type === 'step_entered' && Array.isArray(obj.delegateFrontier)) {
    for (const entry of obj.delegateFrontier) {
      if (
        entry !== null &&
        typeof entry === 'object' &&
        'token' in entry &&
        typeof (entry as { token: unknown }).token === 'string'
      ) {
        tokens.push((entry as { token: string }).token);
      }
    }
  }

  return terminal;
}

/**
 * Parse NDJSON lines from command stdout to extract transitions and terminal state.
 *
 * Handles two output formats:
 * - NDJSON: Multiple compact JSON objects, one per line (execution events + flushed object)
 * - Pretty-printed: A single multi-line JSON object (flushed object only, e.g., from `rd pass`)
 *
 * Transitions are extracted ONLY from streamed `step_transitioned` events.
 * The flushed JSON object (without a `type` field) is used ONLY for terminal detection.
 *
 * @param stdout - Raw stdout string from an rd command (JSON is the default output)
 * @returns Object with extracted transitions and terminal result (or null if not determined)
 */
export function parseJsonLines(stdout: string): {
  transitions: CapturedTransition[];
  terminal: 'COMPLETE' | 'STOP' | null;
  tokens: string[];
  claimIds: string[];
  errors: CapturedError[];
} {
  const trimmed = stdout.trim();
  if (!trimmed) return { transitions: [], terminal: null, tokens: [], claimIds: [], errors: [] };

  const transitions: CapturedTransition[] = [];
  const tokens: string[] = [];
  const claimIds: string[] = [];
  const errors: CapturedError[] = [];
  let terminal: 'COMPLETE' | 'STOP' | null = null;

  // Try parsing as a single JSON object first (handles pretty-printed output)
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Not a JSON object');
    }
    const obj = parsed as Record<string, unknown>;
    terminal = processJsonObject(obj, transitions, tokens, claimIds, errors);
    return { transitions, terminal, tokens, claimIds, errors };
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

    const detected = processJsonObject(obj, transitions, tokens, claimIds, errors);
    if (detected !== null) {
      terminal = detected;
    }
  }

  return { transitions, terminal, tokens, claimIds, errors };
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
  if (assertion.aggregated !== undefined && event.aggregated !== assertion.aggregated) return false;
  if (assertion.runbook !== undefined) {
    const rb = event.runbook;
    if (rb !== undefined) {
      if (!rb.path.endsWith(assertion.runbook)) return false;
    } else {
      return false;
    }
  }
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
 * Match error assertions against captured JSON error responses using ordered
 * skip-matching.
 *
 * @param assertions - Ordered list of error assertions to evaluate
 * @param events - Captured JSON error responses from command execution
 * @returns Array of assertion results in the same order as input assertions
 */
export function matchErrorAssertions(
  assertions: ErrorAssertion[],
  events: CapturedError[],
): ErrorAssertionResult[] {
  const results: ErrorAssertionResult[] = [];
  let eventIndex = 0;

  for (const assertion of assertions) {
    let matched = false;
    while (eventIndex < events.length) {
      const event = events[eventIndex];
      if (
        (assertion.code === undefined || event.code === assertion.code) &&
        (assertion.command === undefined || event.command === assertion.command) &&
        (assertion.error === undefined || event.error?.includes(assertion.error) === true)
      ) {
        results.push({ assertion, matched: true, matchedError: event });
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
  if (sa.assertion.runbook !== undefined) parts.push(`runbook=${sa.assertion.runbook}`);
  if (sa.assertion.at !== undefined) parts.push(`at=${sa.assertion.at}`);
  if (sa.assertion.from !== undefined) parts.push(`from=${sa.assertion.from}`);
  if (sa.assertion.action !== undefined) parts.push(`action=${sa.assertion.action}`);
  if (sa.assertion.result !== undefined) parts.push(`result=${sa.assertion.result}`);
  if (sa.assertion.command !== undefined) parts.push(`command=${sa.assertion.command}`);
  if (sa.assertion.aggregated !== undefined)
    parts.push(`aggregated=${String(sa.assertion.aggregated)}`);
  const desc = parts.length > 0 ? parts.join(' ') : '(empty assertion)';
  return `step ${desc}: ${sa.matched ? 'matched' : 'no match'}`;
}

/**
 * Format an error assertion result for human-readable display.
 *
 * @param result - The error assertion result to format
 * @returns A descriptive string like "error code=TOKEN_NOT_FOUND: matched"
 */
export function formatErrorAssertionDescription(result: ErrorAssertionResult): string {
  const parts: string[] = [];
  if (result.assertion.code !== undefined) parts.push(`code=${result.assertion.code}`);
  if (result.assertion.command !== undefined) parts.push(`command=${result.assertion.command}`);
  if (result.assertion.error !== undefined) parts.push(`error~=${result.assertion.error}`);
  const desc = parts.length > 0 ? parts.join(' ') : '(empty assertion)';
  return `error ${desc}: ${result.matched ? 'matched' : 'no match'}`;
}

/**
 * Extract runbook file references from a list of command strings.
 *
 * Scans each command for patterns matching `*.runbook.md` filenames,
 * naturally excluding surrounding shell quote characters. Returns
 * deduplicated results preserving insertion order.
 *
 * @param commands - Array of command strings to scan
 * @returns Array of unique runbook filenames found in the commands
 */
export function extractRunbookReferences(commands: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const pattern = /((?:\.\/)?[\w][\w.\-/]*\.runbook\.md)(?![\w.\-/])/g;

  for (const cmd of commands) {
    for (const match of cmd.matchAll(pattern)) {
      const ref = match[1];
      if (!seen.has(ref)) {
        seen.add(ref);
        result.push(ref);
      }
    }
  }

  return result;
}

/**
 * Extract relative file paths from `--input-file` arguments in command strings.
 *
 * Scans each command for `--input-file <path>` or `--input-file=<path>` patterns and returns
 * deduplicated results preserving insertion order.
 *
 * @param commands - Array of command strings to scan
 * @returns Array of unique relative file paths found in --input-file arguments
 */
export function extractInputFileReferences(commands: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const cmd of commands) {
    const trimmed = cmd.trimStart();
    const commandText = trimmed.startsWith('! ') ? trimmed.slice(2).trimStart() : cmd;
    const parsed = parseRdCommandWithEnv(commandText);
    if (!parsed) continue;
    const args = parsed.args;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      let filePath: string | undefined;
      if (arg === '--input-file' && i + 1 < args.length) {
        filePath = args[i + 1];
      } else if (arg.startsWith('--input-file=')) {
        filePath = arg.slice('--input-file='.length);
      }

      if (filePath !== undefined && !seen.has(filePath)) {
        seen.add(filePath);
        result.push(filePath);
      }
    }
  }

  return result;
}

/**
 * Execute a sequence of commands in order, accumulating transitions and tokens.
 *
 * Handles `rd` commands (JSON is the default output format) and generic
 * shell commands. Prefix a command with `! ` when a non-zero exit is the
 * expected outcome. Token placeholders (`${TOKEN}`, `${TOKEN_2}`, etc.) are
 * substituted with previously captured delegation tokens before each command
 * runs. Tokens are extracted from parsed JSON `delegate` responses.
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
  const capturedClaimIds: string[] = [];
  const errors: CapturedError[] = [];
  const transitions: CapturedTransition[] = [];
  let terminalResult: 'COMPLETE' | 'STOP' | 'UNKNOWN' = 'UNKNOWN';

  const { commands, cwd, cliPath, quiet, env } = options;

  for (const rawCmd of commands) {
    const trimmedRaw = rawCmd.trimStart();
    const expectsFailure = trimmedRaw.startsWith('! ');
    const commandText = expectsFailure ? trimmedRaw.slice(2).trimStart() : rawCmd;
    // Token substitution — replace ${TOKEN}, ${TOKEN_2}, etc. with captured values
    const cmd = substituteClaimIds(substituteTokens(commandText, capturedTokens), capturedClaimIds);

    options.onCommandStart?.(expectsFailure ? `! ${cmd}` : cmd);

    const rdCommand = parseRdCommandWithEnv(cmd);

    let stdout: string;

    if (rdCommand) {
      // rd command — parse args (JSON is the default output format)
      const commandEnv = { ...env, ...rdCommand.env };
      const result = await runCommandWithTee(
        { kind: 'rd', args: rdCommand.args },
        { cwd, quiet, cliPath, env: commandEnv },
      );
      stdout = result.stdout;

      // Parse JSON output to extract transitions, terminal state, and tokens
      const jsonResult = parseJsonLines(stdout);
      for (const t of jsonResult.transitions) {
        transitions.push(t);
      }
      for (const tok of jsonResult.tokens) {
        capturedTokens.push(tok);
      }
      for (const claimId of jsonResult.claimIds) {
        capturedClaimIds.push(claimId);
      }
      for (const error of jsonResult.errors) {
        errors.push(error);
      }
      if (jsonResult.terminal !== null) {
        terminalResult = jsonResult.terminal;
      }

      // If the command failed and no terminal result was parsed, propagate the failure
      if (expectsFailure && result.exitCode === 0) {
        throw new Error(`Command was expected to fail but exited 0: ${cmd}`);
      }
      if (!expectsFailure && result.exitCode !== 0 && jsonResult.terminal === null) {
        throw new Error(`Command failed with exit code ${String(result.exitCode)}: ${cmd}`);
      }
    } else {
      // Shell command — execute directly
      const result = await runCommandWithTee({ kind: 'shell', cmd }, { cwd, quiet, cliPath, env });
      stdout = result.stdout;
      if (expectsFailure && result.exitCode === 0) {
        throw new Error(`Shell command was expected to fail but exited 0: ${cmd}`);
      }
      if (!expectsFailure && result.exitCode !== 0) {
        throw new Error(`Shell command failed with exit code ${String(result.exitCode)}: ${cmd}`);
      }
    }
  }

  return { terminalResult, transitions, capturedTokens, capturedClaimIds, errors };
}
