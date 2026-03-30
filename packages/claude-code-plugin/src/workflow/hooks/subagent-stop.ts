// src/workflow/hooks/subagent-stop.ts
import { createHash } from 'node:crypto';
import type { HookInput } from '../../shared/index.js';
import { Session } from '../../session.js';
import { rundown } from './rundown.js';

/**
 * Result from handling a SubagentStop hook event.
 *
 * Returned by {@link handleSubagentStop} to communicate whether the subagent
 * stop produced actionable context or a policy/runtime violation.
 */
export interface SubagentStopResult {
  /** Summary of the action taken (e.g. delegation abort message). Undefined when no action was needed. */
  context?: string;
  /** Description of the policy or runtime error that caused the stop. Undefined when the subagent stopped normally. */
  violation?: string;
}

// ---------------------------------------------------------------------------
// Domain types — discriminated unions for runbook status and delegation state
// ---------------------------------------------------------------------------

/** Shared fields for runbook states that carry position information. */
interface RunbookPosition {
  file: string;
  position?: { current: string; total: number; substep?: string };
  step?: { name: string; description?: string };
}

/** Delegation status as a discriminated union — each state carries only its valid fields. */
type DelegationStatus =
  | {
      readonly state: 'pending';
      readonly substep: string;
      readonly runbook: string;
      readonly tokenHash?: string;
    }
  | {
      readonly state: 'claimed';
      readonly substep: string;
      readonly runbook: string;
      readonly childRunId: string;
      readonly tokenHash?: string;
    }
  | {
      readonly state: 'cancelled';
      readonly substep: string;
      readonly runbook: string;
      readonly childRunId?: string;
      readonly tokenHash?: string;
    };

/** Runbook status as a discriminated union — impossible combinations are unrepresentable. */
type RunbookStatus =
  | { readonly kind: 'inactive' }
  | ({ readonly kind: 'stashed' } & RunbookPosition)
  | ({
      readonly kind: 'active';
      readonly delegations: readonly DelegationStatus[];
    } & RunbookPosition);

/**
 * Delegation outcome — the hook's decision as a discriminated union.
 * Each variant carries exactly the data needed for its context message.
 */
type DelegationOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'child_active'; readonly status: RunbookPosition }
  | { readonly kind: 'child_stashed'; readonly status: RunbookPosition }
  | { readonly kind: 'unclaimed'; readonly delegation: DelegationStatus & { state: 'pending' } }
  | { readonly kind: 'unknown' };

// ---------------------------------------------------------------------------
// Token hashing
// ---------------------------------------------------------------------------

/**
 * Hash a raw delegation token using SHA-256.
 *
 * Replicates the same algorithm as `hashDelegationToken` in `@rundown-org/core`
 * to allow correlation without a direct core dependency.
 *
 * @param token - Raw delegation token string
 * @returns Hash in `sha256:<hex>` format
 */
function hashToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Parsing — raw JSON to discriminated union
// ---------------------------------------------------------------------------

/**
 * Parse a validated position field from raw JSON.
 *
 * @param raw - Raw value from parsed JSON
 * @returns Position info if the value is an object, otherwise undefined
 */
function parsePosition(raw: unknown): RunbookPosition['position'] {
  if (!raw || typeof raw !== 'object') return undefined;
  return raw as RunbookPosition['position'];
}

/**
 * Parse a validated step field from raw JSON.
 *
 * @param raw - Raw value from parsed JSON
 * @returns Step info if the value is an object, otherwise undefined
 */
function parseStep(raw: unknown): RunbookPosition['step'] {
  if (!raw || typeof raw !== 'object') return undefined;
  return raw as RunbookPosition['step'];
}

/**
 * Type guard for raw delegation objects from `rd status --json`.
 *
 * @param d - Raw value from the delegations array
 * @returns True if the value is a valid DelegationStatus
 */
function isDelegationStatus(d: unknown): d is DelegationStatus {
  if (d == null || typeof d !== 'object') return false;
  const obj = d as Record<string, unknown>;
  const shared =
    typeof obj.substep === 'string' &&
    typeof obj.runbook === 'string' &&
    (obj.tokenHash === undefined || typeof obj.tokenHash === 'string');
  if (!shared) return false;
  switch (obj.state) {
    case 'pending':
      return obj.childRunId === undefined;
    case 'claimed':
      return typeof obj.childRunId === 'string';
    case 'cancelled':
      return obj.childRunId === undefined || typeof obj.childRunId === 'string';
    default:
      return false;
  }
}

