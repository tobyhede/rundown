/**
 * Shared command execution logic for scenario and suite runners.
 *
 * Extracts duplicated execution logic into a reusable module used by
 * both scenario-workflow and scenario-suite command handlers.
 *
 * @module helpers/command-sequence
 */

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  isPublicArtifactRecord,
  redactRunSecret,
  RunbookRefSchema,
  type PublicArtifactRecord,
  type RunbookRef,
} from '@rundown-org/core';
import { parse as shellParse } from 'shell-quote';
import type {
  ArtifactAssertion,
  CollectedAssertion,
  EnteredAssertion,
  ErrorAssertion,
  StepAssertion,
  WarningAssertion,
} from '../schemas/scenarios.js';

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

/** A captured JSON warning response from command output. */
export interface CapturedWarning {
  /** Machine-readable warning code. */
  code?: string;
  /** Human-readable warning message. */
  message?: string;
  /** CLI command that triggered the warning. */
  command?: string;
}

/** Resolved artifacts captured from one `step_entered` event. */
export interface CapturedArtifactEntry {
  /** Qualified entered step position, if present on the event. */
  at?: string;
  /** Artifact working set keyed by ARTIFACTS alias. */
  artifacts: Record<string, PublicArtifactRecord | PublicArtifactRecord[] | undefined>;
  /** Runbook that produced the entered event (from event envelope). */
  runbook?: RunbookRef;
}

/** Captured metadata from one `step_entered` event. */
export interface CapturedEnteredStep {
  /** Qualified entered step position, if present on the event. */
  at?: string;
  /** Human-readable entered step or substep description. */
  description?: string;
  /** Runbook that produced the entered event (from event envelope). */
  runbook?: RunbookRef;
}

