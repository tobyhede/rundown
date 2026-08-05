import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import { CompletionLock } from './completion-lock.js';
import { DelegationLock } from './delegation-lock.js';
import type { ExecutionLifecycleService } from './execution-lifecycle-service.js';
import type { RunbookActorService, ActorSyncResult } from './actor-service.js';
import type { DelegationCredentialIssuer } from './delegation-credential.js';
import { merge } from './state-update-ops.js';
import { applyRunbookStateUpdate, type RunbookStateManager } from './state.js';
import { guardOptions, type ParentAdvanceGuard } from './storage/runbook-store.js';
import {
  SENTINEL_ENTRY,
  activeFrame,
  buildCompletionKey,
  buildResolvedCompletion,
  completionEntryForFrame,
  deriveActiveFrame,
  exactFrame,
  findSubstepState,
  frameHasExactEntry,
  inactiveFrame,
  upsertSubstepState,
  type Frame,
  type FrameKey,
} from './targeting.js';
import { deriveStoppedReason, extractInternalFailureMessage } from './transition-kernel.js';
import type {
  DelegationOutcome,
  ResolvedCompletion,
  ResolvedStep,
  RunId,
  RunbookState,
  SubstepState,
} from './types.js';
import type { VariableValue } from './effective-vars.js';

/**
 * Module-private brand symbol for {@link CurrentCursorResolvedCompletion}.
 *
 * Declared as a real `Symbol()` (typed as `unique symbol`) so callers outside
 * this module cannot forge the branded shape: TypeScript treats the symbol as
 * a distinct nominal value, and the binding is not exported. The only producer
 * of branded values is `resolveAgainstCurrentCursor` inside this module.
 */
const currentCursorValidatedBrand: unique symbol = Symbol('currentCursorValidated');

/**
 * Resolved completion that has been validated against the machine's active cursor.
 *
 * The `currentCursorValidatedBrand` symbol is unique to this module and cannot
 * be produced outside `resolveAgainstCurrentCursor`, so callers receiving
 * this type can rely on `targetSubstep` matching the current cursor.
 */
export type CurrentCursorResolvedCompletion = ResolvedCompletion & {
  /** Substep is required after current-cursor validation. */
  readonly targetSubstep: string;
  /** Brand proving this completion passed current-cursor validation. */
  readonly [currentCursorValidatedBrand]: true;
};

/**
 * Test-only producer of {@link CurrentCursorResolvedCompletion} for fixture construction.
 *
 * The brand symbol is module-private and cannot be produced outside this module.
 * This escape hatch concentrates the cast in one place so callers get full field
 * type-checking on the `ResolvedCompletion & { targetSubstep: string }` shape
 * while still satisfying the branded type required by the machine event.
 *
 * @param completion - Valid completion with required `targetSubstep`.
 * @returns The same value typed as `CurrentCursorResolvedCompletion`.
 */
export function brandCurrentCursorResolvedCompletionForTest(
  completion: ResolvedCompletion & { readonly targetSubstep: string },
): CurrentCursorResolvedCompletion {
  return completion as unknown as CurrentCursorResolvedCompletion;
}

/**
 * Map a delegated run lifecycle to the delegation outcome it reports.
 *
 * This is the canonical mapping used when projecting a delegated run terminal
 * state into the delegating run. Reuse it anywhere a delegated lifecycle must be
 * compared to a pass/fail command so the translation stays in lock-step with
 * aggregation.
 *
 * @param lifecycle - Runbook lifecycle value.
 * @returns `'pass'` for `completed`, `'fail'` for `stopped`, otherwise
 *   `undefined` (non-terminal lifecycle values have no delegation outcome).
 */
export function lifecycleToDelegationOutcome(
  lifecycle: RunbookState['lifecycle'],
): DelegationOutcome | undefined {
  if (lifecycle === 'completed') return 'pass';
  if (lifecycle === 'stopped') return 'fail';
  return undefined;
}

/** Projected terminal state for a delegation-linked child run. */
export type DelegationTerminalProjection =
  | { readonly kind: 'outcome'; readonly result: DelegationOutcome }
  | {
      readonly kind: 'command_infrastructure';
      readonly reason: 'policy_denied' | 'command_execution_failed';
      readonly message: string;
    }
  | { readonly kind: 'not_terminal' };

/**
 * Project a child run terminal state into its delegated parent outcome.
 *
 * Explicit operator results preserve the authored RESULT semantics. Inferred
 * reporting distinguishes command infrastructure stops from authored delegated
 * `fail` so recovery paths can leave the parent unadvanced.
 *
 * @param childState - Child run state being reported.
 * @param explicitResult - Optional explicit operator result to report.
 * @returns Projection describing the reportable delegated outcome, a blocked
 *   command-infrastructure terminal, or a non-terminal state.
 */
export function projectDelegationTerminalOutcome(
  childState: RunbookState,
  explicitResult?: DelegationOutcome,
): DelegationTerminalProjection {
  if (explicitResult !== undefined) {
    return { kind: 'outcome', result: explicitResult };
  }
  if (childState.lifecycle === 'completed') {
    return { kind: 'outcome', result: 'pass' };
  }
  if (childState.lifecycle !== 'stopped') {
    return { kind: 'not_terminal' };
  }

  const stoppedReason = deriveStoppedReason(childState.lastAction);
  if (stoppedReason === 'policy_denied' || stoppedReason === 'command_execution_failed') {
    const message =
      extractInternalFailureMessage(childState.lastAction) ??
      (childState.lastAction && 'message' in childState.lastAction
        ? childState.lastAction.message
        : stoppedReason);
    return {
      kind: 'command_infrastructure',
      reason: stoppedReason,
      message,
    };
  }

  return { kind: 'outcome', result: 'fail' };
}

/**
 * Existing-API wrapper for callers that still use generic result terminology.
 *
 * @deprecated Thin alias for {@link lifecycleToDelegationOutcome}; call that
 * canonical name directly. Retained only for callers still on generic result
 * terminology.
 *
 * @param lifecycle - Runbook lifecycle value.
 * @returns Delegation outcome for terminal lifecycle values, otherwise `undefined`.
 */
export function lifecycleToResult(
  lifecycle: RunbookState['lifecycle'],
): DelegationOutcome | undefined {
  return lifecycleToDelegationOutcome(lifecycle);
}

/** Completion applied to the machine during a drain pass. */
export interface AppliedResolvedCompletion {
  /**
   * Lifecycle key consumed for this application. Matches the key returned by
   * `consumeResolvedCompletion` — when the exact key was missing and a
   * sentinel-keyed completion was consumed, this reflects the sentinel key,
   * so logs and audits stay consistent with the lifecycle row that was
   * actually deleted.
   */
  readonly key: string;
  /** Validated completion sent into the machine. */
  readonly completion: CurrentCursorResolvedCompletion;
  /** State before the completion was applied. */
  readonly stateBefore: RunbookState;
  /** State after the completion was applied. */
  readonly stateAfter: RunbookState;
  /** Raw actor snapshot after the completion was applied. */
  readonly snapshot: unknown;
}