/**
 * Parse delegation entries from raw JSON array.
 *
 * @param raw - Raw value from parsed JSON
 * @returns Array of validated delegation status entries
 */
function parseDelegations(raw: unknown): readonly DelegationStatus[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isDelegationStatus);
}

/**
 * Query runbook state via `rd status --json` and parse into a discriminated union.
 *
 * Best-effort: returns undefined if the CLI call fails for any reason.
 *
 * @param cwd - Working directory for the CLI call
 * @returns Parsed runbook status, or undefined on failure
 */
function queryRunbookStatus(cwd: string): RunbookStatus | undefined {
  try {
    const output = rundown(['status', '--json'], cwd);
    const parsed = JSON.parse(output) as Record<string, unknown>;

    const active = parsed.active === true;
    const stashed = parsed.stashed === true;
    const file = typeof parsed.file === 'string' ? parsed.file : undefined;

    // Stashed-only: runbook paused via `rd stash`, not completed.
    // When both active and stashed are true (active child + stashed parent),
    // fall through to the active branch which preserves delegations.
    if (stashed && !active && file) {
      return {
        kind: 'stashed',
        file,
        position: parsePosition(parsed.position),
        step: parseStep(parsed.step),
      };
    }

    // Not active and not stashed: nothing running
    if (!active) {
      return { kind: 'inactive' };
    }

    // Active: runbook is running (could be parent or child)
    return {
      kind: 'active',
      file: file ?? '(unknown)',
      position: parsePosition(parsed.position),
      step: parseStep(parsed.step),
      delegations: parseDelegations(parsed.delegations),
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

/**
 * Classify the delegation outcome by correlating the token hash with the
 * active runbook's delegation state.
 *
 * @param status - Parsed runbook status from `rd status --json`
 * @param tokenHash - SHA-256 hash of the consumed delegation token
 * @returns The delegation outcome determining which context message to produce
 */
function classifyOutcome(status: RunbookStatus, tokenHash: string): DelegationOutcome {
  switch (status.kind) {
    case 'inactive':
      // Child completed and was popped from session stack
      return { kind: 'completed' };

    case 'stashed':
      // Child was stashed, not completed
      return { kind: 'child_stashed', status };

    case 'active': {
      // If no delegations carry token hashes, correlation is impossible (stale session state)
      if (
        status.delegations.length > 0 &&
        !status.delegations.some((d) => d.tokenHash !== undefined)
      ) {
        return { kind: 'unknown' };
      }

      // Find the delegation matching our token
      const ours = status.delegations.find((d) => d.tokenHash === tokenHash);

      if (!ours) {
        // Our delegation not found — two possible scenarios:
        // 1. Parent resumed after child completed (no delegations remain)
        // 2. Child is active with its own nested delegations (grandchild)
        if (status.delegations.length > 0) {
          // Active runbook has delegations we don't recognize — likely a child
          // with nested delegations still in progress
          return { kind: 'child_active', status };
        }
        // No delegations — delegation was resolved and parent resumed
        return { kind: 'completed' };
      }

      // Found our delegation — classify by its state
      switch (ours.state) {
        case 'pending':
          // Never claimed — subagent stopped before calling rd claim
          return { kind: 'unclaimed', delegation: ours };
        case 'claimed':
          // Claimed and parent is active — child completed and was popped
          return { kind: 'completed' };
        case 'cancelled':
          // Already cancelled — treat as completed (nothing more to do)
          return { kind: 'completed' };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Context message builders
// ---------------------------------------------------------------------------

/**
 * Build position detail lines from runbook position info.
 *
 * @param pos - Runbook position info containing file, step, and position
 * @returns Array of formatted markdown lines
 */
function formatPositionLines(pos: RunbookPosition): string[] {
  const lines: string[] = [];

  lines.push(`**Runbook:** ${pos.file}`);

  if (pos.step) {
    const stepDesc = pos.step.description
      ? `${pos.step.name} — ${pos.step.description}`
      : pos.step.name;
    lines.push(`**Current step:** ${stepDesc}`);
  }
  if (pos.position) {
    lines.push(`**Position:** step ${pos.position.current} of ${String(pos.position.total)}`);
  }

  return lines;
}

/**
 * Build a context message from a delegation outcome.
 *
 * @param outcome - The classified delegation outcome
 * @returns Formatted context message, or undefined if no context needed
 */
function buildContextMessage(outcome: DelegationOutcome): string | undefined {
  switch (outcome.kind) {
    case 'completed':
      return undefined;

    case 'unknown':
      return 'Subagent stopped with an active delegation. Unable to verify child runbook state — check with `rd status`.';

    case 'child_active': {
      const lines: string[] = [
        '## Delegation Incomplete',
        '',
        'The subagent stopped but the child runbook is still active.',
        '',
        ...formatPositionLines(outcome.status),
        '',
        'The child runbook was not completed by the subagent. You should:',
        '1. Run `rd status` to inspect the current state',
        '2. Decide whether to retry the delegation, complete the work yourself, or fail the step',
        '3. Do NOT assume the work was completed — verify before proceeding',
      ];
      return lines.join('\n');
    }

    case 'child_stashed': {
      const lines: string[] = [
        '## Delegation Stashed',
        '',
        'The subagent stopped and the child runbook was stashed without being completed.',
        '',
        ...formatPositionLines(outcome.status),
        '',
        'The stashed runbook needs to be resumed or resolved. You should:',
        '1. Run `rd status` to inspect the current state',
        '2. Run `rd pop` to resume the stashed runbook, or fail the step',
        '3. Verify the runbook state before proceeding',
      ];
      return lines.join('\n');
    }

    case 'unclaimed': {
      const { delegation } = outcome;
      const lines: string[] = [
        '## Delegation Never Claimed',
        '',
        `The subagent stopped without claiming delegation for substep ${delegation.substep}.`,
        `**Child runbook:** ${delegation.runbook}`,
        '',
        'The delegation token was never claimed — no child runbook was started. You should:',
        '1. Run `rd status` to inspect the current delegation state',
        '2. Retry the delegation with a new subagent, or fail the step',
      ];
      return lines.join('\n');
    }
  }
}

// ---------------------------------------------------------------------------
// Hook handler
// ---------------------------------------------------------------------------

/**
 * Handle a SubagentStop hook by consuming any active delegation token and checking
 * whether the child runbook was completed.
 *
 * Hashes the consumed token and correlates it with the delegation entries in
 * `rd status --json` to identify the exact delegation belonging to this subagent.
 *
 * Classifies the delegation state into one of five outcomes:
 * - **completed**: Child runbook finished (`rd pass`/`rd fail`) and was popped.
 * - **child_active**: Child runbook is running but subagent stopped without completing.
 * - **child_stashed**: Child runbook was stashed via `rd stash` but not completed.
 * - **unclaimed**: Subagent stopped before calling `rd claim`. Parent is still active.
 * - **unknown**: Status check failed. Fallback context returned.
 *
 * Never destroys child runbook state.
 *
 * @param input - Hook event payload (includes cwd, hook_event_name, and last_assistant_message)
 * @returns An object with `context` when the child runbook is incomplete, or an empty object if no action was needed
 */
export async function handleSubagentStop(input: HookInput): Promise<SubagentStopResult> {
  if (input.hook_event_name !== 'SubagentStop') {
    return {};
  }

  // Read and consume delegation token from session metadata
  const session = new Session(input.cwd);
  const meta = await session.get('metadata');
  const raw = meta.delegation_active_token;
  const token = typeof raw === 'string' ? raw : undefined;

  // Clear the token (consume-once) regardless of outcome
  if (token) {
    const { delegation_active_token: _, ...rest } = meta;
    await session.set('metadata', rest);
  }

  // No delegation token — no action needed
  if (!token) {
    return {};
  }

  // Query runbook state and classify the delegation outcome
  const status = queryRunbookStatus(input.cwd);
  const hash = hashToken(token);
  const outcome: DelegationOutcome = status ? classifyOutcome(status, hash) : { kind: 'unknown' };
  const context = buildContextMessage(outcome);

  return context ? { context } : {};
}