/** Timing record for one command executed by a scenario command sequence. */
export interface CommandTiming {
  /** Command text after placeholder substitution and expected-failure marker removal. */
  command: string;
  /** Whether the command was executed as a parsed Rundown command or shell command. */
  kind: 'rd' | 'shell';
  /** Command wall-clock duration in milliseconds, rounded to the nearest integer. */
  durationMs: number;
  /** Process exit code returned by the command. */
  exitCode: number;
  /** Whether this command was prefixed with `! ` and expected to fail. */
  expectedFailure: boolean;
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

/** Options that control scenario step assertion matching. */
export interface MatchStepAssertionOptions {
  /** Runbook filename/path applied to assertions that omit an explicit runbook. */
  defaultRunbook?: string;
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

/** Result of matching a single warning assertion against captured JSON warnings. */
export interface WarningAssertionResult {
  /** The assertion that was evaluated */
  assertion: WarningAssertion;
  /** Whether a matching warning was found */
  matched: boolean;
  /** The warning that matched, if any */
  matchedWarning?: CapturedWarning;
}

/** Result of matching a single artifact assertion against captured artifacts. */
export interface ArtifactAssertionResult {
  /** The assertion that was evaluated */
  assertion: ArtifactAssertion;
  /** Whether a matching artifact entry was found */
  matched: boolean;
  /** The event that matched (if any) */
  matchedEntry?: CapturedArtifactEntry;
  /** Artifact records matched for the assertion's alias (if any) */
  matchedRecords?: PublicArtifactRecord[];
}

/** Result of matching a single entered-step assertion against captured events. */
export interface EnteredAssertionResult {
  /** The assertion that was evaluated */
  assertion: EnteredAssertion;
  /** Whether a matching event was found */
  matched: boolean;
  /** The event that matched (if any) */
  matchedEntry?: CapturedEnteredStep;
}

/** One child a `children_collected` event reported (#904). */
export interface CapturedCollectedChild {
  /** The parent unit (`step.substep`). */
  readonly step: string;
  /** The FOR iteration, inside a loop. */
  readonly index?: number;
  /** The child run. */
  readonly runId: string;
  /** How Collect found the child. */
  readonly status: string;
  /** The Child Result, once terminal. */
  readonly result?: string;
}

/** Result of matching one collected-child assertion. */
export interface CollectedAssertionResult {
  /** The assertion. */
  assertion: CollectedAssertion;
  /** Whether a reported child matched it, in order. */
  matched: boolean;
  /** The child it matched. */
  matchedChild?: CapturedCollectedChild;
}

/** Result of executing a command sequence. */
export interface CommandSequenceResult {
  /** Terminal outcome determined from JSON output */
  terminalResult: 'COMPLETE' | 'STOP' | 'UNKNOWN';
  /** All captured step transitions */
  transitions: CapturedTransition[];
  /** The `${TOKEN}` row of the placeholder capture, in emission order */
  capturedTokens: string[];
  /** The `${RUN_ID}` row of the placeholder capture, in emission order */
  capturedRunIds: string[];
  /** JSON error responses captured from command output */
  errors: CapturedError[];
  /** JSON warning responses captured from command output */
  warnings: CapturedWarning[];
  /** Artifact working sets captured from step_entered events */
  artifactEntries: CapturedArtifactEntry[];
  /** Step-entered metadata captured from step_entered events */
  enteredSteps: CapturedEnteredStep[];
  /** Children reported by `children_collected` events (#904), in order */
  collectedChildren: CapturedCollectedChild[];
  /** Per-command timing records captured during execution */
  commandTimings: CommandTiming[];
}

/** Options passed to a command executor. */
export interface CommandExecutionOptions {
  /** Working directory for execution. */
  cwd: string;
  /** Whether to suppress stdout/stderr passthrough. */
  quiet: boolean;
  /** Path to the CLI entry point for subprocess rd fallback. */
  cliPath: string;
  /** Optional environment variables merged into command env. */
  env?: Record<string, string | undefined>;
}

/** Result returned by a command executor. */
export interface CommandExecutionResult {
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
  /** Process-style exit code. */
  exitCode: number;
}

/** Optional command execution injection seam for scenario runners. */
export interface CommandSequenceExecutor {
  /** Execute a parsed rd/rundown command. */
  runRd?: (args: string[], options: CommandExecutionOptions) => Promise<CommandExecutionResult>;
  /** Execute a shell command. Defaults to subprocess execution when omitted. */
  runShell?: (cmd: string, options: CommandExecutionOptions) => Promise<CommandExecutionResult>;
}

/**
 * Callable used to execute the CLI inside the current Node.js process.
 *
 * @param input - In-process CLI invocation details.
 * @returns Captured process-style command output.
 */
export type InProcessCliRunner = (input: {
  /** Arguments passed to the Rundown CLI, excluding the executable name. */
  args: string[];
  /** Working directory for execution. */
  cwd: string;
  /** Optional environment variables merged into the invocation environment. */
  env?: Record<string, string | undefined>;
}) => Promise<CommandExecutionResult>;

/**
 * Create the shared in-process scenario command executor when enabled.
 *
 * @param runCliInProcess - Callable that executes the CLI in-process.
 * @returns A command sequence executor when `RUNDOWN_SCENARIO_IN_PROCESS=1`, otherwise undefined.
 */
export function createInProcessCommandExecutor(
  runCliInProcess: InProcessCliRunner,
): CommandSequenceExecutor | undefined {
  if (process.env.RUNDOWN_SCENARIO_IN_PROCESS !== '1') {
    return undefined;
  }

  return {
    runRd: (args, options) =>
      runCliInProcess({
        args,
        cwd: options.cwd,
        env: options.env,
      }),
  };
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
  /** Optional callback invoked after each command completes */
  onCommandComplete?: (timing: CommandTiming) => void;
  /** Optional executor for rd and shell commands. */
  commandExecutor?: CommandSequenceExecutor;
  /**
   * Optional resolver for `${CAPTURE_ARTIFACT[_ARRAY]:<key>}` placeholders,
   * applied before each command. Lets a scenario hand a produced artifact's
   * `rd://` URI to a later command. The resolver reads the manifest (injected by
   * the scenario harness so the runner stays filesystem-agnostic).
   */
  resolveCapturedArtifact?: CapturedArtifactResolver;
}

/** Parsed `rd` command with command-scoped environment assignments. */
export interface ParsedRdCommand {
  /** Arguments passed to the Rundown CLI, excluding the `rd` executable. */
  args: string[];
  /** Environment assignments that apply only to this command. */
  env: Record<string, string>;
}

const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*/;

/**
 * Whether detailed scenario timing diagnostics are enabled.
 *
 * @returns True when detailed timing records should be emitted.
 */
export function isScenarioTimingEnabled(): boolean {
  return process.env.RUNDOWN_SCENARIO_COMMAND_TIMINGS === '1';
}

/**
 * Emit a scenario timing record to stderr when detailed timing is enabled.
 *
 * @param record - JSON-serializable timing record to emit.
 */
export function emitScenarioTiming(record: Record<string, unknown>): void {
  if (!isScenarioTimingEnabled()) {
    return;
  }
  process.stderr.write(`SCENARIO_TIMING ${JSON.stringify(record)}\n`);
}

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
 * One scenario placeholder family: `${NAME}` / `${NAME_n}` (1-based `n`),
 * substituted from values captured in emission order from earlier command
 * output.
 *
 * Table-driven on purpose: Delegation (#904) added `${TICKET}`,
 * `${CHILD_TOKEN}` and `${CHILD_RUN}` as rows, not code paths.
 */
export interface CapturePlaceholder {
  /** Placeholder name as written in a scenario command (`TOKEN` for `${TOKEN}`). */
  readonly name: string;
  /** What the placeholder stands for, for the "not captured yet" error. */
  readonly describe: string;
  /**
   * Read every value this placeholder captures from one parsed JSON object of
   * a command's stdout, in the order they appear.
   */
  readonly capture: (value: Record<string, unknown>) => readonly string[];
}

/**
 * Whether a parsed `runbook_started` object announces a Delegation started by
 * `rundown claim` (#904): it names its parent.
 *
 * @param value - One parsed JSON object of a command's stdout.
 * @returns True for a claimed child's start.
 */
function isClaimedStart(value: Record<string, unknown>): boolean {
  return value.type === 'runbook_started' && value.parent !== undefined;
}

/**
 * The placeholder table.
 *
 * - `${TOKEN[_n]}` — the n-th Owner Token printed on a `runbook_started`
 *   event (`owner_token`) by `rundown run`. A scenario's own `rundown run`
 *   supplies `${TOKEN}`; later starts in the same scenario supply the higher
 *   indexes.
 * - `${RUN_ID[_n]}` — the n-th run id (`runbookId`) on a `runbook_started`
 *   event that is not a claimed Delegation, for selector and status
 *   assertions (`status --run ${RUN_ID}`).
 * - `${TICKET[_n]}` — the n-th Claim Ticket listed in the `children` of a
 *   `step_entered` (#904) or `delegation_retried` (#905) event, in listing
 *   order.
 * - `${CHILD_TOKEN[_n]}` / `${CHILD_RUN[_n]}` — the Owner Token and run id
 *   of the n-th Delegation `rundown claim` started (its `runbook_started`
 *   names its `parent`).
 */
export const CAPTURE_PLACEHOLDERS: readonly CapturePlaceholder[] = [
  {
    name: 'TOKEN',
    describe: 'owner token from runbook_started.owner_token',
    capture: (value) =>
      value.type === 'runbook_started' &&
      !isClaimedStart(value) &&
      typeof value.owner_token === 'string'
        ? [value.owner_token]
        : [],
  },
  {
    name: 'RUN_ID',
    describe: 'run id from runbook_started.runbookId',
    capture: (value) =>
      value.type === 'runbook_started' &&
      !isClaimedStart(value) &&
      typeof value.runbookId === 'string'
        ? [value.runbookId]
        : [],
  },
  {
    name: 'TICKET',
    describe: 'claim ticket from step_entered / delegation_retried children[].ticket',
    capture: (value) =>
      (value.type === 'step_entered' || value.type === 'delegation_retried') &&
      Array.isArray(value.children)
        ? value.children.flatMap((child: unknown) =>
            typeof child === 'object' &&
            child !== null &&
            typeof (child as { ticket?: unknown }).ticket === 'string'
              ? [(child as { ticket: string }).ticket]
              : [],
          )
        : [],
  },
  {
    name: 'CHILD_TOKEN',
    describe: 'owner token from the runbook_started a rundown claim printed',
    capture: (value) =>
      isClaimedStart(value) && typeof value.owner_token === 'string' ? [value.owner_token] : [],
  },
  {
    name: 'CHILD_RUN',
    describe: 'run id from the runbook_started a rundown claim printed',
    capture: (value) =>
      isClaimedStart(value) && typeof value.runbookId === 'string' ? [value.runbookId] : [],
  },
];

/** Captured values per placeholder name, in emission order. */
export type CapturedPlaceholders = Map<string, string[]>;

/**
 * Create an empty capture accumulator with one entry per placeholder row.
 *
 * @returns Empty accumulator
 */
export function createCapturedPlaceholders(): CapturedPlaceholders {
  return new Map(CAPTURE_PLACEHOLDERS.map((placeholder) => [placeholder.name, []]));
}

/**
 * Substitute one placeholder family in a command string.
 *
 * `${NAME}` maps to `values[0]`, `${NAME_2}` maps to `values[1]`, etc.
 *
 * @param cmd - The command string with optional placeholders
 * @param placeholder - The placeholder row being substituted
 * @param values - Captured values for that row, in order
 * @returns The command string with placeholders replaced by captured values
 * @throws {Error} When a placeholder references a value that has not been captured yet
 */
export function substitutePlaceholder(
  cmd: string,
  placeholder: CapturePlaceholder,
  values: readonly string[],
): string {
  const pattern = new RegExp(`\\$\\{${placeholder.name}(?:_(\\d+))?\\}`, 'g');
  return cmd.replace(pattern, (match: string, indexStr: string | undefined) => {
    const idx = indexStr ? parseInt(indexStr, 10) - 1 : 0;
    if (idx < 0 || idx >= values.length) {
      throw new Error(
        `Placeholder ${match} references an uncaptured ${placeholder.describe} (have ${String(values.length)})`,
      );
    }
    return values[idx];
  });
}

/**
 * Substitute every placeholder family in a command string.
 *
 * @param cmd - The command string with optional placeholders
 * @param captured - Values captured so far, per placeholder
 * @returns The command string with every placeholder replaced
 * @throws {Error} When a placeholder references a value that has not been captured yet
 */
export function substitutePlaceholders(cmd: string, captured: CapturedPlaceholders): string {
  let out = cmd;
  for (const placeholder of CAPTURE_PLACEHOLDERS) {
    out = substitutePlaceholder(out, placeholder, captured.get(placeholder.name) ?? []);
  }
  return out;
}

/**
 * The values captured so far for one placeholder row.
 *
 * @param captured - Placeholder accumulator
 * @param name - Placeholder row name (`TOKEN` for `${TOKEN}`)
 * @returns The row's values, in emission order (empty when none yet)
 */
export function capturedValues(captured: CapturedPlaceholders, name: string): readonly string[] {
  return captured.get(name) ?? [];
}

/**
 * Capture every placeholder row's values, and every collected child, from one
 * parsed JSON object of a command's stdout.
 *
 * @param value - One parsed JSON object, in emission order
 * @param captured - Placeholder accumulator the values are appended to
 * @param collected - Collected-children accumulator (#904)
 */
function captureFromJsonObject(
  value: Record<string, unknown>,
  captured: CapturedPlaceholders,
  collected: CapturedCollectedChild[],
): void {
  for (const placeholder of CAPTURE_PLACEHOLDERS) {
    captured.get(placeholder.name)?.push(...placeholder.capture(value));
  }
  if (value.type === 'children_collected' && Array.isArray(value.children)) {
    for (const child of value.children as Record<string, unknown>[]) {
      if (typeof child.step !== 'string' || typeof child.runId !== 'string') continue;
      collected.push({
        step: child.step,
        ...(typeof child.index === 'number' ? { index: child.index } : {}),
        runId: child.runId,
        status: String(child.status),
        ...(typeof child.result === 'string' ? { result: child.result } : {}),
      });
    }
  }
}

/**
 * Match collected-child assertions against the children `rundown collect`
 * reported, using ordered skip-matching.
 *
 * @param assertions - Ordered list of collected-child assertions
 * @param children - Captured children, in report order
 * @returns One result per assertion, in order
 */
export function matchCollectedAssertions(
  assertions: readonly CollectedAssertion[],
  children: readonly CapturedCollectedChild[],
): CollectedAssertionResult[] {
  const results: CollectedAssertionResult[] = [];
  let index = 0;
  for (const assertion of assertions) {
    let matchedChild: CapturedCollectedChild | undefined;
    while (index < children.length && matchedChild === undefined) {
      const child = children[index];
      index++;
      if (
        (assertion.step === undefined || assertion.step === child.step) &&
        (assertion.index === undefined || assertion.index === child.index) &&
        (assertion.status === undefined || assertion.status === child.status) &&
        (assertion.result === undefined || assertion.result === child.result)
      ) {
        matchedChild = child;
      }
    }
    results.push(
      matchedChild === undefined
        ? { assertion, matched: false }
        : { assertion, matched: true, matchedChild },
    );
  }
  return results;
}

/**
 * Format a collected-child assertion result for display.
 *
 * @param ca - The result
 * @returns A description such as "collected step=1.1 status=pending"
 */
export function formatCollectedAssertionDescription(ca: CollectedAssertionResult): string {
  const parts: string[] = [];
  if (ca.assertion.step !== undefined) parts.push(`step=${ca.assertion.step}`);
  if (ca.assertion.index !== undefined) parts.push(`index=${String(ca.assertion.index)}`);
  if (ca.assertion.status !== undefined) parts.push(`status=${ca.assertion.status}`);
  if (ca.assertion.result !== undefined) parts.push(`result=${ca.assertion.result}`);
  return `collected ${parts.join(' ')}`;
}

/**
 * Substitute captured Owner Token placeholders in a command string.
 *
 * `${TOKEN}` maps to `tokens[0]`, `${TOKEN_2}` maps to `tokens[1]`, etc.
 *
 * @param cmd - The command string with optional token placeholders
 * @param tokens - Array of captured Owner Tokens in order
 * @returns The command string with placeholders replaced by actual tokens
 * @throws {Error} When a placeholder references a token that hasn't been captured yet
 */
export function substituteTokens(cmd: string, tokens: readonly string[]): string {
  return substitutePlaceholder(cmd, CAPTURE_PLACEHOLDERS[0], tokens);
}

/**
 * Substitute captured run id placeholders in a command string.
 *
 * `${RUN_ID}` maps to the first captured run id, `${RUN_ID_2}` maps to the
 * second, and so on. Mutating scenario commands use `${TOKEN}` for
 * authority; `${RUN_ID}` remains available for selector/status assertions.
 *
 * @param command - Command string with optional run id placeholders
 * @param capturedRunIds - Run ids captured from earlier `runbook_started` events
 * @returns Command string with run id placeholders substituted
 * @throws {Error} If a placeholder references a run id that has not been captured
 */
export function substituteRunIds(command: string, capturedRunIds: readonly string[]): string {
  return substitutePlaceholder(command, CAPTURE_PLACEHOLDERS[1], capturedRunIds);
}

/**
 * Resolver that maps a captured artifact key to its current `rd://` URI(s) from
 * the manifest.
 *
 * @param key - The captured artifact key to resolve.
 * @param asArray - When `true`, resolve to a JSON array of all matching URIs;
 *   when `false`, resolve to the single latest scalar URI for the key.
 * @returns Promise of the resolved substitution text — a JSON array string of
 *   URIs when `asArray` is `true`, otherwise the latest scalar `rd://` URI.
 */
export type CapturedArtifactResolver = (key: string, asArray: boolean) => Promise<string>;

/**
 * Substitute post-run captured artifact placeholders in a command string.
 *
 * `${CAPTURE_ARTIFACT:<key>}` is replaced by the `rd://` URI of the most recent
 * manifest row for `<key>`; `${CAPTURE_ARTIFACT_ARRAY:<key>}` is replaced by a
 * JSON array of all such URIs. This is the sole artifact grammar: values are
 * resolved at execution time from rows a prior command actually produced, so a
 * scenario hands a real produced artifact to a later run via `--artifacts` /
 * `--artifacts-json`. A scenario needing a pre-existing artifact runs a producer
 * runbook first (see `runbooks/artifacts/scenario-seed-artifacts.runbook.md`)
 * rather than fabricating a URI. Scenario-harness only; the resolver reads the
 * manifest.
 *
 * @param cmd - The command string with optional capture placeholders
 * @param resolve - Async resolver mapping a key (and array flag) to its substitution text
 * @returns Promise of the command string with capture placeholders replaced
 * @throws {Error} When the resolver cannot satisfy a referenced key
 */
export async function substituteCapturedArtifacts(
  cmd: string,
  resolve: CapturedArtifactResolver,
): Promise<string> {
  // `String.prototype.replace` cannot await an async callback, so collect every
  // placeholder match first, resolve them concurrently, then splice the resolved
  // values back in match order.
  const matches = [...cmd.matchAll(/\$\{CAPTURE_ARTIFACT(_ARRAY)?:([^}]+)\}/g)];
  if (matches.length === 0) {
    return cmd;
  }
  // The `_ARRAY` capture group is literally `'_ARRAY'` when present and absent
  // otherwise, so an exact compare both detects the array form and stays
  // type-clean (`RegExpExecArray` group/index access is typed non-nullable).
  const replacements = await Promise.all(
    matches.map((match) => resolve(match[2], match[1] === '_ARRAY')),
  );
  let result = '';
  let last = 0;
  matches.forEach((match, index) => {
    const start = match.index;
    result += cmd.slice(last, start) + replacements[index];
    last = start + match[0].length;
  });
  return result + cmd.slice(last);
}

/**
 * Non-global detector for `${CAPTURE_ARTIFACT[_ARRAY]:<key>}` placeholders.
 *
 * Mirrors the substitution pattern in {@link substituteCapturedArtifacts} so a
 * command carrying a capture placeholder can be rejected when no resolver is
 * wired, rather than letting the raw placeholder leak into the executed command.
 */
const CAPTURE_ARTIFACT_PLACEHOLDER = /\$\{CAPTURE_ARTIFACT(?:_ARRAY)?:[^}]+\}/;

/**
 * Non-global detector for the **retired** `${ARTIFACT:<name>}` grammar (#498).
 *
 * `${ARTIFACT:…}` and its `seed:` directive were removed in favour of a single
 * capture-from-output mechanism. Without this detector the retired placeholder
 * has no substituter left, so it would pass through verbatim into `--artifacts`
 * and surface as an opaque `INVALID_ARTIFACT_INPUT` — the precise confusion the
 * retirement exists to prevent. This is a tombstone, not a compatibility shim:
 * it makes the retired grammar fail loudly and name its replacement, rather than
 * keeping it working.
 *
 * Deliberately matches `[^}]*` rather than the retired grammar's narrower
 * identifier pattern, so a *malformed* retired placeholder is caught too —
 * including the empty-bodied `${ARTIFACT:}`, which is the exact spelling this
 * detector's own error message uses to name the retirement. It cannot match
 * `${CAPTURE_ARTIFACT…}`, whose text contains `ARTIFACT:` but never the
 * required `${` immediately before it.
 */
const RETIRED_ARTIFACT_PLACEHOLDER = /\$\{ARTIFACT:[^}]*\}/;

