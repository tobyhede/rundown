/**
 * Core seam for propagating a terminal child run's outcome to its parent.
 *
 * This module owns the DECISION and single-level upward-report orchestration for
 * both linkage kinds. Inline composition is synchronous: the seam invokes the
 * CLI-supplied {@link AdvanceInlineParent} callable to drain and advance the
 * composing parent (subprocess execution is Category A and stays in the CLI),
 * then — if that drives the parent terminal — releases it and recurses ONE level
 * up. Delegation is report-only: the seam records one outcome row and stops,
 * leaving the delegating run collection pending.
 *
 * The `advanceInlineParent` callable is a runtime function reference. It flows
 * through the CLI-side deps bag ({@link PropagateTerminalChildUpwardDeps}), never
 * through persisted context. See `docs/internal/xstate-patterns.md` § Persistence
 * and `docs/internal/architecture.md` § Actor input wiring.
 *
 * @module runbook/inline-parent-advance
 */

import { projectDelegationTerminalOutcome } from './completion-service.js';
import type { RunbookCompletionService } from './completion-service.js';
import type { ReleaseRunbookResult } from './session-service.js';
import type { FrameKey } from './targeting.js';
import type { RunId } from './run-id.js';
import type { DelegationOutcome, RunbookState } from './types.js';

/**
 * Input to the CLI-supplied inline parent-advance callable.
 *
 * Only data crosses this boundary. Runtime references the callable needs
 * (`cwd`, output emitter, command stream routing) are captured by the CLI
 * closure that BUILDS the callable, not passed here.
 */
export interface AdvanceInlineParentInput {
  /** The composing parent run to drain and advance. */
  readonly parentRunId: RunId;
  /** Parent frame key at link time, for frame-scoped drain targeting. */
  readonly parentFrameKey: FrameKey;
  /** Parent entry counter at link time, for frame-scoped drain targeting. */
  readonly parentEntry: number;
  /** Terminal result of the child driving this advance. */
  readonly result: DelegationOutcome;
}

/**
 * Collapsed outcome of one inline parent-advance.
 *
 * `stopped` / `done` mean the advance drove the parent to that terminal (the
 * seam then releases it and recurses one level). `active` means the parent is
 * still running or waiting on sibling substeps (no release, no recursion).
 */
export interface AdvanceInlineParentOutcome {
  readonly status: 'stopped' | 'done' | 'active';
}

/**
 * CLI-supplied Category-C callable that drains and advances an inline parent.
 *
 * The seam invokes this to run the parent's execution loop (subprocess spawn —
 * Category A). It performs NO terminal session release: release is owned by the
 * seam so it happens once (idempotent + PID-stale-reclaimable).
 *
 * @param input - Parent identity + terminal result. Data only.
 * @returns The collapsed advance status.
 */
export type AdvanceInlineParent = (
  input: AdvanceInlineParentInput,
) => Promise<AdvanceInlineParentOutcome>;

/**
 * Union of upward-propagation outcomes. Inline yields `handled` / `stopped` /
 * `blocked` / `not-applicable`; delegation yields `reported` / `duplicate` /
 * `blocked` / `not-applicable`.
 *
 * `reported` vs `duplicate` (RD-598 review finding 2): `reported` means the
 * delegation outcome was FRESHLY recorded this call (`recordChildCompletion`
 * returned `'recorded'`); `duplicate` means the ancestor already held the row, or
 * an ordinary cancel short-circuited, so nothing was freshly recorded
 * (`'duplicate'` / `'cancelled'`). This distinction is load-bearing for the
 * collect path's `reportedTerminalOutcome` (mutation-pinned to `'recorded'`-only
 * at `collection-service.test.ts:1429`). The CLI adapters collapse `duplicate`
 * back into their pre-existing `'reported'` (they never distinguished), so the
 * seven CLI call sites and both exit predicates are unaffected.
 */
export type TerminalUpwardPropagationResult =
  | 'handled'
  | 'stopped'
  | 'blocked'
  | 'reported'
  | 'duplicate'
  | 'not-applicable';

/** Narrow state reader used for reload-on-recursion. Satisfied by `RunbookStateManager`. */
export interface InlineParentAdvanceStateReader {
  /**
   * Load a run's persisted state by id, or `null` when it does not exist.
   *
   * @param id - Run id to load.
   * @returns The persisted state, or `null`.
   */
  load(id: string): Promise<RunbookState | null>;
}

/** Narrow session capability used for terminal release. Satisfied by `SessionService`. */
export interface InlineParentAdvanceSessionService {
  /**
   * Release a run from all session targeting structures on terminal.
   *
   * @param runbookId - Terminal run id to release.
   * @param options - Release options.
   * @param options.retainClaimsAsTerminal - Keep claim tombstones for later confirm/conflict.
   * @returns Structured release result (unused by the seam).
   */
  releaseRunbook(
    runbookId: RunId,
    options?: { readonly retainClaimsAsTerminal?: boolean },
  ): Promise<ReleaseRunbookResult>;
}