/** Target mismatch returned when a persisted completion is not for the active cursor. */
export interface CompletionTargetMismatch {
  /** Discriminant: drain refused to apply this completion. */
  readonly status: 'failed';
  /** Specific reason for the refusal — currently only `target_mismatch`. */
  readonly reason: 'target_mismatch';
  /** Human-readable diagnostic message naming the current cursor. */
  readonly message: string;
  /** The raw completion that triggered the mismatch. */
  readonly completion: ResolvedCompletion;
}

/** Target mismatch returned from a resolved-completion drain pass. */
export interface DrainCompletionTargetMismatch extends CompletionTargetMismatch {
  /** Count of substeps still without a persisted completion. */
  readonly unresolved: number;
  /** Completions applied before the mismatch was detected. */
  readonly applied: readonly AppliedResolvedCompletion[];
}

/** Result of recording a deferred completion. */
export type RecordCompletionResult =
  | {
      /** Discriminant: a new lifecycle row was written. */
      readonly status: 'recorded';
      /** Canonical completion key under which the completion was written. */
      readonly key: string;
    }
  | {
      /** Discriminant: an existing row already covered this target. */
      readonly status: 'duplicate';
      /** Canonical key of the pre-existing row that blocked the write. */
      readonly key: string;
    };

/** Pure manual-completion preparation for a fenced state commit. */
export type PreparedManualCompletion = RecordCompletionResult & {
  /** Parent state after the completion projection, unchanged for duplicates. */
  readonly nextState: RunbookState;
};

/** Arguments for recording a manual parent/substep completion. */
export interface RecordManualCompletionArgs {
  /** Run id of the parent state owning the lifecycle row. */
  readonly runbookId: RunId;
  /** Current persisted parent state — used for active-frame detection only. */
  readonly currentState: RunbookState;
  /** Target step id the completion is being recorded against. */
  readonly targetStep: string;
  /** Target substep id within the parent step. */
  readonly targetSubstep: string;
  /** Optional FOR iteration index if the target is inside a FOR-loop frame. */
  readonly targetIteration?: number;
  /** Frame target identifying the completion scope. */
  readonly targetFrame: Frame;
  /** Recorded result — drives the eventual PASS/FAIL raise on drain. */
  readonly result: 'pass' | 'fail';
  /** Agent identifier (`delegation`, `inline`, or a manual command id). */
  readonly agentId: string;
  /** Optional ISO 8601 timestamp; defaults to current time when omitted. */
  readonly completedAt?: string;
  /** Final variables produced by a child runbook, merged into context on drain. */
  readonly finalVars?: Readonly<Record<string, VariableValue>>;
}

/** Arguments for recording a completed child run against its parent. */
export interface RecordChildCompletionArgs {
  /** Terminal child state carrying `parentLinkage` and optional `finalVars`. */
  readonly childState: RunbookState;
  /** Optional explicit result; defaults to the child's terminal lifecycle. */
  readonly result?: 'pass' | 'fail';
  /** Optional ISO 8601 timestamp; defaults to current time when omitted. */
  readonly completedAt?: string;
  /**
   * Bypass the `delegation.cancelledAt` short-circuit. The default behavior
   * returns `'cancelled'` without writing a completion when the parent
   * substep has been cancelled, which protects against a still-running child
   * racing past a user-initiated cancel. The `abort --force` path persists
   * `cancelledAt` *as* the propagation event and needs the FAIL completion
   * recorded anyway, so it sets this flag.
   */
  readonly ignoreCancellation?: boolean;
}

/** Pure preparation result for an aggregate child-terminal report. */
export type PreparedChildCompletion =
  | {
      readonly kind: 'recorded';
      readonly key: string;
      readonly nextParentState: RunbookState;
    }
  | {
      readonly kind: 'duplicate' | 'not-applicable' | 'cancelled' | 'blocked';
    };

/** Arguments for draining persisted completions into the current machine cursor. */
export interface DrainResolvedCompletionsArgs {
  /** Run id of the runbook being drained. */
  readonly runbookId: RunId;
  /** Resolved step definitions for the runbook (used for substep ordering). */
  readonly steps: readonly ResolvedStep[];
  /** Current persisted state to derive active frame/cursor from. */
  readonly currentState: RunbookState;
  /**
   * Optional override frame — when supplied and not equal to the active
   * frame, drain short-circuits to `not_active` without dispatching any event.
   */
  readonly frameOverride?: Frame;
  /**
   * Optional upper bound on completions to apply in this drain pass.
   *
   * Used by callers that must observe each machine transition before the next
   * persisted completion is applied. Omitted means drain all currently
   * applicable completions.
   */
  readonly maxApplied?: number;
  /**
   * Optional parent-advance guard threaded into each applied completion's store
   * write. Supplied only when the drain IS the decisive parent-advancing write —
   * that is, when the preceding record short-circuited as a duplicate and so
   * evaluated no guard of its own. When present, a live delegated child aborts
   * the write inside its transaction.
   */
  readonly guard?: ParentAdvanceGuard;
  /** Verified runtime-only issuer for a completion transition that enters delegation. */
  readonly issueDelegationCredential?: DelegationCredentialIssuer;
}

/** Arguments for preparing a resolved-completion drain without persisting it. */
export interface PrepareResolvedCompletionDrainArgs {
  /** Run id of the runbook being drained. */
  readonly runbookId: RunId;
  /** Resolved step definitions for the runbook (used for substep ordering). */
  readonly steps: readonly ResolvedStep[];
  /**
   * The EXACT state captured under the caller's lease. Unlike the persisted
   * drain, nothing is re-read: every iteration chains off the previous
   * iteration's prepared state, so the whole pass is derived from one captured
   * version and can be committed against it.
   */
  readonly capturedState: RunbookState;
  /**
   * Optional override frame — when supplied and not equal to the active frame,
   * preparation short-circuits to `not_active` without deriving any transition.
   */
  readonly frameOverride?: Frame;
  /** Verified runtime-only issuer for a completion transition that enters delegation. */
  readonly issueDelegationCredential?: DelegationCredentialIssuer;
}

/**
 * Result of preparing a resolved-completion drain against a captured state.
 *
 * Structurally the persisted drain's result with `state` present on EVERY arm.
 * The persisted drain can omit it on the terminal arms because its caller
 * reloads the run it just wrote; a prepared pass has written nothing, so the
 * prepared state is the only carrier of what the commit must persist.
 */