/** Global matcher for the array form, used to locate placeholders to probe. */
const CAPTURE_ARTIFACT_ARRAY_PLACEHOLDER = /\$\{CAPTURE_ARTIFACT_ARRAY:([^}]+)\}/g;

/**
 * Stand-in for a resolved array value, used to ask `shellParse` whether a real
 * resolved value would survive at the same position.
 *
 * Covers every shell-significant character a real value can contain. A resolved
 * array is `JSON.stringify` of `rd://` URIs (`scenario-artifacts.ts:130`), whose
 * character set is closed under `assertSafeId` (`[A-Za-z0-9._-]`, `paths.ts:34`)
 * plus the URI's `/` and `:` and JSON's `[`, `]`, `"`, `,`. Of those, only `"`
 * and `[`/`]` are shell-significant, and the probe contains all three — so a
 * probe that survives implies a real value survives.
 */
const ARRAY_QUOTING_PROBE = '["rd://s"]';

/**
 * Pick a probe value that does not already occur in `cmd`.
 *
 * The guard counts how many probes survive tokenization and compares that to the
 * number of placeholders. Any occurrence of the probe's literal text that the
 * guard did not itself substitute would inflate that count and reject a
 * correctly quoted command — a collision with the guard's own instrument rather
 * than an authoring error. Widening the probe until it is absent keeps the count
 * attributable to substitution alone, while preserving the shell-significant
 * characters (`"`, `[`, `]`) the probe exists to exercise.
 *
 * @param cmd - Command text the probe will be substituted into
 * @returns A probe string guaranteed not to occur in `cmd`
 */
