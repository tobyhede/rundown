// src/workflow/hooks/subagent-stop.ts
import { createHash } from 'node:crypto';
import {
  DelegationActiveTokenMetadataSchema,
  DelegationActiveTokensMetadataSchema,
  type HookInput,
  ParentLinkageSchema,
  RunbookPositionBodySchema,
  RunbookStepBodySchema,
} from '../../shared/index.js';
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

/**
 * Parent linkage surfaced by `rd status` when the runbook was launched
 * as a child. Used by the hook to correlate a consumed delegation token with
 * the child it produced.
 *
 * Exported for testing. Not part of the plugin's public API.
 *
 * @internal
 */
export type ParentLinkage =
  | {
      /** Child was launched via `rd delegate` + `rd claim` from a parent's outgoing delegation. */
      readonly kind: 'delegation';
      /** SHA-256 hash (`sha256:<hex>`) of the delegation token consumed at claim time. Used for parent ↔ child correlation. */
      readonly tokenHash: string;
      /** RunId of the parent runbook that issued the delegation. */
      readonly parentRunId: string;
      /** Qualified step id on the parent (e.g. `3.1`) where the delegation was issued. */
      readonly parentStepId: string;
      /** Parent step's display name when available; absent if the parent did not surface one. */
      readonly parentStep?: string;
    }
  | {
      /** Child was launched inline (e.g. `rundown run --step`) from a parent rather than via a delegation token. */
      readonly kind: 'inline';
      /** RunId of the parent runbook that started the inline child. */
      readonly parentRunId: string;
      /** Qualified step id on the parent (e.g. `3.1`) where the inline child was launched. */
      readonly parentStepId: string;
      /** Parent step's display name when available; absent if the parent did not surface one. */
      readonly parentStep?: string;
    }
  | {
      /**
       * Status emitted a `parentLinkage` field but its contents failed schema
       * validation. Preserved as a distinct variant so classifiers can
       * distinguish "field absent" (undefined) from "field present but
       * unverifiable" (this variant) — the latter must not fall through to
       * the parent-resumed code path.
       */
      readonly kind: 'malformed';
    };

/**
 * Shared fields for runbook states that carry position information.
 *
 * Exported for testing. Not part of the plugin's public API.
 *
 * @internal
 */
export interface RunbookPosition {
  /** Source file path of the runbook (e.g. `parent.runbook.md`). */
  file: string;
  /**
   * Execution cursor when known.
   *
   * - `current`: qualified step id at the cursor (e.g. `3` or `3.1`).
   * - `total`: total top-level steps in the runbook.
   * - `substep`: substep id within the current step, when inside one.
   * - `unresolved`: count of unresolved substeps at the current step (drives the
   *   "delegate further" guidance in the completed banner).
   */
  position?: { current: string; total: number; substep?: string; unresolved?: number };
  /** Display info for the current step: its name and optional description. */
  step?: { name: string; description?: string };
  /**
   * Linkage to the parent runbook when this status describes a child. Absent
   * for a top-level (non-child) runbook.
   */
  parentLinkage?: ParentLinkage;
}

/**
 * Delegation status as a discriminated union — each state carries only its valid fields.
 *
 * Exported for testing. Not part of the plugin's public API.
 *
 * @internal
 */