export type PreparedResolvedCompletionDrain =
  | {
      /** Preparation advanced the cursor with remaining substeps still pending. */
      readonly status: 'continue';
      /** Prepared state after the last derived completion (or the captured state if none). */
      readonly state: RunbookState;
      /** Count of substeps still without a persisted completion. */
      readonly unresolved: number;
      /** Each completion derived during this pass, in dispatch order. */
      readonly applied: readonly AppliedResolvedCompletion[];
    }
  | {
      /** Preparation reached a terminal lifecycle (`done` or `stopped`). */
      readonly status: 'done' | 'stopped';
      /** Prepared terminal state the commit must persist. */
      readonly state: RunbookState;
      /** Always zero on terminal exits. */
      readonly unresolved: number;
      /** Each completion derived during this pass, in dispatch order. */
      readonly applied: readonly AppliedResolvedCompletion[];
    }
  | (DrainCompletionTargetMismatch & {
      /** Prepared state at the point the mismatch was detected. */
      readonly state: RunbookState;
    })
  | {
      /** Requested frame is not currently active; preparation derived nothing. */
      readonly status: 'not_active';
      /** Prepared state, unchanged apart from the active-entry projection. */
      readonly state: RunbookState;
      /** Frame key that was requested via `frameOverride`. */
      readonly frameKey: FrameKey;
      /** Frame key the machine is actually positioned on. */
      readonly activeFrameKey: FrameKey;
      /** Count of substeps still without a persisted completion. */
      readonly unresolved: number;
      /** Always empty when `not_active`. */
      readonly applied: readonly [];
    };

/** Result of a resolved-completion drain pass. */
export type DrainResolvedCompletionsResult =
  | {
      /** Drain advanced the cursor with remaining substeps still pending. */
      readonly status: 'continue';
      /** State after the last applied completion (or current state if none). */
      readonly state: RunbookState;
      /** Count of substeps still without a persisted completion. */
      readonly unresolved: number;
      /** Each completion applied during this pass, in dispatch order. */
      readonly applied: readonly AppliedResolvedCompletion[];
    }
  | {
      /** Runbook reached a terminal lifecycle (`done` or `stopped`). */
      readonly status: 'done' | 'stopped';
      /** Always zero on terminal exits. */
      readonly unresolved: number;
      /** Each completion applied during this pass, in dispatch order. */
      readonly applied: readonly AppliedResolvedCompletion[];
    }
  | DrainCompletionTargetMismatch
  | {
      /** Requested frame is not currently active; drain is observation-only. */
      readonly status: 'not_active';
      /** Frame key that was requested via `frameOverride`. */
      readonly frameKey: FrameKey;
      /** Frame key the machine is actually positioned on. */
      readonly activeFrameKey: FrameKey;
      /** Count of substeps still without a persisted completion. */
      readonly unresolved: number;
      /** Always empty when `not_active`. */
      readonly applied: readonly [];
    };

function findStepOrThrow(steps: readonly ResolvedStep[], stepName: string): ResolvedStep {
  const step = steps.find((candidate) => candidate.name === stepName);
  if (!step) throw new Error(`Step "${stepName}" not found`);
  return step;
}

/**
 * Map a state's lifecycle to the drain status that reports it, if terminal.
 *
 * The single lifecycle→status mapping, shared by the persisted drain (via
 * {@link terminalStatus}) and the prepared one, so a run reaching terminal is
 * named identically whether the pass committed per completion or derived the
 * whole thing for one commit.
 *
 * @param state - State whose lifecycle is classified.
 * @returns `'done'`/`'stopped'` for a terminal lifecycle, otherwise `undefined`.
 */
function terminalLifecycleStatus(state: RunbookState): 'done' | 'stopped' | undefined {
  if (state.lifecycle === 'completed') return 'done';
  if (state.lifecycle === 'stopped') return 'stopped';
  return undefined;
}

function terminalStatus(result: ActorSyncResult): 'done' | 'stopped' | undefined {
  return terminalLifecycleStatus(result.state);
}

function assertCompleteParentLinkage(
  childState: RunbookState,
): NonNullable<RunbookState['parentLinkage']> {
  const linkage = childState.parentLinkage;
  if (!linkage) {
    throw new Error(`Child run ${childState.id} has no parentLinkage.`);
  }
  return linkage;
}

/**
 * Find an already-resolved completion for a target inside a state blob.
 *
 * The in-state twin of {@link RunbookCompletionService.findExistingCompletion},
 * and deliberately entry-PRECISE for a frame that carries one. Completion keys
 * embed the entry, and a RETRY/GOTO that re-opens a substep bumps it, so a row
 * left by an earlier entry on the same frame is not a duplicate of this one —
 * matching on `frameKey` + `substep` alone would refuse the legitimate
 * re-completion and strand the re-entered substep with no way to resolve it.
 * Only a sentinel-entry frame, which names no entry, falls back to the
 * frame-wide match.
 *
 * @param state - State whose `resolvedCompletions` map is searched.
 * @param targetFrame - Frame the completion targets.
 * @param targetSubstep - Substep the completion targets.
 * @returns The existing key, or `undefined` when the target is unresolved.
 */
function findCompletionKeyInState(
  state: RunbookState,
  targetFrame: Frame,
  targetSubstep: string,
): string | undefined {
  const existing = state.resolvedCompletions ?? {};
  if (frameHasExactEntry(targetFrame)) {
    const exactKey = buildCompletionKey(targetFrame, targetSubstep);
    if (Object.hasOwn(existing, exactKey)) return exactKey;
    const sentinelKey = buildCompletionKey(inactiveFrame(targetFrame.frameKey), targetSubstep);
    return Object.hasOwn(existing, sentinelKey) ? sentinelKey : undefined;
  }
  return Object.entries(existing).find(
    ([, completion]) =>
      completion.targetFrameKey === targetFrame.frameKey &&
      completion.targetSubstep === targetSubstep,
  )?.[0];
}

/**
 * List a state's resolved completions for a frame target, without IO.
 *
 * The in-state twin of {@link ExecutionLifecycleService.listResolvedCompletions},
 * matching its key-prefix rule exactly (an `active` frame also admits the
 * sentinel entry; an exact frame does not). The prepared drain must classify
 * against the state it captured, not against whatever the store holds now, so
 * it cannot reuse the loading method.
 *
 * @param state - State whose `resolvedCompletions` map is read.
 * @param frame - Frame target to list.
 * @returns Key/completion pairs matching the frame target.
 */
function listResolvedCompletionsInState(
  state: RunbookState,
  frame: Frame,
): ReadonlyArray<{ readonly key: string; readonly completion: ResolvedCompletion }> {
  const entry = completionEntryForFrame(frame);
  const exactPrefix = `${frame.frameKey}|${String(entry)}|`;
  const sentinelPrefix = `${frame.frameKey}|${String(SENTINEL_ENTRY)}|`;
  return Object.entries(state.resolvedCompletions ?? {})
    .filter(([key]) =>
      frame.kind === 'active'
        ? key.startsWith(exactPrefix) || key.startsWith(sentinelPrefix)
        : key.startsWith(exactPrefix),
    )
    .map(([key, completion]) => ({ key, completion }));
}

/**
 * Observe every substep a state records a completion for on one frame key.
 *
 * The in-state twin of `RunbookCompletionService#observedSubstepsForFrame`,
 * matching its `targetFrameKey` rule (frame-wide, across entries) rather than
 * the key-prefix rule used for an entry-scoped list.
 *
 * @param state - State whose `resolvedCompletions` map is read.
 * @param frameKey - Frame key to observe.
 * @returns The set of substep ids carrying a completion on that frame.
 */