function uniqueArrayQuotingProbe(cmd: string): string {
  let probe = ARRAY_QUOTING_PROBE;
  for (let n = 0; cmd.includes(probe); n++) {
    probe = `["rd://s${String(n)}"]`;
  }
  return probe;
}

/**
 * Reject an `${CAPTURE_ARTIFACT_ARRAY:<key>}` placeholder that is not shell-quoted.
 *
 * The array form resolves to JSON containing `"` characters, which are spliced
 * into command text and then re-tokenized by `shellParse` via
 * {@link parseRdCommandWithEnv}. Unquoted, the shell consumes those quotes and
 * `["rd://a","rd://b"]` arrives as the unparseable `[rd://a,rd://b]`, failing
 * with an error naming a value the author never wrote. The scalar form needs no
 * such guard: its resolved values cannot contain a shell metacharacter.
 *
 * Implemented by probing the real tokenizer rather than by matching quotes with
 * a regex: authors quote the whole assignment (`'K=${...}'`), not the
 * placeholder, so an adjacency regex false-rejects every real call site.
 *
 * Deliberately throwaway: under the deferred parse-then-substitute refactor
 * (#498 follow-up) resolved values never reach `shellParse` and this guard is
 * deleted with the hazard it guards.
 *
 * @param cmd - Command text after token substitution, placeholders still intact
 * @throws {Error} When any array placeholder would not survive shell tokenization
 */
function assertArrayCapturesAreShellQuoted(cmd: string): void {
  const keys = [...cmd.matchAll(CAPTURE_ARTIFACT_ARRAY_PLACEHOLDER)].map((m) => m[1]);
  if (keys.length === 0) return;
  const probeValue = uniqueArrayQuotingProbe(cmd);
  const probe = cmd.replace(CAPTURE_ARTIFACT_ARRAY_PLACEHOLDER, probeValue);
  let survived: number;
  try {
    // Count probe *occurrences*, not entries containing one: two placeholders
    // can legitimately land in a single quoted argv entry.
    survived = shellParse(probe)
      .filter((entry): entry is string => typeof entry === 'string')
      .reduce((n, entry) => n + entry.split(probeValue).length - 1, 0);
  } catch {
    survived = -1;
  }
  if (survived !== keys.length) {
    throw new Error(
      `Command uses \${CAPTURE_ARTIFACT_ARRAY:${keys[0]}} without shell quoting: ${cmd}\n` +
        `The array form resolves to JSON containing double quotes; unquoted, the shell strips ` +
        `them and the value arrives as invalid JSON. Single-quote the assignment, e.g. ` +
        `--artifacts-json 'Key=\${CAPTURE_ARTIFACT_ARRAY:${keys[0]}}'.`,
    );
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
  options: CommandExecutionOptions & { commandExecutor?: CommandSequenceExecutor },
): Promise<CommandExecutionResult> {
  if (command.kind === 'rd' && options.commandExecutor?.runRd) {
    const result = await options.commandExecutor.runRd(command.args, options);
    if (!options.quiet) {
      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
    }
    return result;
  }

  if (command.kind === 'shell' && options.commandExecutor?.runShell) {
    const result = await options.commandExecutor.runShell(command.cmd, options);
    if (!options.quiet) {
      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
    }
    return result;
  }

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
      child = spawn(process.env.SHELL ?? '/bin/sh', ['-c', command.cmd], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: options.cwd,
        env: spawnEnv,
      });
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      if (!options.quiet) {
        process.stdout.write(chunk);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      if (!options.quiet) {
        process.stderr.write(chunk);
      }
    });

    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        exitCode: code ?? 1,
      });
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Everything one command's stdout yields besides its terminal state: the single
 * capture model shared by placeholder substitution, root scoping and the
 * scenario assertions.
 */
export interface ParsedCommandOutput {
  /** Step transitions from streamed `step_transitioned` events */
  transitions: CapturedTransition[];
  /** Placeholder values per row (`${TOKEN}`, `${RUN_ID}`, `${TICKET}`, ...), in emission order */
  captured: CapturedPlaceholders;
  /** Children reported by `children_collected` events (#904), in order */
  collectedChildren: CapturedCollectedChild[];
  /** JSON error responses */
  errors: CapturedError[];
  /** JSON warning responses */
  warnings: CapturedWarning[];
  /** Artifact working sets from `step_entered` events */
  artifactEntries: CapturedArtifactEntry[];
  /** Step-entered metadata from `step_entered` events */
  enteredSteps: CapturedEnteredStep[];
}