export type DelegationStatus =
  | {
      /** Token issued by `rd delegate` but not yet consumed by `rd claim`. */
      readonly state: 'pending';
      /** Qualified substep id on the parent (e.g. `3.1`) where the delegation lives. */
      readonly substep: string;
      /** Child runbook source path or namespace target. */
      readonly runbook: string;
      /** SHA-256 hash (`sha256:<hex>`) of the delegation token. Used for parent ↔ child correlation. */
      readonly tokenHash: string;
    }
  | {
      /** Token claimed by a subagent; the child runbook has been launched. */
      readonly state: 'claimed';
      /** Qualified substep id on the parent (e.g. `3.1`) where the delegation lives. */
      readonly substep: string;
      /** Child runbook source path or namespace target. */
      readonly runbook: string;
      /** RunId of the child runbook started by the claim. Always present in this state. */
      readonly childRunId: string;
      /** SHA-256 hash (`sha256:<hex>`) of the delegation token. Used for parent ↔ child correlation. */
      readonly tokenHash: string;
    }
  | {
      /** Delegation aborted via `rd abort` (token cancelled before or after claim). */
      readonly state: 'cancelled';
      /** Qualified substep id on the parent (e.g. `3.1`) where the delegation lived. */
      readonly substep: string;
      /** Child runbook source path or namespace target. */
      readonly runbook: string;
      /** RunId of the child runbook if the delegation was claimed before being cancelled. Absent if cancelled while pending. */
      readonly childRunId?: string;
      /** SHA-256 hash (`sha256:<hex>`) of the delegation token. Used for parent ↔ child correlation. */
      readonly tokenHash: string;
    };

/**
 * Runbook status as a discriminated union — impossible combinations are unrepresentable.
 *
 * Exported for testing. Not part of the plugin's public API.
 *
 * @internal
 */
export type RunbookStatus =
  | { readonly kind: 'inactive' }
  | ({ readonly kind: 'stashed' } & RunbookPosition)
  | ({
      readonly kind: 'active';
      readonly delegations: readonly DelegationStatus[];
      /**
       * True when the raw delegations array contained entries that failed
       * {@link isDelegationStatus} validation (e.g. stale pre-tokenHash state).
       * Such entries are filtered out of `delegations`, but the flag preserves
       * the signal so classification can route to `unknown` rather than
       * fall through to a confidently-wrong `completed` banner.
       */
      readonly hadInvalidDelegations: boolean;
    } & RunbookPosition);

/**
 * Parent state carried on a completed outcome when the parent runbook is still active.
 *
 * Exported for testing. Not part of the plugin's public API.
 *
 * @internal
 */
export interface CompletedParentState extends RunbookPosition {
  /**
   * Sibling delegations carried on the parent at the moment the child completed.
   * The hook filters out the delegation that produced this child via
   * {@link toParentState}, so only siblings (other delegations at the same step)
   * appear here. Drives the "remaining delegations" section of the completed
   * banner.
   */
  readonly delegations: readonly DelegationStatus[];
}

/**
 * Project an active RunbookStatus into a CompletedParentState with the given delegations.
 *
 * @param status - Source runbook position to project
 * @param delegations - Delegations to carry on the projected state (typically siblings only)
 * @returns A CompletedParentState carrying the provided delegations
 */
function toParentState(
  status: RunbookPosition,
  delegations: readonly DelegationStatus[],
): CompletedParentState {
  return { file: status.file, position: status.position, step: status.step, delegations };
}

/**
 * Delegation outcome — the hook's decision as a discriminated union.
 * Each variant carries exactly the data needed for its context message.
 *
 * Exported for testing. Not part of the plugin's public API.
 *
 * @internal
 */
export type DelegationOutcome =
  | { readonly kind: 'completed'; readonly parent?: CompletedParentState }
  | { readonly kind: 'child_claimed_idle'; readonly child: RunbookPosition }
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

type ConsumedDelegationToken =
  | {
      readonly kind: 'consumed';
      readonly tokenHash: string;
      readonly metadata: Record<string, unknown>;
    }
  | { readonly kind: 'none' }
  | { readonly kind: 'tampered' };

async function consumeLegacyDelegationToken(
  session: Session,
  meta: Record<string, unknown>,
): Promise<ConsumedDelegationToken> {
  const raw = meta.delegation_active_token;
  const token = typeof raw === 'string' ? raw : undefined;
  if (!token) {
    return { kind: 'none' };
  }
  const { delegation_active_token: _removed, ...rest } = meta;
  await session.set('metadata', rest);
  return { kind: 'consumed', tokenHash: hashToken(token), metadata: rest };
}