function observedSubstepsForFrameInState(
  state: RunbookState,
  frameKey: FrameKey,
): ReadonlySet<string> {
  return new Set(
    Object.values(state.resolvedCompletions ?? {})
      .filter((completion) => completion.targetFrameKey === frameKey)
      .map((completion) => completion.targetSubstep)
      .filter((substep): substep is string => substep !== undefined),
  );
}

/** State the manual-completion decision reads, supplied by each caller. */
interface ManualCompletionEvidence {
  /** State whose cursor decides whether the target is the live one. */
  readonly cursorState: RunbookState;
  /** Substep states searched for a prior `done` resolution. */
  readonly substepStates: readonly SubstepState[];
  /** Key of an already-recorded completion for this target; nullish when unresolved. */
  readonly existingKey: string | null | undefined;
}

/** The single decision behind recording or preparing a manual completion. */
type ManualCompletionDecision =
  | { readonly status: 'duplicate'; readonly key: string }
  | {
      readonly status: 'recorded';
      readonly key: string;
      readonly completion: ResolvedCompletion;
    };

/**
 * Decide whether a manual completion is a duplicate, and build it when it is not.
 *
 * The sole owner of the duplicate rule, shared by the locking recorder and the
 * fenced pure preparation so the two can never disagree about whether a substep
 * has already been resolved. Evidence is passed in rather than read here: the
 * recorder classifies against the freshest persisted state, while the fenced
 * twin must classify against the exact state captured under its lease.
 *
 * @param args - Manual completion target and result.
 * @param evidence - Cursor state, substep states, and any existing completion key.
 * @returns The duplicate verdict, or the key and completion to persist.
 */
function classifyManualCompletionTarget(
  args: RecordManualCompletionArgs,
  evidence: ManualCompletionEvidence,
): ManualCompletionDecision {
  const key = buildCompletionKey(args.targetFrame, args.targetSubstep);
  // Nullish, not falsy-in-general: the store lookup answers `null` for "not
  // found" while the in-state scan answers `undefined`, and an empty-string key
  // is not representable.
  if (evidence.existingKey != null) {
    return { status: 'duplicate', key: evidence.existingKey };
  }

  // A consumed completion leaves no resolved-completion row behind (the actor
  // deletes it on sync), so `substepStates` is the only persistent record that
  // a substep was already resolved. Use it to detect a genuine duplicate — a
  // caller resolving a substep the cursor has already moved past.
  //
  // This must NOT fire when the cursor is currently positioned on the target
  // substep: a RETRY/GOTO that re-opens a substep leaves its prior `done`
  // status in place (the machine does not reset it), and the next resolution
  // of the now-active cursor is a legitimate re-completion, not a duplicate.
  const activeFrameKey =
    evidence.cursorState.activeFrameKey ?? deriveActiveFrame(evidence.cursorState).frameKey;
  const isActiveCursorTarget =
    args.targetSubstep === evidence.cursorState.substep &&
    args.targetFrame.frameKey === activeFrameKey;
  if (!isActiveCursorTarget) {
    const existingSubstepState = findSubstepState(
      evidence.substepStates,
      args.targetSubstep,
      args.targetFrame.frameKey,
    );
    if (existingSubstepState?.status === 'done') return { status: 'duplicate', key };
  }

  return {
    status: 'recorded',
    key,
    completion: buildResolvedCompletion({
      agentId: args.agentId,
      result: args.result,
      targetStep: args.targetStep,
      targetSubstep: args.targetSubstep,
      targetIteration: args.targetIteration,
      targetFrame: args.targetFrame,
      finalVars: args.finalVars,
      completedAt: args.completedAt,
    }),
  };
}

/**
 * Whether a delegated child report has already been resolved by its parent.
 *
 * @param state - Exact parent state being classified.
 * @param targetFrame - Frame entry named by the child linkage.
 * @param targetSubstep - Parent substep named by the child linkage.
 * @returns Whether an outcome row or a non-active done substep makes the report duplicate.
 */
function isDuplicateChildCompletion(
  state: RunbookState,
  targetFrame: Frame,
  targetSubstep: string,
): boolean {
  const hasRecordedOutcome = Object.values(state.resolvedCompletions ?? {}).some(
    (completion) =>
      completion.targetFrameKey === targetFrame.frameKey &&
      completion.targetSubstep === targetSubstep,
  );
  if (hasRecordedOutcome) return true;

  const activeFrameKey = state.activeFrameKey ?? deriveActiveFrame(state).frameKey;
  const activeEntry = state.activeEntry ?? 1;
  const isActiveCursorTarget =
    targetFrame.kind === 'active' &&
    targetFrame.entry === activeEntry &&
    targetSubstep === state.substep &&
    targetFrame.frameKey === activeFrameKey;
  return (
    !isActiveCursorTarget &&
    findSubstepState(state.substepStates ?? [], targetSubstep, targetFrame.frameKey)?.status ===
      'done'
  );
}

/**
 * Core service for recording and applying resolved runbook completions.
 */
export class RunbookCompletionService {
  /**
   * Create a completion service.
   *
   * @param manager - Runbook state manager
   * @param lifecycleService - Lifecycle persistence helper
   * @param actorService - DI-aware actor service used to apply validated completions
   */
  constructor(
    private readonly manager: RunbookStateManager,
    private readonly lifecycleService: ExecutionLifecycleService,
    private readonly actorService: RunbookActorService,
  ) {}

  /**
   * Prepare a delegated child report against an exact captured parent state.
   *
   * This performs no IO. Aggregate terminal workflows can include the returned
   * parent state in the same owned run-set commit as the child terminal state.
   *
   * @param args - Terminal child report input.
   * @param parentState - Exact captured delegating parent state.
   * @returns Prepared parent state or a typed no-write outcome.
   */
  prepareChildCompletion(
    args: RecordChildCompletionArgs,
    parentState: RunbookState,
  ): PreparedChildCompletion {
    if (!args.childState.parentLinkage) return { kind: 'not-applicable' };
    const linkage = assertCompleteParentLinkage(args.childState);
    if (parentState.id !== linkage.parentRunId) return { kind: 'not-applicable' };
    const projection = projectDelegationTerminalOutcome(args.childState, args.result);
    if (projection.kind === 'not_terminal') return { kind: 'not-applicable' };
    if (projection.kind === 'command_infrastructure') return { kind: 'blocked' };

    const activeParentFrameKey =
      parentState.activeFrameKey ?? deriveActiveFrame(parentState).frameKey;
    const activeParentEntry = parentState.activeEntry ?? 1;
    const substepState = findSubstepState(
      parentState.substepStates ?? [],
      linkage.parentStepId,
      linkage.parentFrameKey,
    );
    if (
      linkage.kind === 'delegation' &&
      substepState?.delegation?.tokenHash !== undefined &&
      substepState.delegation.tokenHash !== linkage.tokenHash
    ) {
      return { kind: 'not-applicable' };
    }
    if (
      linkage.kind === 'delegation' &&
      substepState?.delegation?.cancelledAt &&
      !args.ignoreCancellation
    ) {
      return { kind: 'cancelled' };
    }

    const targetFrame =
      linkage.parentFrameKey === activeParentFrameKey && linkage.parentEntry === activeParentEntry
        ? activeFrame(linkage.parentFrameKey, activeParentEntry)
        : exactFrame(linkage.parentFrameKey, linkage.parentEntry);
    const key = buildCompletionKey(targetFrame, linkage.parentStepId);
    // Frame-WIDE on purpose, unlike the entry-precise manual lookup above: a
    // delegated child reports against the linkage it was issued under, so any
    // recorded outcome for this parent substep — whatever entry it carries —
    // already answers this report. `recordChildCompletion` uses the same rule.
    if (isDuplicateChildCompletion(parentState, targetFrame, linkage.parentStepId)) {
      return { kind: 'duplicate' };
    }

    const completion = buildResolvedCompletion({
      agentId: linkage.kind === 'inline' ? 'inline' : 'delegation',
      result: projection.result,
      targetStep: linkage.parentStep,
      targetSubstep: linkage.parentStepId,
      targetFrame,
      finalVars: args.childState.finalVars,
      completedAt: args.completedAt,
    });
    const nextParentState = applyRunbookStateUpdate(
      parentState,
      {
        resolvedCompletions: merge({ [key]: completion }),
        substepStates: upsertSubstepState(
          parentState.substepStates ?? [],
          linkage.parentStepId,
          linkage.parentFrameKey,
          { status: 'done', result: projection.result },
        ),
      },
      args.completedAt ?? new Date().toISOString(),
    );
    return { kind: 'recorded', key, nextParentState };
  }