/**
 * Create an empty parsed-output accumulator.
 *
 * @returns Empty accumulator
 */
function createParsedCommandOutput(): ParsedCommandOutput {
  return {
    transitions: [],
    captured: createCapturedPlaceholders(),
    collectedChildren: [],
    errors: [],
    warnings: [],
    artifactEntries: [],
    enteredSteps: [],
  };
}

/**
 * Process a single parsed JSON object to extract transitions and terminal state.
 *
 * @param obj - A parsed JSON object from command output
 * @param into - Accumulator the object's observations are appended to
 * @returns Terminal state detected from this object, or null
 */
function processJsonObject(
  obj: Record<string, unknown>,
  into: ParsedCommandOutput,
): 'COMPLETE' | 'STOP' | null {
  const { transitions, errors, warnings, artifactEntries, enteredSteps } = into;
  let terminal: 'COMPLETE' | 'STOP' | null = null;

  // Streamed execution event lines have a `type` field
  if (obj.type === 'step_transitioned') {
    const parsedRunbook = RunbookRefSchema.safeParse(obj.runbook);
    transitions.push({
      action: obj.action as string,
      from: obj.from as string,
      at: obj.at as string,
      result: obj.result as 'PASS' | 'FAIL',
      command: obj.command as string | undefined,
      aggregated: obj.aggregated === true ? true : undefined,
      runbook: parsedRunbook.success ? parsedRunbook.data : undefined,
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

  captureFromJsonObject(obj, into.captured, into.collectedChildren);

  if (obj.kind === 'error') {
    errors.push({
      code: typeof obj.code === 'string' ? obj.code : undefined,
      error: typeof obj.error === 'string' ? obj.error : undefined,
      command: typeof obj.command === 'string' ? obj.command : undefined,
    });
  }

  if (obj.kind === 'warning') {
    warnings.push({
      code: typeof obj.code === 'string' ? obj.code : undefined,
      message: typeof obj.message === 'string' ? obj.message : undefined,
      command: typeof obj.command === 'string' ? obj.command : undefined,
    });
  }

  if (obj.type === 'step_entered') {
    const parsedRunbook = RunbookRefSchema.safeParse(obj.runbook);
    enteredSteps.push({
      at: extractEnteredPosition(obj.position),
      description: typeof obj.description === 'string' ? obj.description : undefined,
      runbook: parsedRunbook.success ? parsedRunbook.data : undefined,
    });

    const parsedArtifacts = parseCapturedArtifacts(obj.artifacts);
    if (parsedArtifacts !== null) {
      artifactEntries.push({
        at: extractEnteredPosition(obj.position),
        artifacts: parsedArtifacts,
        runbook: parsedRunbook.success ? parsedRunbook.data : undefined,
      });
    }
  }

  return terminal;
}

function extractEnteredPosition(position: unknown): string | undefined {
  if (position === null || typeof position !== 'object') {
    return undefined;
  }
  const current = (position as { current?: unknown }).current;
  if (typeof current !== 'string') {
    return undefined;
  }
  const substep = (position as { substep?: unknown }).substep;
  const forPosition = (position as { for?: unknown }).for;
  const forIndex =
    forPosition !== null && typeof forPosition === 'object'
      ? (forPosition as { index?: unknown }).index
      : undefined;
  const iteration =
    typeof forIndex === 'number' || typeof forIndex === 'string' ? String(forIndex) : undefined;
  if (iteration !== undefined && typeof substep === 'string') {
    return `${current}.${iteration}.${substep}`;
  }
  if (iteration !== undefined) {
    return `${current}.${iteration}`;
  }
  if (typeof substep === 'string') {
    return `${current}.${substep}`;
  }
  return current;
}

function parseCapturedArtifacts(
  value: unknown,
): Record<string, PublicArtifactRecord | PublicArtifactRecord[] | undefined> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const artifacts: Record<string, PublicArtifactRecord | PublicArtifactRecord[] | undefined> = {};
  for (const [alias, artifactValue] of Object.entries(value)) {
    if (isPublicArtifactRecord(artifactValue)) {
      artifacts[alias] = artifactValue;
      continue;
    }
    if (Array.isArray(artifactValue) && artifactValue.every(isPublicArtifactRecord)) {
      artifacts[alias] = artifactValue;
    }
  }

  return artifacts;
}

// A run-scoped terminal observation for the scenario's root run. Lifecycle
// events carry `runbookId`; the trailing action object never does, because it is
// the command's own envelope for whichever run the command targeted (see
// docs/spec/cli-output.md: streamed observations precede the final action
// object, which is the last line). For inline composition those two are
// different runs — `rd pass` on the last child of a FAIL ANY step completes the
// CHILD while the composing root STOPs — so a positional "last terminal line
// wins" rule reads the child's envelope and loses the root's outcome.
function rootScopedTerminal(
  obj: Record<string, unknown>,
  rootRunId: string | undefined,
): 'COMPLETE' | 'STOP' | null {
  if (rootRunId === undefined || obj.runbookId !== rootRunId) return null;
  if (obj.type === 'runbook_completed') return 'COMPLETE';
  if (obj.type === 'runbook_stopped') return 'STOP';
  return null;
}

/**
 * Whether a JSON line is a lifecycle terminal event of a run other than the
 * scenario's root.
 *
 * @param obj - A parsed JSON line.
 * @param rootRunId - The root run, once known.
 * @returns True for another run's `runbook_completed` / `runbook_stopped`.
 */
function isOtherRunsLifecycleTerminal(
  obj: Record<string, unknown>,
  rootRunId: string | undefined,
): boolean {
  if (obj.type !== 'runbook_completed' && obj.type !== 'runbook_stopped') return false;
  return (
    rootRunId !== undefined && typeof obj.runbookId === 'string' && obj.runbookId !== rootRunId
  );
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
 * A scenario's result is the root run's outcome. When this command's output
 * carries a lifecycle terminal for `rootRunId`, that observation wins over the
 * positional scan, whatever the trailing action object says about the run the
 * command targeted. Without such an observation the positional scan stands, so
 * single-run output is unaffected. A lifecycle terminal of any other run is
 * never the result, whether it arrives as NDJSON or as a lone object.
 *
 * When `rootRunId` is omitted — the command that STARTS the root run — the
 * payload's own first `runbook_started` becomes the root for the rest of that
 * payload. A starting command can already carry two runs' terminals, so leaving
 * root scoping inert there would hand that exact case back to the positional
 * scan this function exists to override.
 *
 * @param stdout - Raw stdout string from an rd command (JSON is the default output)
 * @param rootRunId - Run id of the scenario's root run, when already observed;
 *   omitted for the command that starts it, which then supplies its own
 * @returns Object with extracted transitions and terminal result (or null if not determined)
 */
export function parseJsonLines(
  stdout: string,
  rootRunId?: string,
): ParsedCommandOutput & { terminal: 'COMPLETE' | 'STOP' | null } {
  const output = createParsedCommandOutput();
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { ...output, terminal: null };
  }
  let terminal: 'COMPLETE' | 'STOP' | null = null;

  // Try parsing as a single JSON object first (handles pretty-printed output)
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Not a JSON object');
    }
    const obj = parsed as Record<string, unknown>;
    // Root scoping applies here as it does to NDJSON: a lone object can be
    // another run's lifecycle terminal — `rundown pass --token ${CHILD_TOKEN}`
    // completing a Delegation (#904) — and that is never the scenario's
    // outcome. The root's own terminal, and any terminal before the root is
    // known, keep what `processJsonObject` maps them to.
    const detected = processJsonObject(obj, output);
    terminal = isOtherRunsLifecycleTerminal(obj, rootRunId) ? null : detected;
    return { ...output, terminal };
  } catch {
    // Not a single JSON object — fall through to line-by-line parsing
  }

  // Line-by-line NDJSON parsing
  let rootTerminal: 'COMPLETE' | 'STOP' | null = null;
  // The caller's `rootRunId` is undefined for the command that STARTS the root
  // run, and that command's own output can already carry both runs' terminals —
  // `rundown run` on an inline-composing runbook streams the root's
  // `runbook_started`, the child's, and then both terminals in one payload. So
  // adopt the payload's own first `runbook_started` as the root when the caller
  // has none, or root scoping is inert exactly where the positional rule is
  // most likely to read the child's outcome.
  let effectiveRootId = rootRunId;
  const lines = trimmed.split('\n').filter(Boolean);
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // Non-JSON line — skip
    }

    const detected = processJsonObject(obj, output);
    // `processJsonObject` has just captured this line's `${RUN_ID}`, so the
    // row's first value is the payload's first root `runbook_started` — never
    // a claimed Delegation's start, which the row excludes.
    effectiveRootId ??= capturedValues(output.captured, 'RUN_ID')[0];
    // A lifecycle terminal of another run — an Inline Child completing or
    // stopping while its root carries on (#903) — is not the scenario's
    // outcome, positionally or otherwise. Only run-less flushed objects and
    // the root's own lifecycle events reach the positional scan.
    if (detected !== null && !isOtherRunsLifecycleTerminal(obj, effectiveRootId)) {
      terminal = detected;
    }
    const rootDetected = rootScopedTerminal(obj, effectiveRootId);
    if (rootDetected !== null) {
      rootTerminal = rootDetected;
    }
  }

  // Two ordering rules meet here, and both are assumptions about what one
  // command's payload can contain rather than facts the parser enforces.
  //
  // 1. A root-scoped observation beats the positional scan unconditionally.
  //    That is the point of root scoping: the trailing action object describes
  //    whichever run the command targeted, which under inline composition is
  //    the child, not the root.
  // 2. Within the payload the LAST root-scoped terminal wins. The root can
  //    only terminate once per command, so this matters only if a payload
  //    could carry the root's terminal and then a second, different run's --
  //    and in that case the root's still wins, because rule 1 discards the
  //    other run's line before it is ever compared.
  //
  // What neither rule survives is one command's payload carrying two DIFFERENT
  // terminals for the SAME root run. Reaching that needs two `rd` invocations
  // chained inside a single scenario command (`rd complete && rd run next.md`)
  // or behind a wrapper script, so that one captured stdout spans two runs of
  // the harness. No scenario does this today: across all 331 -- 285 declared in
  // runbook frontmatter plus 46 `cases:` in `runbooks/scenario-suite.yaml`, and
  // the suite file is easy to miss when counting -- no single `commands:` entry
  // contains two `rd`/`rundown` invocations, and the only two entries carrying a
  // shell operator at all (`node -e` fault injection, a `printf` redirect)
  // invoke neither. So the last-wins rule is never exercised against a
  // conflicting root terminal.
  return { ...output, terminal: rootTerminal ?? terminal };
}