async function consumeDelegationTokenForAgent(
  session: Session,
  input: HookInput,
): Promise<ConsumedDelegationToken> {
  const meta = await session.get('metadata');

  if (input.agent_id) {
    const rawMap = meta.delegation_active_tokens;
    if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
      return consumeLegacyDelegationToken(session, meta);
    }
    const parsedMap = DelegationActiveTokensMetadataSchema.safeParse(rawMap);
    if (!parsedMap.success) {
      return { kind: 'tampered' };
    }
    const map = parsedMap.data;
    if (!Object.hasOwn(map, input.agent_id)) {
      return consumeLegacyDelegationToken(session, meta);
    }
    const rawEntry = map[input.agent_id];
    const parsed = DelegationActiveTokenMetadataSchema.safeParse(rawEntry);
    if (!parsed.success) {
      return { kind: 'tampered' };
    }
    const entry = parsed.data;
    if (entry.agent_id !== input.agent_id) {
      return { kind: 'tampered' };
    }
    if (input.session_id && entry.session_id && entry.session_id !== input.session_id) {
      return { kind: 'tampered' };
    }

    const { [input.agent_id]: _removed, ...remaining } = map;
    // Hygiene: drop the entire `delegation_active_tokens` key when the last
    // entry is consumed. Leaving an empty object would parse fine on the next
    // read (the guard at line 248 treats {} the same as missing), but
    // removing it keeps the metadata blob minimal and easier to inspect.
    const nextMeta =
      Object.keys(remaining).length > 0
        ? { ...meta, delegation_active_tokens: remaining }
        : (({ delegation_active_tokens: _activeTokens, ...rest }) => rest)(meta);
    await session.set('metadata', nextMeta);
    return { kind: 'consumed', tokenHash: entry.tokenHash, metadata: nextMeta };
  }

  return consumeLegacyDelegationToken(session, meta);
}

// ---------------------------------------------------------------------------
// Parsing — raw JSON to discriminated union
// ---------------------------------------------------------------------------

/**
 * Parse a validated position field from raw JSON using {@link RunbookPositionBodySchema}.
 *
 * Graceful degradation: returns undefined for any malformed input so the hook
 * never throws during display-only classification. The caller treats `undefined`
 * as "no position detail available" and omits that section from the banner.
 *
 * @param raw - Raw value from parsed JSON
 * @returns Validated position info, or undefined on validation failure
 */