  /**
   * Prepare one manual completion against an exact captured state without IO.
   *
   * @param args - Manual completion target and result.
   * @returns Duplicate/recorded status plus the prepared parent state.
   */
  prepareManualCompletion(args: RecordManualCompletionArgs): PreparedManualCompletion {
    const decision = classifyManualCompletionTarget(args, {
      cursorState: args.currentState,
      substepStates: args.currentState.substepStates ?? [],
      existingKey: findCompletionKeyInState(
        args.currentState,
        args.targetFrame,
        args.targetSubstep,
      ),
    });
    if (decision.status === 'duplicate') {
      return { status: 'duplicate', key: decision.key, nextState: args.currentState };
    }
    const { key, completion } = decision;
    const nextState = applyRunbookStateUpdate(
      args.currentState,
      {
        resolvedCompletions: merge({ [key]: completion }),
        substepStates: upsertSubstepState(
          args.currentState.substepStates ?? [],
          args.targetSubstep,
          args.targetFrame.frameKey,
          { status: 'done', result: args.result },
        ),
      },
      args.completedAt ?? new Date().toISOString(),
    );
    return { status: 'recorded', key, nextState };
  }

  /**
   * Validate a completion against the live in-memory cursor.
   *
   * @param state - Current prepared state.
   * @param completion - Completion candidate.
   * @param entry - Live active entry.
   * @returns Branded current-cursor completion or mismatch.
   */
  validateCurrentCompletion(
    state: RunbookState,
    completion: ResolvedCompletion,
    entry: number,
  ): CurrentCursorResolvedCompletion | CompletionTargetMismatch {
    return this.resolveAgainstCurrentCursor(state, completion, { entry });
  }

  private async findExistingCompletion(
    runbookId: RunId,
    args: { readonly frame: Frame; readonly substep: string },
  ): Promise<string | null> {
    if (frameHasExactEntry(args.frame)) {
      const exactKey = buildCompletionKey(args.frame, args.substep);
      const sentinelKey = buildCompletionKey(inactiveFrame(args.frame.frameKey), args.substep);
      if (await this.lifecycleService.getResolvedCompletion(runbookId, exactKey)) return exactKey;
      if (await this.lifecycleService.getResolvedCompletion(runbookId, sentinelKey))
        return sentinelKey;
      return null;
    }

    const observed = await this.lifecycleService.listResolvedCompletionsForFrameObservation(
      runbookId,
      args.frame.frameKey,
    );
    return (
      observed.find(({ completion }) => completion.targetSubstep === args.substep)?.key ?? null
    );
  }

  private async observedSubstepsForFrame(
    runbookId: RunId,
    frameKey: FrameKey,
  ): Promise<ReadonlySet<string>> {
    const observed = await this.lifecycleService.listResolvedCompletionsForFrameObservation(
      runbookId,
      frameKey,
    );
    return new Set(
      observed
        .map(({ completion }) => completion.targetSubstep)
        .filter((substep): substep is string => substep !== undefined),
    );
  }

  private async countUnresolvedForState(
    runbookId: RunId,
    steps: readonly ResolvedStep[],
    state: RunbookState,
  ): Promise<number> {
    const currentStep = findStepOrThrow(steps, state.step);
    if (!resolvedStepHasSubsteps(currentStep) || !state.substep) return 0;
    const activeFrameKey = state.activeFrameKey ?? deriveActiveFrame(state).frameKey;
    const resolved = await this.lifecycleService.listResolvedCompletions(
      runbookId,
      activeFrame(activeFrameKey, state.activeEntry ?? 1),
    );
    const resolvedSubsteps = new Set(
      resolved
        .map(({ completion }) => completion.targetSubstep)
        .filter((substep): substep is string => substep !== undefined),
    );
    return currentStep.substeps.filter((substep) => !resolvedSubsteps.has(substep.id)).length;
  }

  /**
   * Narrow a {@link ResolvedCompletion} to the current cursor, rejecting any
   * row whose target step/substep/frame does not match.
   *
   * On a match the returned value is normalised against the live cursor:
   * `targetSubstep` is set to `state.substep`, and `targetEntry` is rewritten
   * from {@link SENTINEL_ENTRY} (or any persisted entry) to the live active
   * entry so downstream consumers always see the resolved entry rather than
   * the sentinel.
   *
   * @param state - Current runbook state.
   * @param completion - Resolved completion candidate.
   * @param ensured - Live active entry derived by the caller.
   * @param ensured.entry - Live active entry number.
   * @returns A branded {@link CurrentCursorResolvedCompletion} on match, or a
   *   {@link CompletionTargetMismatch} describing the rejection.
   */
  private resolveAgainstCurrentCursor(
    state: RunbookState,
    completion: ResolvedCompletion,
    ensured: { readonly entry: number },
  ): CurrentCursorResolvedCompletion | CompletionTargetMismatch {
    if (!state.substep) {
      return {
        status: 'failed',
        reason: 'target_mismatch',
        message: 'Resolved completion cannot apply because the current cursor has no substep.',
        completion,
      };
    }
    const activeFrameKey = state.activeFrameKey ?? deriveActiveFrame(state).frameKey;
    const activeEntry = state.activeEntry ?? ensured.entry;
    const mismatch =
      completion.targetStep !== state.step ||
      completion.targetSubstep !== state.substep ||
      completion.targetFrameKey !== activeFrameKey ||
      (completion.targetEntry !== activeEntry && completion.targetEntry !== SENTINEL_ENTRY);
    if (mismatch) {
      return {
        status: 'failed',
        reason: 'target_mismatch',
        message: `Resolved completion target does not match current cursor ${state.step}.${state.substep}.`,
        completion,
      };
    }
    return {
      ...completion,
      targetSubstep: state.substep,
      targetEntry: activeEntry,
      [currentCursorValidatedBrand]: true,
    };
  }