/**
 * Dependencies for {@link propagateTerminalChildUpward}.
 *
 * `manager` / `sessionService` / `completionService` are already-constructed
 * core services; `advanceInlineParent` is the CLI-supplied runtime callable
 * (Category C). None of these are persisted.
 */
export interface PropagateTerminalChildUpwardDeps {
  /** State reader for reload-on-recursion. */
  readonly manager: InlineParentAdvanceStateReader;
  /** Session service for uniform terminal release. */
  readonly sessionService: InlineParentAdvanceSessionService;
  /** Completion service for recording the child's outcome against its parent. */
  readonly completionService: Pick<RunbookCompletionService, 'recordChildCompletion'>;
  /** CLI-supplied inline parent-advance execution callable. */
  readonly advanceInlineParent: AdvanceInlineParent;
}

/**
 * Propagate a terminal child run's outcome to its parent, dispatching on linkage.
 *
 * Inline: record the child's outcome, then invoke {@link AdvanceInlineParent}. If
 * the parent reaches terminal (`stopped`/`done`), release it and recurse ONE
 * level up (single-level: inline chains advance synchronously; a delegation
 * boundary takes the report-only arm). Delegation: record report-only and stop.
 *
 * @param deps - Core services + the inline-advance callable.
 * @param childState - The terminal child run's state.
 * @param result - Explicit operator result, or `undefined` for lifecycle inference.
 * @returns The upward-propagation outcome.
 * @throws {Error} If the inline-advance callable rejects (e.g. drain failure).
 */
export async function propagateTerminalChildUpward(
  deps: PropagateTerminalChildUpwardDeps,
  childState: RunbookState,
  result: DelegationOutcome | undefined,
): Promise<TerminalUpwardPropagationResult> {
  const linkage = childState.parentLinkage;
  if (!linkage) return 'not-applicable';

  const projection = projectDelegationTerminalOutcome(childState, result);
  if (projection.kind === 'not_terminal') return 'not-applicable';
  if (projection.kind === 'command_infrastructure') return 'blocked';

  if (linkage.kind === 'delegation') {
    const recorded = await deps.completionService.recordChildCompletion({
      childState,
      result: projection.result,
    });
    if (recorded === 'blocked') return 'blocked';
    if (recorded === 'not-applicable') return 'not-applicable';
    // 'recorded' = FRESH upward report; 'duplicate'/'cancelled' = the ancestor
    // already holds the row (or an ordinary cancel short-circuited). Preserve the
    // distinction so the collect path's `reportedTerminalOutcome` stays
    // 'recorded'-only (RD-598 review finding 2, pinned at
    // collection-service.test.ts:1429). The CLI adapters collapse both back to
    // 'reported'.
    if (recorded === 'recorded') return 'reported';
    return 'duplicate';
  }

  // Inline arm: record the child's outcome, then advance the composing parent.
  const recorded = await deps.completionService.recordChildCompletion({
    childState,
    result: projection.result,
  });
  if (recorded === 'not-applicable') return 'not-applicable';
  if (recorded === 'cancelled') return 'handled';
  if (recorded === 'blocked') return 'blocked';

  const outcome = await deps.advanceInlineParent({
    parentRunId: linkage.parentRunId,
    parentFrameKey: linkage.parentFrameKey,
    parentEntry: linkage.parentEntry,
    result: projection.result,
  });

  // Parent is still running / waiting on sibling substeps: nothing to release.
  if (outcome.status === 'active') return 'handled';

  // Parent reached a terminal (stopped/done) via the callable. This seam is the
  // SOLE release owner (the callable defers release via 'defer-to-caller'), so
  // release here exactly once and recurse ONE level up. reportTerminalChild
  // self-guards when the fresh parent has no linkage of its own.
  //
  // RELEASE DISPOSITION (RD-598 verification): `retainClaimsAsTerminal: true` —
  // matching the collect terminal branch (collection-service.ts releaseRunbook at
  // ~:502) so a later `--claim-id` confirm/conflict against the terminal parent
  // resolves `terminal`, not `missing`. Deciding disposition once, in one owner,
  // eliminates the old drain-deletes / loop-retains inconsistency.
  await deps.sessionService.releaseRunbook(linkage.parentRunId, {
    retainClaimsAsTerminal: true,
  });
  const freshParent = await deps.manager.load(linkage.parentRunId);
  const propagated: TerminalUpwardPropagationResult = freshParent
    ? await propagateTerminalChildUpward(deps, freshParent, undefined)
    : 'not-applicable';

  if (outcome.status === 'stopped') {
    return propagated === 'blocked' ? 'blocked' : 'stopped';
  }
  // outcome.status === 'done'
  if (propagated === 'blocked') return 'blocked';
  if (propagated === 'stopped') return 'stopped';
  return 'handled';
}