function parsePosition(raw: unknown): RunbookPosition['position'] {
  const result = RunbookPositionBodySchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/**
 * Parse a validated step field from raw JSON using {@link RunbookStepBodySchema}.
 *
 * Graceful degradation: returns undefined for any malformed input.
 *
 * @param raw - Raw value from parsed JSON
 * @returns Validated step info, or undefined on validation failure
 */
function parseStep(raw: unknown): RunbookPosition['step'] {
  const result = RunbookStepBodySchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/**
 * Parse a validated parent linkage field from raw JSON using {@link ParentLinkageSchema}.
 *
 * Distinguishes three cases:
 * - **Absent** (`raw === undefined`, i.e. the key was omitted from the status
 *   payload): returns `undefined`. The runbook genuinely has no parent
 *   linkage — caller proceeds with normal classification.
 * - **Malformed** (any other value that fails schema validation, including
 *   `null`): returns a `{ kind: 'malformed' }` sentinel. `null` is treated
 *   as a suspicious signal rather than silently coerced to absence —
 *   `rd status` never emits `null` here, so receiving it indicates upstream
 *   drift or corruption. Caller sees `status.parentLinkage !== undefined`
 *   and routes to the `unknown` outcome.
 * - **Valid**: returns the narrowed delegation or inline variant.
 *
 * @param raw - Raw value from parsed JSON
 * @returns Validated parent linkage, `{ kind: 'malformed' }` if present but
 *   invalid, or `undefined` when the field is absent
 */
function parseParentLinkage(raw: unknown): ParentLinkage | undefined {
  if (raw === undefined) return undefined;
  const result = ParentLinkageSchema.safeParse(raw);
  if (!result.success) return { kind: 'malformed' };
  const data = result.data;
  // Discriminant narrows `data` to its variant — delegation carries a typed
  // `tokenHash: string`, inline does not declare one. No assertion needed.
  if (data.kind === 'delegation') {
    return {
      kind: 'delegation',
      tokenHash: data.tokenHash,
      parentRunId: data.parentRunId,
      parentStepId: data.parentStepId,
      ...(data.parentStep !== undefined ? { parentStep: data.parentStep } : {}),
    };
  }
  return {
    kind: 'inline',
    parentRunId: data.parentRunId,
    parentStepId: data.parentStepId,
    ...(data.parentStep !== undefined ? { parentStep: data.parentStep } : {}),
  };
}

/**
 * Type guard for raw delegation objects from `rd status`.
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
    typeof obj.tokenHash === 'string';
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
 * Separates valid entries from invalid ones so the caller can distinguish
 * "no delegations" from "delegations present but unverifiable" (e.g. stale
 * session state lacking tokenHash). Invalid entries are dropped from
 * `entries` but counted in `hadInvalid`.
 *
 * @param raw - Raw value from parsed JSON
 * @returns Struct with validated entries and a flag indicating whether any
 *   raw entries failed validation
 *
 * Exported for testing. Not part of the plugin's public API.
 *
 * @internal
 */
export function parseDelegations(raw: unknown): {
  readonly entries: readonly DelegationStatus[];
  readonly hadInvalid: boolean;
} {
  if (!Array.isArray(raw)) return { entries: [], hadInvalid: false };
  const entries = raw.filter(isDelegationStatus);
  return { entries, hadInvalid: entries.length !== raw.length };
}

/**
 * Query runbook state via `rd status` and parse into a discriminated union.
 *
 * Best-effort: returns undefined if the CLI call fails for any reason.
 *
 * @param cwd - Working directory for the CLI call
 * @returns Parsed runbook status, or undefined on failure
 *
 * Exported for testing. Not part of the plugin's public API.
 *
 * @internal
 */
export function queryRunbookStatus(cwd: string): RunbookStatus | undefined {
  try {
    const output = rundown(['status'], cwd);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    return parseRunbookStatus(parsed);
  } catch {
    return undefined;
  }
}

function queryRunbookStatusForHook(input: HookInput): RunbookStatus | undefined {
  try {
    const output = rundown(['status'], input.cwd);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    return parseRunbookStatus(parsed);
  } catch {
    return undefined;
  }
}

function parseRunbookStatus(parsed: Record<string, unknown>): RunbookStatus {
  const active = parsed.active === true;
  const stashed = parsed.stashed === true;
  const file = typeof parsed.file === 'string' ? parsed.file : undefined;

  const parentLinkage = parseParentLinkage(parsed.parentLinkage);

  // Stashed-only: runbook paused via `rd stash`, not completed.
  // When both active and stashed are true (active child + stashed parent),
  // fall through to the active branch which preserves delegations.
  if (stashed && !active && file) {
    return {
      kind: 'stashed',
      file,
      position: parsePosition(parsed.position),
      step: parseStep(parsed.step),
      ...(parentLinkage ? { parentLinkage } : {}),
    };
  }

  // Not active and not stashed: nothing running
  if (!active) {
    return { kind: 'inactive' };
  }

  // Active: runbook is running (could be parent or child)
  const { entries: delegations, hadInvalid: hadInvalidDelegations } = parseDelegations(
    parsed.delegations,
  );
  return {
    kind: 'active',
    file: file ?? '(unknown)',
    position: parsePosition(parsed.position),
    step: parseStep(parsed.step),
    delegations,
    hadInvalidDelegations,
    ...(parentLinkage ? { parentLinkage } : {}),
  };
}

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

/**
 * Classify the delegation outcome by correlating the token hash with the
 * active runbook's delegation state.
 *
 * @param status - Parsed runbook status from `rd status`
 * @param tokenHash - SHA-256 hash of the consumed delegation token
 * @returns The delegation outcome determining which context message to produce
 *
 * Exported for testing. Not part of the plugin's public API.
 *
 * @internal
 */
export function classifyOutcome(status: RunbookStatus, tokenHash: string): DelegationOutcome {
  switch (status.kind) {
    case 'inactive':
      // Child completed and was popped from session stack
      return { kind: 'completed' };

    case 'stashed':
      // Child was stashed, not completed
      return { kind: 'child_stashed', status };

    case 'active': {
      // Primary correlation (Option 2): active runbook's parentLinkage carries
      // the tokenHash of the delegation that spawned it. A match means the
      // child is currently active — most commonly: claimed but no progress yet.
      const childMatched =
        status.parentLinkage?.kind === 'delegation' && status.parentLinkage.tokenHash === tokenHash;

      if (childMatched) {
        // Defense-in-depth (Option 1): delegations cannot nest. A claimed
        // child with its own outgoing delegations violates that invariant and
        // indicates corrupt session state — fall back to unknown rather than
        // emit a confidently wrong banner.
        if (status.delegations.length > 0) {
          return { kind: 'unknown' };
        }
        return { kind: 'child_claimed_idle', child: status };
      }

      // If a parentLinkage is present but did not match (wrong token, inline
      // linkage, or malformed payload), the active runbook is not our parent
      // and we cannot verify it is our child either. Fall back to unknown
      // rather than mis-claim the parent resumed.
      if (status.parentLinkage !== undefined) {
        return { kind: 'unknown' };
      }

      // No parent-linkage at all → the active runbook is the parent (resumed
      // after the child completed or cancelled). Confirm by correlating our
      // token hash against the parent's outgoing delegations.
      const ours = status.delegations.find((d) => d.tokenHash === tokenHash);

      if (!ours) {
        // If the raw status payload carried delegation entries that failed
        // validation (e.g. stale pre-tokenHash session state), correlation
        // is impossible — route to `unknown` rather than fall through and
        // misreport the parent as cleanly resumed.
        if (status.hadInvalidDelegations) {
          return { kind: 'unknown' };
        }
        // Otherwise: parent resumed after child completion. Any delegations
        // present are siblings (no-nesting invariant means they can't be
        // grandchildren).
        return { kind: 'completed', parent: status };
      }

      // Found our delegation on the parent — classify by its state.
      // Filter out our own so the parent state only shows siblings.
      const siblings = status.delegations.filter((d) => d.tokenHash !== tokenHash);
      const parentWithSiblings = toParentState(status, siblings);

      switch (ours.state) {
        case 'pending':
          // Never claimed — subagent stopped before calling rd claim
          return { kind: 'unclaimed', delegation: ours };
        case 'claimed':
          // Claimed and parent is active — child completed and was popped
          return { kind: 'completed', parent: parentWithSiblings };
        case 'cancelled':
          // Already cancelled — treat as completed (nothing more to do)
          return { kind: 'completed', parent: parentWithSiblings };
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
    case 'completed': {
      if (!outcome.parent) {
        return undefined;
      }

      const { parent } = outcome;
      const unresolvedDelegations = parent.delegations.filter(
        (d) => d.state === 'pending' || d.state === 'claimed',
      );

      if (unresolvedDelegations.length > 0) {
        const lines: string[] = [
          '## Delegation Completed',
          '',
          `Delegation completed. ${String(unresolvedDelegations.length)} ${unresolvedDelegations.length === 1 ? 'delegation' : 'delegations'} still unresolved.`,
          '',
          ...formatPositionLines(parent),
          '',
          '**Remaining delegations:**',
          ...unresolvedDelegations.map(
            (d) => `- Substep ${d.substep}: \`${d.runbook}\` (${d.state})`,
          ),
          '',
          'Wait for remaining delegations to complete, then run `rd status` to check the current step.',
        ];
        return lines.join('\n');
      }

      const unresolved = parent.position?.unresolved;
      const lines: string[] = [
        '## Delegation Step Complete',
        '',
        'All delegations for the previous step have resolved. The parent runbook has advanced.',
        '',
        ...formatPositionLines(parent),
        '',
      ];

      if (typeof unresolved === 'number' && unresolved > 0) {
        lines.push(
          `This step has ${String(unresolved)} unresolved ${unresolved === 1 ? 'substep' : 'substeps'} requiring delegation.`,
          'Run `rd delegate` to create a delegation token, then dispatch a subagent to claim it.',
        );
      } else {
        lines.push('Proceed with the current step.');
      }

      return lines.join('\n');
    }

    case 'unknown':
      return 'Subagent stopped with an active delegation. Unable to verify child runbook state — check with `rd status`.';

    case 'child_claimed_idle': {
      const lines: string[] = [
        '## Delegation Not Resolved',
        '',
        'The subagent claimed the delegation token but stopped without calling `rd pass` or `rd fail`.',
        'The child runbook is still active — its current position is shown below.',
        '',
        ...formatPositionLines(outcome.child),
        '',
        'The delegation is not complete. You should:',
        '1. Run `rd status` to inspect the current state',
        '2. Decide whether to retry with a new subagent, resume manually, or fail the step',
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
 * Handle a SubagentStop hook by consuming any active delegation token and
 * classifying the state of the child runbook it spawned.
 *
 * Reads (and consumes, once) active delegation token metadata from session
 * metadata at `input.cwd`. Identified hook payloads consume only their
 * matching `delegation_active_tokens[input.agent_id]` entry; legacy payloads
 * without `agent_id` consume the older global `delegation_active_token`.
 * The consumed token is hashed and correlated with the active runbook's
 * `parentLinkage.tokenHash` and the parent's outgoing delegations in
 * `rd status` to identify the exact delegation belonging to this subagent.
 *
 * Classifies the delegation into one of five {@link DelegationOutcome}
 * variants:
 * - **completed**: Child runbook finished (`rd pass`/`rd fail`) and was
 *   popped. If siblings remain, they are surfaced on the parent state.
 * - **child_claimed_idle**: Active runbook's `parentLinkage.tokenHash`
 *   matches ours — the subagent claimed the delegation but stopped before
 *   calling `rd pass`/`rd fail`. The child may have progressed internally.
 * - **child_stashed**: Child runbook was stashed via `rd stash`, not
 *   completed.
 * - **unclaimed**: Our token matches a pending delegation on the parent —
 *   the subagent stopped before calling `rd claim`.
 * - **unknown**: Correlation failed (stale session state, malformed
 *   parentLinkage, non-matching parentLinkage present on the active
 *   runbook, status query failed, or no-nesting invariant violated).
 *   Fallback context returned.
 *
 * Never destroys child runbook state.
 *
 * @param input - Hook event payload. `input.hook_event_name` gates
 *   execution, `input.cwd` opens the session and runs `rd status`, and
 *   optional `agent_id`/`session_id` scope per-agent token consumption.
 * @returns A promise for a {@link SubagentStopResult}: `{ context }` when
 *   the classification produces a message for the orchestrator, or `{}`
 *   when no action is needed (non-SubagentStop event, no active delegation
 *   token, or child completed cleanly with nothing further to report).
 * @throws {Error} Rejects if session metadata I/O fails (e.g. the session file is
 *   unreadable, not writable, or corrupt). Status-query failures, in
 *   contrast, are absorbed and collapsed to the `unknown` outcome.
 */
export async function handleSubagentStop(input: HookInput): Promise<SubagentStopResult> {
  if (input.hook_event_name !== 'SubagentStop') {
    return {};
  }

  const session = new Session(input.cwd);
  const consumed = await consumeDelegationTokenForAgent(session, input);
  if (consumed.kind === 'none') {
    return {};
  }
  if (consumed.kind === 'tampered') {
    return { context: buildContextMessage({ kind: 'unknown' }) };
  }

  return {
    violation:
      'Delegated Rundown work must be closed explicitly with rd pass --claim-id <claim_id> or rd fail --claim-id <claim_id>.',
  };
}