  /**
   * Record a manual completion for a parent substep.
   *
   * Acquires the run {@link CompletionLock} for the duration of the write.
   * Callers that already hold the run's completion lock MUST use
   * {@link recordManualCompletionUnlocked} instead — the lock is exclusive and
   * non-reentrant, so re-acquiring here would deadlock.
   *
   * @param args - Manual completion target and result
   * @param options - Optional write options.
   * @param options.guard - Parent-advance guard forwarded to the completion write; when present it refuses if the run has a live delegated child.
   * @returns Whether a completion was recorded or already existed
   */
  async recordManualCompletion(
    args: RecordManualCompletionArgs,
    options: { readonly guard?: ParentAdvanceGuard } = {},
  ): Promise<RecordCompletionResult> {
    const lock = new CompletionLock(this.manager.cwd);
    await using _guard = await lock.scope(args.runbookId);
    return await this.recordManualCompletionUnlocked(args, options);
  }

  /**
   * Record a manual completion while the caller holds the completion lock.
   *
   * Locking contract: this method performs no locking and MUST only be called
   * by code paths that already hold the run's {@link CompletionLock} (for
   * example the lifecycle seam's explicit-target span, which derives the
   * cursor, records, and drains under one lock scope — #500). Callers without
   * the lock must use {@link recordManualCompletion}.
   *
   * @param args - Manual completion target and result
   * @param options - Optional write options.
   * @param options.guard - Parent-advance guard forwarded to the completion write; when present it refuses if the run has a live delegated child.
   * @returns Whether a completion was recorded or already existed
   */
  async recordManualCompletionUnlocked(
    args: RecordManualCompletionArgs,
    options: { readonly guard?: ParentAdvanceGuard } = {},
  ): Promise<RecordCompletionResult> {
    // The one difference from the pure twin, and the reason the shared decision
    // takes its inputs rather than reading them: this path re-reads the freshest
    // persisted state, while the fenced twin must classify against the exact
    // state it captured under its lease.
    const freshState = await this.manager.load(args.runbookId);
    const decision = classifyManualCompletionTarget(args, {
      cursorState: freshState ?? args.currentState,
      substepStates: freshState?.substepStates ?? args.currentState.substepStates ?? [],
      existingKey: await this.findExistingCompletion(args.runbookId, {
        frame: args.targetFrame,
        substep: args.targetSubstep,
      }),
    });
    if (decision.status === 'duplicate') return { status: 'duplicate', key: decision.key };
    const { key, completion } = decision;

    // Persist the resolved completion row and its mirrored substep state in a
    // single locked read-modify-write. Splitting these into two writes (e.g. via
    // upsertResolvedCompletion + a separate updateWithState) opens a window in
    // which a concurrent reader observes a resolved row without its matching
    // `done` substep state, and a concurrent delete between them flips the
    // missing-parent behavior. updateWithState throws if the parent is gone,
    // which is the intended fail-closed semantics for recording a completion.
    await this.manager.updateWithState(
      args.runbookId,
      (freshParent) => {
        return {
          resolvedCompletions: merge({ [key]: completion }),
          substepStates: upsertSubstepState(
            freshParent.substepStates ?? [],
            args.targetSubstep,
            args.targetFrame.frameKey,
            { status: 'done', result: args.result },
          ),
        };
      },
      guardOptions(options.guard),
    );

    return { status: 'recorded', key };
  }

  /**
   * Report a delegated child's terminal outcome to its delegating run.
   *
   * This is the REPORT half of the report-then-collect split (Plan 5): it
   * records a `resolvedCompletions` row (`agentId: 'delegation'`) on the
   * delegating run. That row is what `readDelegationCollectionPendingForPolicy`
   * reads (leaving the delegating run collection pending) and what
   * `collectDelegationOutcomes` later consumes. Reporting NEVER drains or
   * applies the outcome to the delegating run — collection is the only apply
   * path.
   *
   * Acquires the parent {@link DelegationLock} for the duration of the
   * recording. Callers that already hold the parent delegation lock must use
   * {@link recordChildCompletionUnlocked} instead to avoid deadlock.
   *
   * @param args - Child completion input
   * @returns The recording outcome:
   * - `'recorded'` — a new delegation outcome row was written; the delegating
   *   run is now collection pending.
   * - `'duplicate'` — an equivalent outcome row already existed; no write.
   * - `'cancelled'` — the parent substep was ordinarily cancelled, so no fail
   *   outcome is written (preserving the cancellation split).
   * - `'blocked'` — the child stopped for command infrastructure reasons that
   *   must remain recoverable instead of becoming delegated fail.
   * - `'not-applicable'` — the child carries no parent linkage (or no terminal
   *   result), so there is nothing to report.
   */
  async recordChildCompletion(
    args: RecordChildCompletionArgs,
  ): Promise<'recorded' | 'duplicate' | 'not-applicable' | 'cancelled' | 'blocked'> {
    const linkage = args.childState.parentLinkage;
    if (!linkage) return 'not-applicable';
    assertCompleteParentLinkage(args.childState);

    const lock = new DelegationLock(this.manager.cwd);
    await using _guard = await lock.scope(linkage.parentRunId);
    return await this.recordChildCompletionUnlocked(args);
  }

  /**
   * Record a completed child run against its parent linkage, assuming the
   * caller already holds the parent {@link DelegationLock}.
   *
   * Locking contract: this method performs no locking and MUST only be called
   * by code paths that already hold the parent delegation lock (for example,
   * the `abort --force` command which acquires the lock to mutate substep
   * state before recording the failure). Callers without the lock should use
   * {@link recordChildCompletion}.
   *
   * @param args - Child completion input
   * @returns Recording outcome
   */
  async recordChildCompletionUnlocked(
    args: RecordChildCompletionArgs,
  ): Promise<'recorded' | 'duplicate' | 'not-applicable' | 'cancelled' | 'blocked'> {
    if (!args.childState.parentLinkage) return 'not-applicable';
    const linkage = assertCompleteParentLinkage(args.childState);
    const projection = projectDelegationTerminalOutcome(args.childState, args.result);
    if (projection.kind === 'not_terminal') return 'not-applicable';
    if (projection.kind === 'command_infrastructure') return 'blocked';
    const result = projection.result;

    const parentState = await this.manager.load(linkage.parentRunId);
    if (!parentState) return 'not-applicable';
    const activeParentFrameKey =
      parentState.activeFrameKey ?? deriveActiveFrame(parentState).frameKey;
    const activeParentEntry = parentState.activeEntry ?? 1;
    const frameKey = linkage.parentFrameKey;
    const substepState = findSubstepState(
      parentState.substepStates ?? [],
      linkage.parentStepId,
      frameKey,
    );
    const currentTokenHash = substepState?.delegation?.tokenHash;
    if (
      linkage.kind === 'delegation' &&
      currentTokenHash !== undefined &&
      currentTokenHash !== linkage.tokenHash
    ) {
      return 'not-applicable';
    }
    if (
      linkage.kind === 'delegation' &&
      substepState?.delegation?.cancelledAt &&
      !args.ignoreCancellation
    ) {
      return 'cancelled';
    }
    const targetFrame =
      frameKey === activeParentFrameKey && linkage.parentEntry === activeParentEntry
        ? activeFrame(frameKey, activeParentEntry)
        : exactFrame(frameKey, linkage.parentEntry);
    if (isDuplicateChildCompletion(parentState, targetFrame, linkage.parentStepId)) {
      return 'duplicate';
    }
    const recorded = await this.recordManualCompletion({
      runbookId: linkage.parentRunId,
      currentState: parentState,
      targetStep: linkage.parentStep,
      targetSubstep: linkage.parentStepId,
      targetFrame,
      result,
      agentId: linkage.kind === 'inline' ? 'inline' : 'delegation',
      finalVars: args.childState.finalVars,
      completedAt: args.completedAt,
    });
    return recorded.status;
  }

