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
 *
 * `linkage-cycle` (#602) is the fail-closed trip of the upward walk's guard: the
 * walk reached a run id it had already visited, or the chain exceeded
 * {@link MAX_INLINE_PROPAGATION_CHAIN}. The inline linkage graph is a tree by
 * construction (a parent stamps a child's `parentLinkage.parentRunId` at launch,
 * always pointing at an already-existing ancestor), so either condition means the
 * persisted linkage graph is corrupt. Per the project's no-migration / "reject,
 * don't adapt" rule the seam refuses rather than guessing: it performs NO
 * propagation side effects for the repeated run and surfaces the cause. It is the
 * HIGHEST severity member — a cycle found deep in the walk is never downgraded by
 * a shallower `done`/`stopped`. Consumers that cannot represent it (the CLI
 * adapters, the collect path) map it EXPLICITLY onto their pre-existing `blocked`,
 * which already carries "fail closed, exit non-zero". The two causes are NOT
 * distinguished in this union (no consumer branches on them) — they are named for
 * the operator on the {@link OnLinkageCycle} sink instead.
 */
export type TerminalUpwardPropagationResult =
  | 'handled'
  | 'stopped'
  | 'blocked'
  | 'reported'
  | 'duplicate'
  | 'linkage-cycle'
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
 * The trip that ended an upward propagation walk (#602).
 *
 * `cause` is NOT a control-flow discriminant — both causes collapse to the single
 * `'linkage-cycle'` result, and no consumer branches on it. It exists because the
 * two conditions imply different operator inspections: `'repeat'` means the walk
 * reached `runId` twice (a back-edge in a graph built as a tree), `'depth'` means
 * the chain from `runId` upward exceeded {@link MAX_INLINE_PROPAGATION_CHAIN}
 * without ending. Either way the recovery is explicit user action against `runId`.
 */
export interface LinkageCycleTrip {
  /**
   * The run the walk stalled at: the repeated id for `'repeat'`, the last run
   * walked for `'depth'`. This is the run reported to the operator, so it is the
   * id found AT the tripping level — never the entry child's.
   */
  readonly runId: RunId;
  /** Which guard tripped. Diagnostic only; see {@link LinkageCycleTrip}. */
  readonly cause: 'repeat' | 'depth';
}

/**
 * Frontend-supplied diagnostic sink invoked when the upward walk's guard trips.
 *
 * Rendering a diagnostic is a Category A (frontend) side effect, so the seam does
 * not render — it calls this. Required, not optional: a corrupt linkage graph that
 * fails closed with no named run leaves the operator unable to act, and the project
 * makes explicit user action (finish / stop / prune / restart) the only recovery
 * path for invalid persisted state. Called AT MOST ONCE per walk, immediately
 * before the guard returns `'linkage-cycle'`.
 *
 * @param trip - The stalled run and which guard tripped.
 */
export type OnLinkageCycle = (trip: LinkageCycleTrip) => void;

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
  /**
   * Frontend-supplied diagnostic sink for a tripped linkage guard (#602). Rides
   * the same rail as `advanceInlineParent`: a runtime callable in the deps bag,
   * never persisted.
   */
  readonly onLinkageCycle: OnLinkageCycle;
}

/**
 * Upper bound on the number of runs one upward propagation walk may visit.
 *
 * Backstop for the acyclic-but-corrupt case the visited-set cannot bound: a chain
 * of N DISTINCT run ids costs N advances + N releases + N reloads before it ends.
 * Legitimate inline nesting is a handful of levels (a runbook composing a child
 * that composes a child), so 64 leaves ~2 orders of magnitude of headroom while
 * capping worst-case side effects at 64. Exceeding it trips the same
 * `'linkage-cycle'` disposition — on a tree-by-construction graph, a 64-deep chain
 * is corruption of the same class.
 *
 * Deliberately NOT shared with `SessionService.resolveActiveInlineForceTerminalPlan`
 * (`session-service.ts:777-796`), which walks the same graph ITERATIVELY, read-only,
 * with no writes per level: it cannot exhaust the stack and its unbounded case costs
 * only reads. Different hazard, different rule. See #602.
 */
export const MAX_INLINE_PROPAGATION_CHAIN = 64;

/**
 * Propagate a terminal child run's outcome to its parent, dispatching on linkage.
 *
 * Inline: record the child's outcome, then invoke {@link AdvanceInlineParent}. If
 * the parent reaches terminal (`stopped`/`done`), release it and recurse ONE
 * level up (single-level: inline chains advance synchronously; a delegation
 * boundary takes the report-only arm). Delegation: record report-only and stop.
 *
 * @remarks
 * The walk is guarded (#602): this wrapper seeds the visited-run set with the
 * child's own id and the depth at 1, then delegates to the private recursion. The
 * set is a recursion ARGUMENT, so it survives the release/reload of each parent —
 * a reloaded parent carries no memory of the walk that produced it. On a repeat, or
 * past {@link MAX_INLINE_PROPAGATION_CHAIN} levels, the walk returns
 * `'linkage-cycle'` having performed no propagation side effects for the repeated
 * run. This mirrors `SessionService.resolveActiveInlineForceTerminalPlan`, which
 * fails closed on the same chain with `status: 'inline-cycle'`.
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
  return propagateTerminalChildUpwardInner(deps, childState, result, new Set([childState.id]), 1);
}

/**
 * Guarded recursion behind {@link propagateTerminalChildUpward}.
 *
 * Private: `visited` / `depth` must never leak into the exported 3-arg signature
 * (#602).
 *
 * `depth` is threaded EXPLICITLY rather than read off `visited.size`: the set
 * saturates in a true cycle (a 2-node cycle parks at size 2), so a size-derived cap
 * would be parasitic on the `visited.has` check instead of an independent bound.
 *
 * @param deps - Core services + the inline-advance callable.
 * @param childState - The terminal child run's state at this level.
 * @param result - Explicit operator result, or `undefined` for lifecycle inference.
 * @param visited - Run ids already walked, INCLUDING `childState.id`.
 * @param depth - 1-based count of runs walked so far, including `childState`.
 * @returns The upward-propagation outcome.
 */
async function propagateTerminalChildUpwardInner(
  deps: PropagateTerminalChildUpwardDeps,
  childState: RunbookState,
  result: DelegationOutcome | undefined,
  visited: ReadonlySet<RunId>,
  depth: number,
): Promise<TerminalUpwardPropagationResult> {
  const linkage = childState.parentLinkage;
  if (!linkage) return 'not-applicable';

  const projection = projectDelegationTerminalOutcome(childState, result);
  if (projection.kind === 'not_terminal') return 'not-applicable';
  if (projection.kind === 'command_infrastructure') return 'blocked';

  // #602 guard — BEFORE any side effect, and before the kind dispatch, so a
  // cyclic delegation linkage is refused as firmly as a cyclic inline one. A
  // repeat means the persisted graph is not the tree it is built as; refuse
  // rather than re-run record → advance → release on a run already walked.
  //
  // The sink fires HERE, at the level that found the trip, so it names the true
  // offending run: the severity collapse on the way back out keeps only the member.
  // The 'depth' arm names `childState.id` — the deepest run actually walked —
  // because `linkage.parentRunId` was never reached.
  if (visited.has(linkage.parentRunId)) {
    deps.onLinkageCycle({ runId: linkage.parentRunId, cause: 'repeat' });
    return 'linkage-cycle';
  }
  if (depth >= MAX_INLINE_PROPAGATION_CHAIN) {
    deps.onLinkageCycle({ runId: childState.id, cause: 'depth' });
    return 'linkage-cycle';
  }

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
  try {
    await deps.sessionService.releaseRunbook(linkage.parentRunId, {
      retainClaimsAsTerminal: true,
    });
  } catch {
    // Terminal state is already committed by the callable; a failed release only
    // leaks a self-healing session-stack entry (reclaimed by the next acquirer
    // via PID-aware stale detection). Never let cleanup mask the committed
    // upward propagation (RD-102, matching the collect terminal branch).
  }
  const freshParent = await deps.manager.load(linkage.parentRunId);
  const propagated: TerminalUpwardPropagationResult = freshParent
    ? await propagateTerminalChildUpwardInner(
        deps,
        freshParent,
        undefined,
        new Set(visited).add(linkage.parentRunId),
        depth + 1,
      )
    : // Equivalent mutant: a vanished parent's `propagated` is only ever compared
      // against 'linkage-cycle' / 'blocked' / 'stopped' below, so ANY value outside
      // that set collapses identically to the same outcome. 'not-applicable' is the
      // honest name for "there was no parent to propagate to", not a load-bearing
      // discriminant.
      // Stryker disable StringLiteral: equivalent — the value only has to miss the three severity comparisons below
      'not-applicable';
  // Stryker restore StringLiteral

  // Severity precedence: linkage-cycle > blocked > stopped > handled. The first
  // two lines extend the pre-#602 rule (blocked already outranked stopped) to the
  // new member; the rest is the same stopped/done collapse it always was.
  if (propagated === 'linkage-cycle') return 'linkage-cycle';
  if (propagated === 'blocked') return 'blocked';
  if (outcome.status === 'stopped') return 'stopped';
  if (propagated === 'stopped') return 'stopped';
  return 'handled';
}
