import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import { Errors } from '../errors/factory.js';
import type { RunbookActorService } from './actor-service.js';
import type { DelegationCredentialIssuer } from './delegation-credential.js';
import { merge } from './state-update-ops.js';
import {
  applyRunbookStateUpdate,
  type RunbookStateManager,
  type RunbookStateUpdate,
} from './state.js';
import { findStepOrThrow } from './execution-units.js';
import { deriveActiveCompletionFrame } from './frame-entry.js';
import {
  activeFrame,
  buildCompletionKey,
  buildResolvedCompletion,
  completionEntryForFrame,
  completionTargetsFrame,
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
import type { ReleaseRole } from './session-release.js';
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

/**
 * Operator-facing code for a completion that is not for the active cursor.
 *
 * Names the CONDITION rather than the command that hit it (#802), following
 * RD-821's precedent on the shared re-entry seam: the inline parent-advance
 * seam and the execution loop reach the identical refusal by different routes
 * and must report it identically. It is permanent — re-running cannot make a
 * stale completion match a cursor that has moved — so it must never arrive
 * wearing RD-999 `UNKNOWN_ERROR`, whose envelope says nothing was diagnosed and
 * whose only implied remedy is a retry.
 *
 * `rundown collect` deliberately keeps its own `COLLECT_OPERATION_FAILED` for
 * the same reason (`command-policy.ts`): that surface reports the collection
 * that failed, not the cursor fact underneath it.
 */
export const COMPLETION_TARGET_MISMATCH_CODE = 'COMPLETION_TARGET_MISMATCH';

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
export interface ApplyNextResolvedCompletionArgs {
  /** Run id of the runbook whose next completion is applied. */
  readonly runbookId: RunId;
  /** Resolved step definitions for the runbook (used for substep ordering). */
  readonly steps: readonly ResolvedStep[];
  /**
   * Optional override frame — when supplied and not equal to the active frame,
   * the apply short-circuits to `not_active` without dispatching any event.
   */
  readonly frameOverride?: Frame;
  /** Verified runtime-only issuer for a completion transition that enters delegation. */
  readonly issueDelegationCredential?: DelegationCredentialIssuer;
  /**
   * Run Release folded into this apply's own transaction, fired only when the
   * PREPARED state reaches terminal.
   *
   * Present when the caller owns the release for this run, absent when another
   * seam does — the inline parent-advance seam owns the single release for a
   * parent it drives, and a release here as well would take it behind that
   * owner. An armed release is inert on every non-terminal apply, so a drain
   * arms it once and lets the transaction decide.
   *
   * The role, and NOT the trigger: whether this apply reaches terminal is
   * decided by the transition prepared inside the transaction, long after this
   * argument is built. Folding the trigger in here would let a caller assert a
   * terminality it cannot yet know.
   */
  readonly terminalRelease?: { readonly role: ReleaseRole };
}

/**
 * Outcome of one {@link RunbookCompletionService.applyNextResolvedCompletion}.
 *
 * `terminal` rides on the `applied` arm rather than replacing it: a transition
 * that ends the run is still an apply the caller must observe and emit for, and
 * splitting it out would make every caller unpack the same entry twice.
 *
 * Every non-applied arm carries the state it decided against, so a looping
 * caller that stops has the version that stopped it without a further read.
 */
export type ApplyNextResolvedCompletionResult =
  | {
      /** A completion was selected, applied, and committed. */
      readonly kind: 'applied';
      /** The applied completion, with the states either side of it. */
      readonly entry: AppliedResolvedCompletion;
      /** Count of substeps still without a persisted completion. */
      readonly unresolved: number;
      /** Set when the applied transition carried the run terminal. */
      readonly terminal?: 'done' | 'stopped';
    }
  | {
      /** No completion is applicable at the current cursor. */
      readonly kind: 'none';
      /** The state the decision was made against. */
      readonly state: RunbookState;
      /** Count of substeps still without a persisted completion. */
      readonly unresolved: number;
    }
  | {
      /** Requested frame is not the active one; the call is observation-only. */
      readonly kind: 'not_active';
      /** The state the decision was made against. */
      readonly state: RunbookState;
      /** Frame key that was requested via `frameOverride`. */
      readonly frameKey: FrameKey;
      /** Frame key the machine is actually positioned on. */
      readonly activeFrameKey: FrameKey;
      /** Count of substeps still without a persisted completion. */
      readonly unresolved: number;
    }
  | {
      /** The applicable row does not target the committed cursor. */
      readonly kind: 'mismatch';
      /** The state the decision was made against. */
      readonly state: RunbookState;
      /** The refusal, carrying the offending row. */
      readonly mismatch: CompletionTargetMismatch;
      /** Count of substeps still without a persisted completion. */
      readonly unresolved: number;
    }
  | {
      /** The run does not exist, so there is nothing to apply against. */
      readonly kind: 'missing';
    };

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

/**
 * Map a state's lifecycle to the terminal status that reports it, if terminal.
 *
 * The single lifecycle→status mapping, shared by the single-apply primitive and
 * the prepared pass, so a run reaching terminal is named identically whether it
 * was committed one apply at a time or derived whole for one commit.
 *
 * @param state - State whose lifecycle is classified.
 * @returns `'done'`/`'stopped'` for a terminal lifecycle, otherwise `undefined`.
 */
function terminalLifecycleStatus(state: RunbookState): 'done' | 'stopped' | undefined {
  if (state.lifecycle === 'completed') return 'done';
  if (state.lifecycle === 'stopped') return 'stopped';
  return undefined;
}

/**
 * Verdict on whether one applied completion advanced the pass.
 *
 * Every caller that drains a frame loops until nothing more applies, and that
 * loop terminates only because each apply changes what the NEXT selection picks.
 * Nothing else observes it: an apply that changed neither the candidate set nor
 * the cursor leaves the caller re-selecting the same row from the same position
 * forever — a hang, not a failure. These classifications make the missing
 * post-condition explicit so a violation fails fast on the FIRST non-advancing
 * apply, before it commits.
 */
type ResolvedCompletionDrainProgress =
  | { readonly kind: 'progressed' }
  | { readonly kind: 'stalled'; readonly reason: string };

/**
 * The coordinates a drain iteration's selection is computed from.
 *
 * Selection is `listResolvedCompletionsInState(state,
 * deriveActiveCompletionFrame(state))` narrowed to `state.substep` on
 * `state.step`. Holding all four fixed
 * fixes the candidate row, which is why an apply that moves ANY of them has
 * made progress even if it consumed nothing.
 */
interface DrainSelectionCursor {
  /** Step the drain is positioned on. */
  readonly step: string;
  /** Substep the candidate row must target. */
  readonly substep: string | undefined;
  /** Frame key the candidate row's key must be prefixed with. */
  readonly frameKey: FrameKey | undefined;
  /** Frame entry the candidate row's key must be prefixed with. */
  readonly entry: number | undefined;
}

/**
 * Read the selection coordinates out of a drain state.
 *
 * @param state - State whose cursor is read.
 * @returns The four coordinates the next selection depends on.
 */
function drainSelectionCursor(state: RunbookState): DrainSelectionCursor {
  return {
    step: state.step,
    substep: state.substep,
    frameKey: state.activeFrameKey,
    entry: state.activeEntry,
  };
}

/**
 * Classify whether one apply moved the drain forward.
 *
 * The post-condition BOTH drains share, and deliberately a DISJUNCTION rather
 * than the actor's consume patch: consuming the applied row removes it from the
 * candidate set, and moving the cursor changes which rows are candidates at all.
 * Either alone is progress. Only when NEITHER holds is the next iteration
 * guaranteed to re-select the same row from the same position — the spin.
 *
 * Asserting the consume alone would be asserting a neighbouring module's
 * implementation detail instead of this loop's termination requirement, and
 * would refuse honest transitions that advance the cursor by other means.
 *
 * @param runbookId - Run whose drain is being classified (named in the reason).
 * @param key - Completion key handed to the apply.
 * @param before - State the apply was derived from.
 * @param after - State produced by the apply.
 * @returns `progressed` when the row was consumed or the cursor moved,
 *   otherwise a `stalled` reason.
 */
function classifyDrainApplyProgress(
  runbookId: RunId,
  key: string,
  before: RunbookState,
  after: RunbookState,
): ResolvedCompletionDrainProgress {
  if (!Object.hasOwn(after.resolvedCompletions ?? {}, key)) return { kind: 'progressed' };
  const from = drainSelectionCursor(before);
  const to = drainSelectionCursor(after);
  const moved =
    from.step !== to.step ||
    from.substep !== to.substep ||
    from.frameKey !== to.frameKey ||
    from.entry !== to.entry;
  if (moved) return { kind: 'progressed' };
  return {
    kind: 'stalled',
    reason:
      `Resolved-completion drain for runbook "${runbookId}" applied completion "${key}" without ` +
      `consuming it or moving the cursor off ${from.step}.${from.substep ?? '(none)'} ` +
      `(frame ${from.frameKey ?? '(none)'} entry ${String(from.entry ?? '(none)')}). The next ` +
      `iteration would re-select the same row from the same position, so the drain is refused ` +
      `rather than looped.`,
  };
}

/**
 * Classify progress for a CHAINED (prepared) drain iteration.
 *
 * The prepared drain selects only from the state it chains forward, so it can
 * additionally require that an apply never INTRODUCES a row. Without that, a
 * transition that consumed its key and added another would satisfy
 * {@link classifyDrainApplyProgress} on every pass while the candidate set never
 * shrank, and the loop would still not terminate.
 *
 * The persisted twin cannot carry this half: it re-selects from the store, where
 * a concurrent writer may legitimately add a row mid-drain, so it checks
 * {@link classifyDrainApplyProgress} alone.
 *
 * @param runbookId - Run whose drain is being classified (named in the reason).
 * @param key - Completion key handed to the apply.
 * @param before - State the apply was derived from.
 * @param after - State produced by the apply.
 * @returns `progressed` when the chained candidate set did not grow and the
 *   apply advanced, otherwise a `stalled` reason.
 */
function classifyChainedDrainProgress(
  runbookId: RunId,
  key: string,
  before: RunbookState,
  after: RunbookState,
): ResolvedCompletionDrainProgress {
  const previousKeys = new Set(Object.keys(before.resolvedCompletions ?? {}));
  const introduced = Object.keys(after.resolvedCompletions ?? {}).filter(
    (candidate) => !previousKeys.has(candidate),
  );
  if (introduced.length > 0) {
    return {
      kind: 'stalled',
      reason:
        `Resolved-completion drain for runbook "${runbookId}" applied completion "${key}" and ` +
        `introduced ${String(introduced.length)} new row(s) (${introduced.join(', ')}). A prepared ` +
        `apply may only consume rows from the state it chains forward; a candidate set that never ` +
        `shrinks leaves the pass unable to terminate, so the drain is refused rather than looped.`,
    };
  }
  return classifyDrainApplyProgress(runbookId, key, before, after);
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
 * The sole existing-row lookup behind the manual-completion decision, for both
 * the recorder and its fenced twin — the recorder's separate loading lookup is
 * gone, because its classification now runs inside the commit against the state
 * the compare-and-swap captured.
 *
 * Deliberately entry-PRECISE for a frame that carries an entry. Completion keys
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
 * The only reader of this map on the apply path. It was the in-state twin of a
 * store-loading sibling on `ExecutionLifecycleService`, which existed to serve a
 * drain that re-read per iteration; both paths now classify against a state they
 * already hold, so the twin outlived its counterpart.
 *
 * An `active` frame also admits the sentinel entry; an exact frame does not.
 * That rule is {@link completionTargetsFrame}, shared with the collection-pending
 * guard so the two cannot disagree about which rows this drain can reach (#749).
 * It reads the row's own frame coordinates rather than its key prefix; the two
 * are the same fact, written together from one `Frame` at every recording site.
 *
 * @param state - State whose `resolvedCompletions` map is read.
 * @param frame - Frame target to list.
 * @returns Key/completion pairs matching the frame target.
 */
function listResolvedCompletionsInState(
  state: RunbookState,
  frame: Frame,
): ReadonlyArray<{ readonly key: string; readonly completion: ResolvedCompletion }> {
  return Object.entries(state.resolvedCompletions ?? {})
    .filter(([, completion]) => completionTargetsFrame(frame, completion))
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

/**
 * Narrow a {@link ResolvedCompletion} to the current cursor, rejecting any
 * row whose target step/substep/frame does not match.
 *
 * On a match the returned value is normalised against the live cursor:
 * `targetSubstep` is set to `state.substep`, and `targetEntry` is rewritten
 * from the sentinel entry (or any persisted entry) to the live active entry so
 * downstream consumers always see the resolved entry rather than the sentinel.
 *
 * The live frame is derived here rather than supplied: a caller-passed entry is
 * stale by construction against the state it is validated with, and the two
 * disagreeing is the shape of defect this narrowing exists to catch.
 *
 * @param state - Current runbook state.
 * @param completion - Resolved completion candidate.
 * @returns A branded {@link CurrentCursorResolvedCompletion} on match, or a
 *   {@link CompletionTargetMismatch} describing the rejection.
 */
function resolveAgainstCurrentCursor(
  state: RunbookState,
  completion: ResolvedCompletion,
): CurrentCursorResolvedCompletion | CompletionTargetMismatch {
  if (!state.substep) {
    return {
      status: 'failed',
      reason: 'target_mismatch',
      message: 'Resolved completion cannot apply because the current cursor has no substep.',
      completion,
    };
  }
  const frame = deriveActiveCompletionFrame(state);
  const activeEntry = completionEntryForFrame(frame);
  const mismatch =
    completion.targetStep !== state.step ||
    completion.targetSubstep !== state.substep ||
    // Same frame/entry rule the selection listed by, and the one the
    // collection-pending guard blocks on (#749).
    !completionTargetsFrame(frame, completion);
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
 * The decision behind one resolved-completion apply.
 *
 * Every arm carries `unresolved` because the count is a by-product of the same
 * substep walk the selection already performs: deriving it here costs nothing,
 * while asking a caller for it would mean a second read of the same rows.
 *
 * The `apply` arm carries a branded {@link CurrentCursorResolvedCompletion}, so
 * a selection that succeeded is proof the row matches the cursor it was selected
 * against — there is no arm in which a caller holds a completion it still has to
 * validate.
 */
type ResolvedCompletionApplySelection =
  | {
      readonly kind: 'apply';
      /** Canonical key of the row to apply. */
      readonly key: string;
      /** The row, narrowed and normalised against the cursor it was selected on. */
      readonly completion: CurrentCursorResolvedCompletion;
      readonly unresolved: number;
    }
  | { readonly kind: 'none'; readonly unresolved: number }
  | {
      readonly kind: 'not_active';
      /** Frame the caller asked about. */
      readonly frameKey: FrameKey;
      /** Frame the cursor is actually on. */
      readonly activeFrameKey: FrameKey;
      readonly unresolved: number;
    }
  | {
      readonly kind: 'mismatch';
      /** The refusal, carrying the offending row. */
      readonly mismatch: CompletionTargetMismatch;
      readonly unresolved: number;
    };

/**
 * Select the next resolved completion to apply against one exact state.
 *
 * The single decision owner behind both apply paths — the persisted
 * {@link RunbookCompletionService.applyNextResolvedCompletion} and the prepared
 * {@link RunbookCompletionService.prepareResolvedCompletionDrain}. It is pure
 * and reads only `state`, which is what lets the persisted path run it INSIDE
 * its compare-and-swap: the row it picks and the cursor it validates against are
 * then the exact version the write commits onto.
 *
 * That placement is the whole point. While the selection ran against a
 * separately-captured state, a cursor that moved between capture and write left
 * the apply deriving from one version and landing on another — applying a row
 * for the substep the capture named to whatever substep the machine had since
 * advanced to.
 *
 * A frame override that does not name the active frame reports `not_active`
 * without selecting: the caller asked about a frame the cursor is not on, so
 * there is nothing here to apply. Callers that have already applied within a
 * pass own the decision about what a LATER divergence means; this function has
 * no memory of a pass.
 *
 * @param state - The exact state to select against.
 * @param steps - Resolved steps, for substep ordering and the unresolved count.
 * @param frameOverride - Optional frame the caller is scoped to.
 * @returns The apply decision, every arm carrying the unresolved substep count.
 * @throws {Error} If the step named by the cursor is missing from `steps`.
 */
function selectNextResolvedCompletionApply(
  state: RunbookState,
  steps: readonly ResolvedStep[],
  frameOverride?: Frame,
): ResolvedCompletionApplySelection {
  const currentStep = findStepOrThrow(steps, state.step, state.id);
  if (!resolvedStepHasSubsteps(currentStep) || !state.substep) {
    return { kind: 'none', unresolved: 0 };
  }
  const activeFrameKey = state.activeFrameKey ?? deriveActiveFrame(state).frameKey;
  if (frameOverride && frameOverride.frameKey !== activeFrameKey) {
    const overrideResolved = observedSubstepsForFrameInState(state, frameOverride.frameKey);
    return {
      kind: 'not_active',
      frameKey: frameOverride.frameKey,
      activeFrameKey,
      unresolved: currentStep.substeps.filter((substep) => !overrideResolved.has(substep.id))
        .length,
    };
  }

  const activeTargetFrame = deriveActiveCompletionFrame(state);
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
  if (!current) return { kind: 'none', unresolved };

  const validated = resolveAgainstCurrentCursor(state, current.completion);
  if (!(currentCursorValidatedBrand in validated)) {
    return { kind: 'mismatch', mismatch: validated, unresolved };
  }
  return { kind: 'apply', key: current.key, completion: validated, unresolved };
}

/**
 * State the manual-completion decision reads, supplied by each caller.
 *
 * Substep states are read off `cursorState` rather than carried separately.
 * They were a distinct field while the recorder classified against the freshest
 * load and could fall back to a caller-supplied state for one and not the
 * other; both now come from one captured version, so a second field could only
 * ever disagree with it.
 */
interface ManualCompletionEvidence {
  /** State whose cursor decides whether the target is the live one, and whose substep states are searched for a prior `done` resolution. */
  readonly cursorState: RunbookState;
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
      evidence.cursorState.substepStates ?? [],
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
 * Read the manual-completion decision's evidence out of one captured state.
 *
 * Every field {@link classifyManualCompletionTarget} weighs comes from the same
 * snapshot, which is what makes the decision consistent with the write that
 * lands on it. The store's compare-and-swap supplies that snapshot to the
 * recorder; the fenced twin supplies the state captured under its lease.
 *
 * @param args - Manual completion target and result.
 * @param state - The single state all evidence is read from.
 * @returns Cursor state, substep states, and any existing completion key.
 */
function manualCompletionEvidence(
  args: RecordManualCompletionArgs,
  state: RunbookState,
): ManualCompletionEvidence {
  return {
    cursorState: state,
    existingKey: findCompletionKeyInState(state, args.targetFrame, args.targetSubstep),
  };
}

/**
 * The patch recording one manual completion and mirroring its substep state.
 *
 * The two writes are one patch on purpose. Splitting them opens a window in
 * which a concurrent reader observes a resolved row without its matching `done`
 * substep state, and a concurrent delete between them flips the missing-parent
 * behaviour.
 *
 * @param args - Manual completion target and result.
 * @param substepStates - Substep states from the state the patch will apply to.
 * @param decision - The recorded decision carrying the key and completion.
 * @param decision.key - Canonical completion key the row is written under.
 * @param decision.completion - The resolved completion to persist.
 * @returns The tagged state patch.
 */
function manualCompletionUpdates(
  args: RecordManualCompletionArgs,
  substepStates: readonly SubstepState[],
  decision: { readonly key: string; readonly completion: ResolvedCompletion },
): RunbookStateUpdate {
  return {
    resolvedCompletions: merge({ [decision.key]: decision.completion }),
    substepStates: upsertSubstepState(
      substepStates,
      args.targetSubstep,
      args.targetFrame.frameKey,
      {
        status: 'done',
        result: args.result,
      },
    ),
  };
}

/** The single decision behind recording or preparing a delegated child report. */
type ChildCompletionDecision =
  | { readonly status: 'not-applicable' | 'blocked' | 'cancelled' | 'duplicate' }
  | {
      readonly status: 'recorded';
      readonly key: string;
      readonly updates: RunbookStateUpdate;
    };

/**
 * Decide what a delegated child's terminal report does to its parent.
 *
 * The sole owner of the child-report rule, shared by the recorder and the pure
 * preparation so the two can never disagree — the same relationship
 * {@link classifyManualCompletionTarget} holds for manual completions. Evidence
 * is one captured parent state: the recorder passes the state its
 * compare-and-swap read, the fenced twin passes the state captured under its
 * lease.
 *
 * The duplicate rule here is frame-WIDE, unlike the entry-precise manual
 * lookup: a delegated child reports against the linkage it was issued under, so
 * any recorded outcome for this parent substep — whatever entry it carries —
 * already answers this report. That is strictly broader than the manual rule,
 * so a report this classifier admits is never one the manual classifier would
 * have rejected.
 *
 * @param args - Terminal child report input.
 * @param parentState - Exact captured delegating parent state.
 * @returns The no-write verdict, or the key and patch to persist.
 */
function classifyChildCompletionTarget(
  args: RecordChildCompletionArgs,
  parentState: RunbookState,
): ChildCompletionDecision {
  if (!args.childState.parentLinkage) return { status: 'not-applicable' };
  const linkage = assertCompleteParentLinkage(args.childState);
  if (parentState.id !== linkage.parentRunId) return { status: 'not-applicable' };
  const projection = projectDelegationTerminalOutcome(args.childState, args.result);
  if (projection.kind === 'not_terminal') return { status: 'not-applicable' };
  if (projection.kind === 'command_infrastructure') return { status: 'blocked' };

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
    return { status: 'not-applicable' };
  }
  if (
    linkage.kind === 'delegation' &&
    substepState?.delegation?.cancelledAt &&
    !args.ignoreCancellation
  ) {
    return { status: 'cancelled' };
  }

  const targetFrame =
    linkage.parentFrameKey === activeParentFrameKey && linkage.parentEntry === activeParentEntry
      ? activeFrame(linkage.parentFrameKey, activeParentEntry)
      : exactFrame(linkage.parentFrameKey, linkage.parentEntry);
  const key = buildCompletionKey(targetFrame, linkage.parentStepId);
  if (isDuplicateChildCompletion(parentState, targetFrame, linkage.parentStepId)) {
    return { status: 'duplicate' };
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
  return {
    status: 'recorded',
    key,
    updates: {
      resolvedCompletions: merge({ [key]: completion }),
      substepStates: upsertSubstepState(
        parentState.substepStates ?? [],
        linkage.parentStepId,
        linkage.parentFrameKey,
        { status: 'done', result: projection.result },
      ),
    },
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
   * @param actorService - DI-aware actor service used to apply validated completions
   */
  constructor(
    private readonly manager: RunbookStateManager,
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
    const decision = classifyChildCompletionTarget(args, parentState);
    if (decision.status !== 'recorded') return { kind: decision.status };
    return {
      kind: 'recorded',
      key: decision.key,
      nextParentState: applyRunbookStateUpdate(
        parentState,
        decision.updates,
        args.completedAt ?? new Date().toISOString(),
      ),
    };
  }

  /**
   * Prepare one manual completion against an exact captured state without IO.
   *
   * @param args - Manual completion target and result.
   * @returns Duplicate/recorded status plus the prepared parent state.
   */
  prepareManualCompletion(args: RecordManualCompletionArgs): PreparedManualCompletion {
    const decision = classifyManualCompletionTarget(
      args,
      manualCompletionEvidence(args, args.currentState),
    );
    if (decision.status === 'duplicate') {
      return { status: 'duplicate', key: decision.key, nextState: args.currentState };
    }
    const nextState = applyRunbookStateUpdate(
      args.currentState,
      manualCompletionUpdates(args, args.currentState.substepStates ?? [], decision),
      args.completedAt ?? new Date().toISOString(),
    );
    return { status: 'recorded', key: decision.key, nextState };
  }

  /**
   * Validate a completion against the live in-memory cursor.
   *
   * The frame and entry are read from `state`, never supplied: a caller that
   * passes its own is asserting a cursor the state may already have moved off.
   *
   * @param state - Current prepared state.
   * @param completion - Completion candidate.
   * @returns Branded current-cursor completion or mismatch.
   */
  validateCurrentCompletion(
    state: RunbookState,
    completion: ResolvedCompletion,
  ): CurrentCursorResolvedCompletion | CompletionTargetMismatch {
    return resolveAgainstCurrentCursor(state, completion);
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
   * The whole read-derive-write span — parent load, token-hash fence,
   * cancellation check, frame selection, duplicate check, write — is one
   * compare-and-swap cycle against a single captured parent state. That
   * replaced the retired parent delegation file lock, and it removes the
   * delegation-then-completion lock ordering edge outright rather than
   * documenting it: this path used to record through the manual completion
   * recorder, which took the run's completion file lock while the parent's
   * delegation lock was still held. It now commits its own patch from
   * {@link classifyChildCompletionTarget}, the same decision owner the fenced
   * {@link prepareChildCompletion} uses, so the two can never disagree — and
   * the nested acquisition has no site left to occur at. The manual recorder
   * itself has since been deleted, its callers having moved to the fenced seam.
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
   *   result), or the parent run is gone, so there is nothing to report.
   */
  async recordChildCompletion(
    args: RecordChildCompletionArgs,
  ): Promise<'recorded' | 'duplicate' | 'not-applicable' | 'cancelled' | 'blocked'> {
    const linkage = args.childState.parentLinkage;
    if (!linkage) return 'not-applicable';
    assertCompleteParentLinkage(args.childState);

    const { value } = await this.manager.updateWithStateReturning<
      ChildCompletionDecision['status']
    >(linkage.parentRunId, (parentState) => {
      const decision = classifyChildCompletionTarget(args, parentState);
      return decision.status === 'recorded'
        ? { updates: decision.updates, value: decision.status }
        : { updates: null, value: decision.status };
    });
    // A `null` value means the callback never ran because the parent is gone —
    // there is no run to report against, which is not-applicable, not an error.
    return value ?? 'not-applicable';
  }

  /**
   * Derive a whole resolved-completion drain against one captured state,
   * without persisting anything.
   *
   * The fenced twin of
   * {@link RunbookCompletionService.applyNextResolvedCompletion}, and the seam
   * that makes a whole pass committable in ONE transaction. Both derive their
   * decision from {@link selectNextResolvedCompletionApply}; they differ only in
   * what they do with it. This one chains each prepared state into the next
   * selection and persists nothing, so its caller can commit the entire pass
   * against the version it captured under a lease. The persisted twin commits
   * each apply on its own compare-and-swap and re-reads for the next one.
   *
   * Two substitutions turn the persisted pass into a pure one:
   *
   * - The active-entry projection is gone entirely: the machine is the single
   *   writer of frame entry (#680), so the frame coordinate is read off the
   *   captured state (`activeFrameKey` / `activeEntry`, falling back to
   *   {@link deriveActiveFrame}) rather than projected and persisted here.
   * - The commit becomes {@link RunbookActorService.prepareActorMutation}, whose
   *   `nextState` already folds in the consumed-completion patch and feeds the
   *   next iteration.
   *
   * It accepts no parent-advance guard: its sole caller,
   * `collectDelegationOutcomes`, passes none, and an aggregate guard belongs on
   * the commit rather than on an individual derivation.
   *
   * @param args - Captured state, steps, and optional frame override.
   * @returns The prepared pass: every arm carries the state the commit must persist.
   * @throws {Error} If a step named by the cursor is missing from `steps`, or if
   *   {@link RunbookActorService.prepareActorMutation} rejects the derived
   *   snapshot (invalid shape, actor error state).
   * @throws {RundownError} RD-821 if an apply neither advances the cursor nor
   *   shrinks the chained candidate set (see
   *   {@link classifyChainedDrainProgress}). The pass has written nothing, so
   *   refusing costs no committed prefix — and looping instead would hang while
   *   `applied` grew without bound.
   */
  async prepareResolvedCompletionDrain(
    args: PrepareResolvedCompletionDrainArgs,
  ): Promise<PreparedResolvedCompletionDrain> {
    let state = args.capturedState;
    const applied: AppliedResolvedCompletion[] = [];
    for (;;) {
      const selection = selectNextResolvedCompletionApply(state, args.steps, args.frameOverride);
      if (selection.kind === 'not_active') {
        // The persisted path has no equivalent of this branch, because it never
        // carries a pass across calls. Here an INITIAL divergence is
        // observation-only and reports `not_active`, while a divergence AFTER
        // work means an apply advanced the cursor out of the override frame — the
        // derived entries must be kept so the caller can still observe them.
        if (applied.length > 0) {
          return { status: 'continue', state, unresolved: 0, applied };
        }
        return {
          status: 'not_active',
          state,
          frameKey: selection.frameKey,
          activeFrameKey: selection.activeFrameKey,
          unresolved: selection.unresolved,
          applied: [],
        };
      }
      if (selection.kind === 'none') {
        return { status: 'continue', state, unresolved: selection.unresolved, applied };
      }
      if (selection.kind === 'mismatch') {
        return { ...selection.mismatch, state, unresolved: selection.unresolved, applied };
      }

      const mutation = await this.actorService.prepareActorMutation(
        args.runbookId,
        state,
        args.steps,
        {
          type: 'APPLY_CURRENT_RESOLVED_COMPLETION',
          completionKey: selection.key,
          completion: selection.completion,
        },
        args.issueDelegationCredential === undefined
          ? undefined
          : { issueDelegationCredential: args.issueDelegationCredential },
      );
      // Nothing above this line observes that the apply changed what the next
      // iteration selects. In production that comes from `prepareActorMutation`'s
      // consumed-completion patch, in another module; assert the post-condition
      // here so a violation fails on the FIRST apply instead of spinning the loop
      // and growing `applied` without bound.
      const progress = classifyChainedDrainProgress(
        args.runbookId,
        selection.key,
        state,
        mutation.nextState,
      );
      if (progress.kind === 'stalled') throw Errors.delegationInvariantViolated(progress.reason);
      applied.push({
        key: selection.key,
        completion: selection.completion,
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
   * Apply the next resolved completion for the active frame, atomically.
   *
   * ONE apply per call, and the unit this module is built around. Selection,
   * cursor validation, the actor transition, and the commit all happen inside a
   * single {@link RunbookStateManager.mutateStateReturning} cycle, so the row it
   * applies is chosen against the exact version the write commits onto. An
   * attempt that loses the compare-and-swap re-derives from the committed state
   * rather than replaying a decision made against a version that has moved.
   *
   * That fold is what retired the run's completion file lock here. The lock's job
   * was to keep another writer out of the gap between the selection and the write
   * that depended on it; running the selection inside the cycle closes the gap by
   * construction instead of by exclusion. What the lock never prevented, and this
   * does, is the stale derivation itself: the compare-and-swap always stopped a
   * lost update, but the old drain selected against a caller-supplied state and
   * let `sendAndSync` re-load a different one, so an apply could consume the row
   * for the substep the caller captured while landing its PASS on the substep the
   * machine had since advanced to.
   *
   * `currentState` is deliberately absent from the arguments. A caller-supplied
   * state is stale by construction at this seam, and accepting one could only
   * reintroduce the disagreement this method exists to remove.
   *
   * **Callers own the loop.** Draining a frame to exhaustion means calling this
   * until it stops reporting `applied` — the CLI's job, because it must observe
   * and emit each transition before the next apply (a Category A concern).
   * Nothing here batches, and there is no `maxApplied`.
   *
   * @remarks
   * The build callback re-runs per attempt, as {@link RunbookStore.mutateState}
   * requires. It reaches {@link RunbookActorService.prepareActorMutation}, whose
   * machine-invoked actors are effect-free for this event with ONE exception:
   * entering a step that declares producer ARTIFACTS resolves them, creating a
   * parent directory and appending a manifest row. Both are idempotent by
   * identity — `appendArtifactManifestRecord` collapses an equivalent row rather
   * than duplicating it — and the machine already re-runs that resolution on
   * RETRY re-entry, so a repeated attempt adds nothing a legitimate retry would
   * not. Command execution and output capture are NOT reachable: those states are
   * entered only by `EXECUTE_COMMAND` and `COMMAND_RESULT`, and an apply raises
   * neither.
   *
   * @param args - Run, steps, and the optional frame the caller is scoped to.
   * @returns The apply outcome. `applied` carries the entry, the unresolved
   *   count, and a `terminal` status when the transition ended the run; `none`,
   *   `not_active` and `mismatch` each report why nothing was applied; `missing`
   *   means the run is gone.
   * @throws {Error} If the step named by the cursor is missing from `steps`, or
   *   if {@link RunbookActorService.prepareActorMutation} rejects the derived
   *   snapshot (invalid state, actor error state).
   * @throws {ConcurrentStateModificationError} When sustained contention spends
   *   the store's optimistic retry budget.
   * @throws {RundownError} RD-821 if the applied transition neither consumes the
   *   row it was handed nor moves the cursor. A caller looping on this method
   *   would otherwise re-select the same row from the same position forever, so
   *   the apply is refused before it commits rather than looped.
   * @throws {Error} When `terminalRelease` is armed and the prepared state names
   *   a run other than `args.runbookId`. The transaction owns one run, so that
   *   is the only one it may release, and the store refuses before projecting;
   *   the throw rolls the whole apply back.
   * @throws {InvalidPersistedClaimError} When `terminalRelease` is armed, the
   *   apply reaches terminal, and any active claim row in the session is
   *   inconsistent — the release reads the session inside the transaction, so an
   *   unrelated corrupt row rolls this apply back rather than letting it commit
   *   terminal beside a session write that failed. That is the atomicity this
   *   fold exists for, and the recovery is the sanctioned one: fix or prune the
   *   corrupt claim. A non-terminal apply reads no session and cannot raise it.
   */
  async applyNextResolvedCompletion(
    args: ApplyNextResolvedCompletionArgs,
  ): Promise<ApplyNextResolvedCompletionResult> {
    const terminalRelease = args.terminalRelease;
    const { value } = await this.manager.mutateStateReturning<ApplyNextResolvedCompletionResult>(
      args.runbookId,
      async (current) => {
        const selection = selectNextResolvedCompletionApply(
          current,
          args.steps,
          args.frameOverride,
        );
        switch (selection.kind) {
          case 'none':
            return {
              next: null,
              value: { kind: 'none', state: current, unresolved: selection.unresolved },
            };
          case 'not_active':
            return {
              next: null,
              value: {
                kind: 'not_active',
                state: current,
                frameKey: selection.frameKey,
                activeFrameKey: selection.activeFrameKey,
                unresolved: selection.unresolved,
              },
            };
          case 'mismatch':
            return {
              next: null,
              value: {
                kind: 'mismatch',
                state: current,
                mismatch: selection.mismatch,
                unresolved: selection.unresolved,
              },
            };
          case 'apply': {
            const mutation = await this.actorService.prepareActorMutation(
              args.runbookId,
              current,
              args.steps,
              {
                type: 'APPLY_CURRENT_RESOLVED_COMPLETION',
                completionKey: selection.key,
                completion: selection.completion,
              },
              args.issueDelegationCredential === undefined
                ? undefined
                : { issueDelegationCredential: args.issueDelegationCredential },
            );
            // The post-condition a looping caller depends on. Nothing above
            // observes that the apply changed what the NEXT selection picks — in
            // production that comes from `prepareActorMutation`'s
            // consumed-completion patch, in another module — so assert it here,
            // before the commit, where refusing costs the caller nothing.
            const progress = classifyDrainApplyProgress(
              args.runbookId,
              selection.key,
              current,
              mutation.nextState,
            );
            if (progress.kind === 'stalled') {
              throw Errors.delegationInvariantViolated(progress.reason);
            }
            const terminal = terminalLifecycleStatus(mutation.nextState);
            return {
              // `mutateStateReturning` commits this verbatim, so the state the
              // entry reports is the state that was written.
              next: mutation.nextState,
              value: {
                kind: 'applied',
                // A terminal transition leaves nothing outstanding, whatever the
                // selection counted before it ran.
                unresolved: terminal === undefined ? selection.unresolved : 0,
                entry: {
                  key: selection.key,
                  completion: selection.completion,
                  stateBefore: current,
                  stateAfter: mutation.nextState,
                  snapshot: mutation.snapshot,
                },
                ...(terminal === undefined ? {} : { terminal }),
              },
            };
          }
        }
      },
      terminalRelease === undefined
        ? {}
        : {
            // Decided off the state this transaction is committing, never off
            // anything the caller supplied: the compare-and-swap re-derives
            // `next` per attempt, so terminality is only knowable here. A
            // non-terminal apply answers with no releases, which the store
            // treats as nothing to do rather than as an empty session write.
            releaseOnCommit: (next) =>
              terminalLifecycleStatus(next) === undefined
                ? []
                : [{ runId: next.id, role: terminalRelease.role }],
          },
    );

    // `value` is null exactly when the callback never ran, which happens only for
    // a missing run. A looping caller stops on it rather than throwing: a run
    // that is gone has nothing left to apply.
    return value ?? { kind: 'missing' };
  }
}