  /**
   * Consume stale delegated outcome rows for a substep.
   *
   * Caller must already hold the parent run's DelegationLock. This method is
   * intentionally unlocked because retry and force-abort cleanup already
   * execute inside that lock and a second acquisition would deadlock.
   *
   * @param args - Parent run id, frame, and substep whose delegated rows are stale.
   * @param args.runbookId - Parent run id containing stale delegated outcome rows.
   * @param args.frameKey - Parent frame key containing the target substep.
   * @param args.substepId - Parent substep id whose delegated rows are stale.
   * @returns Number of rows consumed.
   */
  async supersedeDelegationOutcomeUnlocked(args: {
    readonly runbookId: RunId;
    readonly frameKey: FrameKey;
    readonly substepId: string;
  }): Promise<number> {
    const rows = await this.lifecycleService.listResolvedCompletionsForFrameObservation(
      args.runbookId,
      args.frameKey,
    );
    let removed = 0;
    for (const { key, completion } of rows) {
      if (completion.targetSubstep === args.substepId && completion.agentId === 'delegation') {
        const consumed = await this.lifecycleService.consumeResolvedCompletion(args.runbookId, key);
        if (consumed) removed += 1;
      }
    }
    return removed;
  }

  /**
   * Derive a whole resolved-completion drain against one captured state,
   * without persisting anything.
   *
   * The fenced twin of {@link drainResolvedCompletionsUnlocked}, and the seam
   * that makes a drain committable in ONE transaction. Three substitutions turn
   * the persisted loop into a pure one, and each replaces a write or a re-read
   * with its existing pure counterpart:
   *
   * - {@link ExecutionLifecycleService.ensureActiveEntry} (which persists the
   *   active-entry projection) becomes
   *   {@link ExecutionLifecycleService.deriveActiveEntry}, whose projection is
   *   carried forward on the chained state instead of written. This also side-
   *   steps the unfenced read-modify-write `ensureActiveEntry` performs: the
   *   projection is derived from — and committed against — the captured version.
   * - Every store read of `resolvedCompletions` becomes the in-state twin, so
   *   the pass classifies against the exact captured version rather than
   *   whatever the store holds by the time each iteration runs.
   * - {@link RunbookActorService.sendAndSync} (one transaction per completion)
   *   becomes {@link RunbookActorService.prepareActorMutation}, whose
   *   `nextState` already folds in the consumed-completion patch and feeds the
   *   next iteration.
   *
   * WHY NOT MAKE THE PERSISTED DRAIN ATOMIC IN PLACE. That drain is shared with
   * the CLI execution loop and the delegation-completion adapters, and its
   * per-completion commit is a deliberate decision (see the guard comment in
   * {@link drainResolvedCompletionsUnlocked}): only the FIRST apply carries the
   * parent-advance guard, because re-arming it on a follow-on apply would let an
   * unrelated child claiming mid-drain abort a pass whose earlier applies had
   * already committed, stranding them behind a bare refusal. That trade-off is a
   * consequence of partial commits, and it does not transfer here: this seam
   * commits once, so a refusal leaves NOTHING committed and there is no stranded
   * prefix to protect. It accepts no guard for the same reason — its sole caller,
   * `collectDelegationOutcomes`, passes none, and an aggregate guard belongs on
   * the commit rather than on an individual derivation.
   *
   * @param args - Captured state, steps, and optional frame override.
   * @returns The prepared pass: every arm carries the state the commit must persist.
   * @throws {Error} If a step named by the cursor is missing from `steps`, or if
   *   {@link RunbookActorService.prepareActorMutation} rejects the derived
   *   snapshot (invalid shape, actor error state).
   */
  async prepareResolvedCompletionDrain(
    args: PrepareResolvedCompletionDrainArgs,
  ): Promise<PreparedResolvedCompletionDrain> {
    let state = args.capturedState;
    const applied: AppliedResolvedCompletion[] = [];
    for (;;) {
      const currentStep = findStepOrThrow(args.steps, state.step);
      if (!resolvedStepHasSubsteps(currentStep) || !state.substep) {
        return { status: 'continue', state, unresolved: 0, applied };
      }
      const ensured = this.lifecycleService.deriveActiveEntry(state);
      state = ensured.state;
      const activeFrameKey = state.activeFrameKey ?? ensured.frameKey;
      const requestedFrame = args.frameOverride;
      if (requestedFrame && requestedFrame.frameKey !== activeFrameKey) {
        // Same two cases the persisted drain distinguishes: an INITIAL mismatch
        // is observation-only and reports `not_active`; a mismatch AFTER work
        // means an apply advanced the cursor out of the override frame, and the
        // derived entries must be kept so the caller can still observe them.
        if (applied.length > 0) {
          return { status: 'continue', state, unresolved: 0, applied };
        }
        const overrideResolvedSubsteps = observedSubstepsForFrameInState(
          state,
          requestedFrame.frameKey,
        );
        const unresolved = currentStep.substeps.filter(
          (substep) => !overrideResolvedSubsteps.has(substep.id),
        ).length;
        return {
          status: 'not_active',
          state,
          frameKey: requestedFrame.frameKey,
          activeFrameKey,
          unresolved,
          applied: [],
        };
      }

      const entry = state.activeEntry ?? ensured.entry;
      const activeTargetFrame = activeFrame(activeFrameKey, entry);
      const resolved = listResolvedCompletionsInState(state, activeTargetFrame);
      const resolvedBySubstep = new Map(
        resolved
          .filter(({ completion }) => completion.targetSubstep !== undefined)
          .map(({ completion }) => [completion.targetSubstep, completion]),
      );
      const unresolved = currentStep.substeps.filter(
        (substep) => !resolvedBySubstep.has(substep.id),
      ).length;
      const currentKey = buildCompletionKey(activeTargetFrame, state.substep);
      const current =
        resolved.find(({ key }) => key === currentKey) ??
        resolved.find(
          ({ key, completion }) =>
            key === buildCompletionKey(inactiveFrame(activeFrameKey), state.substep) ||
            completion.targetSubstep === state.substep,
        );
      if (!current) {
        return { status: 'continue', state, unresolved, applied };
      }

      const validated = this.resolveAgainstCurrentCursor(state, current.completion, ensured);
      if (!(currentCursorValidatedBrand in validated)) {
        return { ...validated, state, unresolved, applied };
      }

      const mutation = await this.actorService.prepareActorMutation(
        args.runbookId,
        state,
        args.steps,
        {
          type: 'APPLY_CURRENT_RESOLVED_COMPLETION',
          completionKey: current.key,
          completion: validated,
        },
        args.issueDelegationCredential === undefined
          ? undefined
          : { issueDelegationCredential: args.issueDelegationCredential },
      );
      applied.push({
        key: current.key,
        completion: validated,
        stateBefore: state,
        stateAfter: mutation.nextState,
        snapshot: mutation.snapshot,
      });
      state = mutation.nextState;
      const terminal = terminalLifecycleStatus(state);
      if (terminal) return { status: terminal, state, unresolved: 0, applied };
    }
  }

