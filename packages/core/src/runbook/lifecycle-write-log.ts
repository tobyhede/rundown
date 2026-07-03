// packages/core/src/runbook/lifecycle-write-log.ts
//
// Durable attribution log for lifecycle writes to persisted run state (#536).
// Every write that changes RunbookState.lifecycle — and every run-state
// deletion — appends a single-line JSON record to
// `.rundown/logs/lifecycle-writes.jsonl` identifying the writing process and
// call site. Appends are best-effort: a logging failure must never mask or
// break the state mutation it attributes. Argv is REDACTED at capture
// (delegation tokens truncated, input values masked) so this append-only,
// never-rotated log can never carry raw secrets.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getErrorMessage } from '../errors.js';
import { logger } from '../logger.js';
import { lifecycleWriteLogPath } from '../paths.js';
import { TOKEN_PREFIX, truncateDelegationToken } from './delegation-token.js';
import type { Lifecycle } from './types.js';

/** Maximum call-site frames retained per record. */
const CALL_SITE_FRAME_LIMIT = 12;

/** Matches raw delegation tokens anywhere inside a single argument. */
const ARGV_TOKEN_SCAN = new RegExp(`${TOKEN_PREFIX}[A-Z2-7]+`, 'g');

/** Flags whose FOLLOWING argument carries a user-supplied value to mask. */
const VALUE_FLAGS = new Set(['--input', '--input-json', '--input-file']);

/** Inline `--input=KEY=value` / `--input-json=...` / `--input-file=...` forms. */
const INLINE_VALUE_FLAG = /^(--input(?:-json|-file)?)=(.*)$/s;

/** `RD_INPUT_name=value`-shaped arguments (environment-bridge style). */
const RD_INPUT_SHAPE = /^(RD_INPUT_[A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

/**
 * Mask the user-supplied value carried by a `--input`-family flag argument.
 *
 * `--input-file` values are whole paths and are masked entirely; `--input` /
 * `--input-json` values keep the `key=` portion and mask the value.
 *
 * @param flag - The flag that owns the value (`--input`, `--input-json`, `--input-file`)
 * @param value - The raw value argument to mask
 * @returns Masked value safe to persist
 */
function maskFlagValue(flag: string, value: string): string {
  if (flag === '--input-file') {
    return '***';
  }
  const eq = value.indexOf('=');
  return eq === -1 ? value : `${value.slice(0, eq + 1)}***`;
}

/**
 * Redact an argv for durable persistence.
 *
 * Delegation tokens are truncated to their display form via
 * {@link truncateDelegationToken} (`rdtk_` + 3 body chars + `...` + last 4 —
 * still sufficient to distinguish `rd claim` traffic for the #536
 * investigation), and the value portion of `--input` / `--input-json` /
 * `--input-file` / `RD_INPUT_*`-shaped arguments is masked while the key is
 * kept (`--input environment=***`). Raw tokens and raw input values must
 * never reach the append-only, never-rotated log.
 *
 * @param argv - Raw argv to redact
 * @returns Redacted copy safe to persist
 */
export function redactArgvForAttribution(argv: readonly string[]): string[] {
  const redacted: string[] = [];
  let pendingValueFlag: string | null = null;
  for (const arg of argv) {
    let value = arg.replace(ARGV_TOKEN_SCAN, (token) => truncateDelegationToken(token));
    if (pendingValueFlag !== null) {
      value = maskFlagValue(pendingValueFlag, value);
      pendingValueFlag = null;
    } else if (VALUE_FLAGS.has(value)) {
      pendingValueFlag = value;
    } else {
      const inline = INLINE_VALUE_FLAG.exec(value);
      const envShaped = RD_INPUT_SHAPE.exec(value);
      if (inline) {
        value = `${inline[1]}=${maskFlagValue(inline[1], inline[2])}`;
      } else if (envShaped) {
        value = `${envShaped[1]}=***`;
      }
    }
    redacted.push(value);
  }
  return redacted;
}

/**
 * Process and call-site attribution common to every lifecycle write record.
 */
export interface LifecycleWriteAttribution {
  /** Writing process id. */
  readonly pid: number;
  /** Parent process id (correlates hook-spawned CLI processes to their host). */
  readonly ppid: number;
  /**
   * REDACTED argv of the writing process (runtime binary, entry script, args).
   * Delegation tokens are truncated and input values masked at capture; the
   * raw argv is never persisted.
   */
  readonly argv: readonly string[];
  /** ISO-8601 timestamp captured at write time. */
  readonly at: string;
  /** Trimmed stack frames above the capture site, innermost first. */
  readonly callSite: readonly string[];
}

/**
 * One durable lifecycle write record (a single JSONL line).
 *
 * - `transition` — a persisted write changed `RunbookState.lifecycle`
 *   (including creation, where `prev` is `null`).
 * - `delete` — a run-state file was removed via `RunbookStateManager.delete`.
 */
export type LifecycleWriteRecord =
  | {
      readonly kind: 'transition';
      /** Run id whose state was written. */
      readonly runId: string;
      /** Lifecycle read from disk before the write; `null` when absent or unreadable. */
      readonly prev: Lifecycle | null;
      /** Lifecycle persisted by this write. */
      readonly next: Lifecycle;
      readonly attribution: LifecycleWriteAttribution;
    }
  | {
      readonly kind: 'delete';
      /** Run id whose state file was deleted. */
      readonly runId: string;
      /** Lifecycle read from disk before the deletion; `null` when unreadable. */
      readonly prev: Lifecycle | null;
      readonly attribution: LifecycleWriteAttribution;
    };

/**
 * Capture attribution for a lifecycle write at the current call site.
 *
 * The argv is redacted before it is stored on the returned attribution — see
 * {@link redactArgvForAttribution}.
 *
 * @param argv - Argv to redact and record (defaults to `process.argv`; injectable for tests)
 * @returns Attribution with pid, ppid, redacted argv, timestamp, and trimmed stack frames
 */
export function captureLifecycleWriteAttribution(
  argv: readonly string[] = process.argv,
): LifecycleWriteAttribution {
  const stack = new Error('lifecycle-write-attribution').stack ?? '';
  const callSite = stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim().replace(/^at\s+/, ''))
    .filter((frame) => !frame.includes('captureLifecycleWriteAttribution'))
    .slice(0, CALL_SITE_FRAME_LIMIT);
  return {
    pid: process.pid,
    ppid: process.ppid,
    argv: redactArgvForAttribution(argv),
    at: new Date().toISOString(),
    callSite,
  };
}

/**
 * Append a lifecycle write record to the durable attribution log.
 *
 * Best-effort by contract: any filesystem failure is reported as a logger
 * warning and swallowed, so a failed append can never mask the committed
 * state mutation it attributes.
 *
 * @param cwd - Project root directory
 * @param record - Record to append as one JSON line
 */
export async function appendLifecycleWriteRecord(
  cwd: string,
  record: LifecycleWriteRecord,
): Promise<void> {
  const filePath = lifecycleWriteLogPath(cwd);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch (err: unknown) {
    void logger.warn(
      `lifecycle-write-log: failed to append attribution record: ${getErrorMessage(err)}`,
      { runId: record.runId, kind: record.kind },
    );
  }
}