/**
 * Determine whether a single captured transition event matches a step assertion.
 *
 * Only specified (non-undefined) assertion fields are checked.
 *
 * @param event - The captured transition event to test
 * @param assertion - The assertion to match against
 * @param options - Matching options
 * @returns True when all specified assertion fields match the event
 */
function eventMatchesAssertion(
  event: CapturedTransition,
  assertion: StepAssertion,
  options: MatchStepAssertionOptions = {},
): boolean {
  if (assertion.at !== undefined && event.at !== assertion.at) return false;
  if (assertion.from !== undefined && event.from !== assertion.from) return false;
  if (assertion.action !== undefined && event.action !== assertion.action) return false;
  if (assertion.result !== undefined && event.result !== assertion.result) return false;
  if (assertion.command !== undefined && event.command !== assertion.command) return false;
  if (assertion.aggregated !== undefined && event.aggregated !== assertion.aggregated) return false;
  const runbook = assertion.runbook ?? options.defaultRunbook;
  if (runbook !== undefined && !runbookMatches(event.runbook, runbook)) {
    return false;
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
 * When options.defaultRunbook is provided, assertions that omit `runbook`
 * are scoped to that runbook instead of matching every runbook.
 *
 * @param assertions - Ordered list of step assertions to evaluate
 * @param events - Captured transitions from command execution
 * @param options - Matching options
 * @returns Array of assertion results in the same order as input assertions
 */
export function matchStepAssertions(
  assertions: StepAssertion[],
  events: CapturedTransition[],
  options: MatchStepAssertionOptions = {},
): StepAssertionResult[] {
  const results: StepAssertionResult[] = [];
  let eventIndex = 0;

  for (const assertion of assertions) {
    let matched = false;
    while (eventIndex < events.length) {
      if (eventMatchesAssertion(events[eventIndex], assertion, options)) {
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
 * Match warning assertions against captured JSON warning responses using ordered
 * skip-matching.
 *
 * @param assertions - Ordered list of warning assertions to evaluate
 * @param events - Captured JSON warning responses from command execution
 * @returns Array of assertion results in the same order as input assertions
 */
export function matchWarningAssertions(
  assertions: WarningAssertion[],
  events: CapturedWarning[],
): WarningAssertionResult[] {
  const results: WarningAssertionResult[] = [];
  let eventIndex = 0;

  for (const assertion of assertions) {
    let matched = false;
    while (eventIndex < events.length) {
      const event = events[eventIndex];
      if (
        (assertion.code === undefined || event.code === assertion.code) &&
        (assertion.command === undefined || event.command === assertion.command) &&
        (assertion.message === undefined || event.message?.includes(assertion.message) === true)
      ) {
        results.push({ assertion, matched: true, matchedWarning: event });
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
 * Find captured warnings that were not consumed by warning assertions.
 *
 * @param warnings - Captured JSON warning responses
 * @param assertionResults - Warning assertion match results, if any
 * @returns Captured warnings without a matching assertion
 */
export function findUnassertedWarnings(
  warnings: CapturedWarning[],
  assertionResults: readonly WarningAssertionResult[] | undefined,
): CapturedWarning[] {
  const matched = new Set<CapturedWarning>();
  for (const result of assertionResults ?? []) {
    if (result.matchedWarning !== undefined) {
      matched.add(result.matchedWarning);
    }
  }
  return warnings.filter((warning) => !matched.has(warning));
}

type ArtifactExistsPredicate = (uri: string) => boolean;

function runbookMatches(eventRunbook: RunbookRef | undefined, assertionRunbook: string): boolean {
  return (
    eventRunbook?.path === assertionRunbook ||
    eventRunbook?.path.endsWith(`/${assertionRunbook}`) === true
  );
}

function artifactEventMatchesAssertion(
  event: CapturedArtifactEntry,
  assertion: ArtifactAssertion,
  exists?: ArtifactExistsPredicate,
): PublicArtifactRecord[] | null {
  if (assertion.at !== undefined && event.at !== assertion.at) return null;
  if (assertion.runbook !== undefined && !runbookMatches(event.runbook, assertion.runbook)) {
    return null;
  }

  const value = event.artifacts[assertion.alias];
  if (value === undefined) return null;
  const records = Array.isArray(value) ? value : [value];

  if (assertion.count !== undefined && records.length !== assertion.count) return null;
  if (
    assertion.kind !== undefined &&
    !records.some((record) => publicArtifactRecordKind(record) === assertion.kind)
  ) {
    return null;
  }
  if (assertion.key !== undefined && !records.some((record) => record.key === assertion.key)) {
    return null;
  }
  if (assertion.exists !== undefined) {
    if (exists === undefined) return null;
    if (records.length === 0) return null;
    const existenceMatches = records.every((record) => exists(record.uri) === assertion.exists);
    if (!existenceMatches) return null;
  }

  return records;
}

function publicArtifactRecordKind(
  record: PublicArtifactRecord,
): 'artifact-record' | 'file-artifact-record' {
  return 'kind' in record ? 'file-artifact-record' : 'artifact-record';
}

/**
 * Match artifact assertions against captured step-entered artifact working sets.
 *
 * Assertions are matched in order against the event stream. Each assertion
 * skips forward through events until a matching artifact alias and filters are
 * found.
 *
 * @param assertions - Ordered list of artifact assertions to evaluate
 * @param events - Captured artifact entries from command execution
 * @param exists - Optional callback for exact artifact URI file-existence checks
 * @returns Array of assertion results in the same order as input assertions
 */
export function matchArtifactAssertions(
  assertions: ArtifactAssertion[],
  events: CapturedArtifactEntry[],
  exists?: ArtifactExistsPredicate,
): ArtifactAssertionResult[] {
  const results: ArtifactAssertionResult[] = [];
  let eventIndex = 0;

  for (const assertion of assertions) {
    let matched = false;
    while (eventIndex < events.length) {
      const matchedRecords = artifactEventMatchesAssertion(events[eventIndex], assertion, exists);
      if (matchedRecords !== null) {
        results.push({
          assertion,
          matched: true,
          matchedEntry: events[eventIndex],
          matchedRecords,
        });
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

function enteredEventMatchesAssertion(
  event: CapturedEnteredStep,
  assertion: EnteredAssertion,
): boolean {
  if (assertion.at !== undefined && event.at !== assertion.at) return false;
  if (assertion.description !== undefined && event.description !== assertion.description) {
    return false;
  }
  if (assertion.runbook !== undefined && !runbookMatches(event.runbook, assertion.runbook)) {
    return false;
  }
  return true;
}

/**
 * Match entered-step assertions against captured `step_entered` events.
 *
 * Assertions are matched in order against the event stream. Each assertion
 * skips forward through events until a matching entered-step event is found.
 *
 * @param assertions - Ordered list of entered-step assertions to evaluate
 * @param events - Captured entered-step events from command execution
 * @returns Array of assertion results in the same order as input assertions
 */
export function matchEnteredAssertions(
  assertions: EnteredAssertion[],
  events: CapturedEnteredStep[],
): EnteredAssertionResult[] {
  const results: EnteredAssertionResult[] = [];
  let eventIndex = 0;

  for (const assertion of assertions) {
    let matched = false;
    while (eventIndex < events.length) {
      if (enteredEventMatchesAssertion(events[eventIndex], assertion)) {
        results.push({ assertion, matched: true, matchedEntry: events[eventIndex] });
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
 * Format a warning assertion result for human-readable display.
 *
 * @param result - The warning assertion result to format
 * @returns A descriptive string like "warning code=NO_ACTIVE_RUNBOOK: matched"
 */
export function formatWarningAssertionDescription(result: WarningAssertionResult): string {
  const parts: string[] = [];
  if (result.assertion.code !== undefined) parts.push(`code=${result.assertion.code}`);
  if (result.assertion.command !== undefined) parts.push(`command=${result.assertion.command}`);
  if (result.assertion.message !== undefined) parts.push(`message~=${result.assertion.message}`);
  const desc = parts.length > 0 ? parts.join(' ') : '(empty assertion)';
  return `warning ${desc}: ${result.matched ? 'matched' : 'no match'}`;
}

/**
 * Format an artifact assertion result for human-readable display.
 *
 * @param result - The artifact assertion result to format
 * @returns A descriptive string like "artifact alias=PlanPath key=plan.json: matched"
 */
export function formatArtifactAssertionDescription(result: ArtifactAssertionResult): string {
  const parts: string[] = [`alias=${result.assertion.alias}`];
  if (result.assertion.runbook !== undefined) parts.push(`runbook=${result.assertion.runbook}`);
  if (result.assertion.at !== undefined) parts.push(`at=${result.assertion.at}`);
  if (result.assertion.key !== undefined) parts.push(`key=${result.assertion.key}`);
  if (result.assertion.count !== undefined) parts.push(`count=${String(result.assertion.count)}`);
  if (result.assertion.exists !== undefined)
    parts.push(`exists=${String(result.assertion.exists)}`);
  return `artifact ${parts.join(' ')}: ${result.matched ? 'matched' : 'no match'}`;
}

/**
 * Format an entered-step assertion result for human-readable display.
 *
 * @param result - The entered-step assertion result to format
 * @returns A descriptive string like "entered at=1.1 description=Runbook: child.runbook.md: matched"
 */
export function formatEnteredAssertionDescription(result: EnteredAssertionResult): string {
  const parts: string[] = [];
  if (result.assertion.runbook !== undefined) parts.push(`runbook=${result.assertion.runbook}`);
  if (result.assertion.at !== undefined) parts.push(`at=${result.assertion.at}`);
  if (result.assertion.description !== undefined)
    parts.push(`description=${result.assertion.description}`);
  const desc = parts.length > 0 ? parts.join(' ') : '(empty assertion)';
  return `entered ${desc}: ${result.matched ? 'matched' : 'no match'}`;
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
 * Merge one command's parsed output into the sequence's accumulator.
 *
 * @param jsonResult - Parsed JSON lines result from a single command's stdout
 * @param into - The sequence's accumulator, shared across the command loop
 * @returns The terminal result extracted from this output, or `null` if none
 */
function aggregateJsonResult(
  jsonResult: ReturnType<typeof parseJsonLines>,
  into: ParsedCommandOutput,
): 'COMPLETE' | 'STOP' | null {
  into.transitions.push(...jsonResult.transitions);
  for (const [name, values] of jsonResult.captured) {
    into.captured.get(name)?.push(...values);
  }
  into.collectedChildren.push(...jsonResult.collectedChildren);
  into.errors.push(...jsonResult.errors);
  into.warnings.push(...jsonResult.warnings);
  into.artifactEntries.push(...jsonResult.artifactEntries);
  into.enteredSteps.push(...jsonResult.enteredSteps);
  return jsonResult.terminal;
}

/**
 * The scenario's root run: the sequence's first root `runbook_started`.
 *
 * @param output - The sequence's accumulator
 * @returns The root run id, or undefined before the root has started
 */
function rootRunIdOf(output: ParsedCommandOutput): string | undefined {
  return capturedValues(output.captured, 'RUN_ID')[0];
}

/**
 * Execute a sequence of commands in order, accumulating transitions and tokens.
 *
 * Handles `rd` commands (JSON is the default output format) and generic
 * shell commands. Prefix a command with `! ` when a non-zero exit is the
 * expected outcome. Placeholders (`${TOKEN}`, `${RUN_ID}`, `${TICKET}`,
 * `${CHILD_TOKEN}`, `${CHILD_RUN}` and their `_n` forms) are substituted with
 * values captured from earlier commands' output before each command runs.
 *
 * @param options - Execution options including commands, working directory, CLI path, and quiet flag
 * @returns Promise resolving to the terminal result, all transitions, and captured tokens
 * @throws {Error} When a token placeholder references an uncaptured token
 * @throws {Error} When an rd command contains unsupported shell operators
 */
export async function executeCommandSequence(
  options: CommandSequenceOptions,
): Promise<CommandSequenceResult> {
  // One capture model for the whole sequence: every placeholder row (#904 adds
  // TICKET, CHILD_TOKEN, CHILD_RUN) and every assertion input, accumulated in
  // emission order from one parse of each command's stdout.
  const output = createParsedCommandOutput();
  const commandTimings: CommandTiming[] = [];
  let terminalResult: 'COMPLETE' | 'STOP' | 'UNKNOWN' = 'UNKNOWN';

  const { commands, cwd, cliPath, quiet, env, commandExecutor } = options;

  const recordTiming = (
    command: string,
    kind: CommandTiming['kind'],
    start: number,
    exitCode: number,
    expectedFailure: boolean,
  ): void => {
    const timing: CommandTiming = {
      command,
      kind,
      durationMs: Math.round(performance.now() - start),
      exitCode,
      expectedFailure,
    };
    commandTimings.push(timing);
    options.onCommandComplete?.(timing);
  };

  for (const rawCmd of commands) {
    const trimmedRaw = rawCmd.trimStart();
    const expectsFailure = trimmedRaw.startsWith('! ');
    const commandText = expectsFailure ? trimmedRaw.slice(2).trimStart() : rawCmd;
    // Placeholder substitution — replace every placeholder row (${TOKEN},
    // ${RUN_ID}, ${TICKET}, ${CHILD_TOKEN}, ${CHILD_RUN} and their _N indexed
    // forms) with values captured from earlier commands' output.
    const tokenSubstituted = substitutePlaceholders(commandText, output.captured);
    // The `${ARTIFACT:<name>}` grammar and its `seed:` directive were retired in
    // #498. No substituter remains, so fail here and name the replacement rather
    // than letting the raw placeholder leak into the executed command.
    if (RETIRED_ARTIFACT_PLACEHOLDER.test(tokenSubstituted)) {
      throw new Error(
        `Command uses the retired \${ARTIFACT:} grammar, removed in #498: ${tokenSubstituted}\n` +
          `Run a producer runbook first and use \${CAPTURE_ARTIFACT:<key>} to capture its artifact ` +
          `(see runbooks/artifacts/scenario-seed-artifacts.runbook.md).`,
      );
    }
    // The array capture resolves to JSON with double quotes and is re-tokenized
    // by shellParse below; reject it here if it would not survive, rather than
    // failing later against a value the author never wrote.
    assertArrayCapturesAreShellQuoted(tokenSubstituted);
    // Post-run artifact capture — resolve ${CAPTURE_ARTIFACT[_ARRAY]:<key>} from
    // the manifest a prior command produced (resolver injected by the harness).
    // Fail fast if a command references a capture placeholder but no resolver was
    // supplied, rather than leaking the raw placeholder into the executed command.
    if (!options.resolveCapturedArtifact && CAPTURE_ARTIFACT_PLACEHOLDER.test(tokenSubstituted)) {
      throw new Error(
        `Command references \${CAPTURE_ARTIFACT...} but no resolveCapturedArtifact resolver was provided: ${tokenSubstituted}`,
      );
    }
    const cmd = options.resolveCapturedArtifact
      ? await substituteCapturedArtifacts(tokenSubstituted, options.resolveCapturedArtifact)
      : tokenSubstituted;

    // Only the executed command carries the substituted Owner Token; every
    // observation of it (echo, timing record, error message) shows the redacted
    // form, so the token appears only where `runbook_started` printed it.
    const shownCmd = redactRunSecret(cmd);
    options.onCommandStart?.(expectsFailure ? `! ${shownCmd}` : shownCmd);

    // No harness-side "stale command" guard: under one writer per run a
    // mutating command names its run by `--token`, and the CLI itself refuses a
    // token whose run already finished (RD-303 / RD-304, exit 1). Without `!`
    // that refusal fails the sequence below; with `!` it is the assertion.
    const rdCommand = parseRdCommandWithEnv(cmd);

    let stdout: string;

    if (rdCommand) {
      // rd command — parse args (JSON is the default output format)
      const commandEnv = { ...env, ...rdCommand.env };
      const commandStart = performance.now();
      const result = await runCommandWithTee(
        { kind: 'rd', args: rdCommand.args },
        { cwd, quiet, cliPath, env: commandEnv, commandExecutor },
      );
      recordTiming(shownCmd, 'rd', commandStart, result.exitCode, expectsFailure);
      stdout = result.stdout;

      // Parse JSON output to extract transitions, terminal state, and captures
      // The first `${RUN_ID}` is the first root `runbook_started` of the
      // sequence — the scenario's root run. It is undefined while parsing the
      // command that starts it; `parseJsonLines` then adopts that payload's own
      // first root `runbook_started`, because a starting command can already
      // carry both a root and a child terminal.
      const jsonResult = parseJsonLines(stdout, rootRunIdOf(output));
      const terminal = aggregateJsonResult(jsonResult, output);
      if (terminal !== null) {
        terminalResult = terminal;
      }

      // If the command failed and no terminal result was parsed, propagate the failure
      if (expectsFailure && result.exitCode === 0) {
        throw new Error(`Command was expected to fail but exited 0: ${shownCmd}`);
      }
      if (!expectsFailure && result.exitCode !== 0 && jsonResult.terminal === null) {
        throw new Error(`Command failed with exit code ${String(result.exitCode)}: ${shownCmd}`);
      }
    } else {
      // Shell command — execute directly
      const commandStart = performance.now();
      const result = await runCommandWithTee(
        { kind: 'shell', cmd },
        { cwd, quiet, cliPath, env, commandExecutor },
      );
      recordTiming(shownCmd, 'shell', commandStart, result.exitCode, expectsFailure);
      stdout = result.stdout;

      // Parse JSON output from shell commands as well (e.g., shell scripts that wrap rd commands)
      // The first `${RUN_ID}` is the first root `runbook_started` of the
      // sequence — the scenario's root run. It is undefined while parsing the
      // command that starts it; `parseJsonLines` then adopts that payload's own
      // first root `runbook_started`, because a starting command can already
      // carry both a root and a child terminal.
      const jsonResult = parseJsonLines(stdout, rootRunIdOf(output));
      const terminal = aggregateJsonResult(jsonResult, output);
      if (terminal !== null) {
        terminalResult = terminal;
      }

      if (expectsFailure && result.exitCode === 0) {
        throw new Error(`Shell command was expected to fail but exited 0: ${shownCmd}`);
      }
      if (!expectsFailure && result.exitCode !== 0) {
        throw new Error(
          `Shell command failed with exit code ${String(result.exitCode)}: ${shownCmd}`,
        );
      }
    }
  }

  return {
    terminalResult,
    transitions: output.transitions,
    capturedTokens: [...capturedValues(output.captured, 'TOKEN')],
    capturedRunIds: [...capturedValues(output.captured, 'RUN_ID')],
    errors: output.errors,
    warnings: output.warnings,
    artifactEntries: output.artifactEntries,
    enteredSteps: output.enteredSteps,
    collectedChildren: output.collectedChildren,
    commandTimings,
  };
}