  /**
   * Drain active-frame resolved completions into the runbook state machine.
   *
   * Acquires the run {@link CompletionLock} for the duration of the drain
   * pass. Callers that already hold the run's completion lock MUST use
   * {@link drainResolvedCompletionsUnlocked} instead to avoid deadlock.
   *
   * @param args - Drain target and current state
   * @returns Drain outcome
   */
  async drainResolvedCompletions(
    args: DrainResolvedCompletionsArgs,
  ): Promise<DrainResolvedCompletionsResult> {
    const lock = new CompletionLock(this.manager.cwd);
    await using _guard = await lock.scope(args.runbookId);
    return await this.drainResolvedCompletionsUnlocked(args);
  }

  /**
   * Drain active-frame resolved completions while the caller holds the
   * completion lock.
   *
   * Locking contract: this method performs no locking and MUST only be called
   * by code paths that already hold the run's {@link CompletionLock} (the
   * missing twin of {@link recordManualCompletionUnlocked} — #500). Callers
   * without the lock must use {@link drainResolvedCompletions}.
   *
   * @param args - Drain target and current state
   * @returns Drain outcome
   */
  async drainResolvedCompletionsUnlocked(
    args: DrainResolvedCompletionsArgs,
  ): Promise<DrainResolvedCompletionsResult> {
    let state = args.currentState;
    const applied: AppliedResolvedCompletion[] = [];
    for (;;) {
      const currentStep = findStepOrThrow(args.steps, state.step);
      if (!resolvedStepHasSubsteps(currentStep) || !state.substep) {
        return { status: 'continue', state, unresolved: 0, applied };
      }
      const ensured = await this.lifecycleService.ensureActiveEntry(
        args.runbookId,
        undefined,
        state,
      );
      state = ensured.state;
      const activeFrameKey = state.activeFrameKey ?? ensured.frameKey;
      const requestedFrame = args.frameOverride;
      if (requestedFrame && requestedFrame.frameKey !== activeFrameKey) {
        // The cursor has moved off the override frame. Two cases:
        //
        // 1. Initial mismatch (`applied.length === 0`): the override targets a
        //    frame other than the current cursor — drain is observation-only.
        //    Return `not_active` so the caller knows nothing was applied.
        //
        // 2. Subsequent mismatch (`applied.length > 0`): we already drained
        //    the override frame, and the apply itself advanced the cursor to
        //    a new frame (e.g., a FOR loop-back into the next iteration). We
        //    must NOT discard the applied entries — the CLI still needs to
        //    observe them so STEP_TRANSITIONED is emitted. Stop draining here
        //    and return `continue` with what we have; the next iteration's
        //    frame belongs to a different delegation/claim flow.
        if (applied.length > 0) {
          return { status: 'continue', state, unresolved: 0, applied };
        }
        const overrideResolvedSubsteps = await this.observedSubstepsForFrame(
          args.runbookId,
          requestedFrame.frameKey,
        );
        const unresolved = currentStep.substeps.filter(
          (substep) => !overrideResolvedSubsteps.has(substep.id),
        ).length;
        return {
          status: 'not_active',
          frameKey: requestedFrame.frameKey,
          activeFrameKey,
          unresolved,
          applied: [],
        };
      }

      const entry = state.activeEntry ?? ensured.entry;
      const activeTargetFrame = activeFrame(activeFrameKey, entry);
      const resolved = await this.lifecycleService.listResolvedCompletions(
        args.runbookId,
        activeTargetFrame,
      );
      const resolvedBySubstep = new Map(
        resolved
          .filter(({ completion }) => completion.targetSubstep !== undefined)
          .map(({ completion }) => [completion.targetSubstep, completion]),
      );
      const unresolved = currentStep.substeps.filter(
        (substep) => !resolvedBySubstep.has(substep.id),
      ).length;
      const currentKey = buildCompletionKey(activeTargetFrame, state.substep);
      const current =
        resolved.find(({ key }) => key === currentKey) ??
        resolved.find(
          ({ key, completion }) =>
            key === buildCompletionKey(inactiveFrame(activeFrameKey), state.substep) ||
            completion.targetSubstep === state.substep,
        );
      if (!current) {
        return { status: 'continue', state, unresolved, applied };
      }

      const validated = this.resolveAgainstCurrentCursor(state, current.completion, ensured);
      if (!(currentCursorValidatedBrand in validated)) return { ...validated, unresolved, applied };

      const result = await this.actorService.sendAndSync(
        args.runbookId,
        args.steps,
        {
          type: 'APPLY_CURRENT_RESOLVED_COMPLETION',
          completionKey: current.key,
          completion: validated,
        },
        // Only the DECISIVE write carries the guard, and that is the first apply:
        // it is the one that advances the parent past the point where a live
        // delegated child matters. Every apply here is its own transaction, so
        // re-arming the guard on a follow-on apply would let an unrelated child
        // claiming mid-drain abort it and strand the already-committed first apply
        // behind a bare refusal. This mirrors the recorded path, where the drain
        // that follows a committed decisive write runs unguarded for the same
        // reason (see LifecycleCommandService#driveSubstep).
        {
          ...guardOptions(applied.length === 0 ? args.guard : undefined),
          ...(args.issueDelegationCredential === undefined
            ? {}
            : { runtime: { issueDelegationCredential: args.issueDelegationCredential } }),
        },
      );
      if (!result) {
        return { status: 'continue', state, unresolved, applied };
      }
      applied.push({
        key: current.key,
        completion: validated,
        stateBefore: state,
        stateAfter: result.state,
        snapshot: result.snapshot,
      });
      const terminal = terminalStatus(result);
      if (terminal) return { status: terminal, unresolved: 0, applied };
      if (args.maxApplied !== undefined && applied.length >= args.maxApplied) {
        const remaining = await this.countUnresolvedForState(
          args.runbookId,
          args.steps,
          result.state,
        );
        return { status: 'continue', state: result.state, unresolved: remaining, applied };
      }
      state = result.state;
    }
  }
}
