/**
 * Core seam for propagating a terminal child run's outcome to its parent.
 *
 * This module owns the DECISION and single-level upward-report orchestration for
 * both linkage kinds. Inline composition is synchronous: the seam invokes the
 * CLI-supplied {@link AdvanceInlineParent} callable to drain and advance the
 * composing parent (subprocess execution is Category A and stays in the CLI),
 * then — if that drives the parent terminal — recurses ONE level up. The
 * callable's terminal transaction already commits the parent's Run Release.
 * Delegation is report-only: the seam records one outcome row and stops,
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
// `COMPLETION_TARGET_MISMATCH_CODE` is type-only here: this module names it on
// the refusal's `code` field but never reads its value — the CLI callable that
// composes the refusal supplies it.
import type {
  COMPLETION_TARGET_MISMATCH_CODE,
  RunbookCompletionService,
} from './completion-service.js';
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
 * A diagnosed, permanent refusal the inline parent-advance could not absorb.
 *
 * Carries `message` and `code` for the same reason {@link LinkageCycleTrip}
 * does: the frontend renders, it does not decide what the condition says. The
 * Members cover every refusal the CLI execution loop can hand back without
 * applying a terminal transition. Keeping each reason paired with its code
 * makes a new condition a type-level addition instead of an untyped message.
 */
interface InlineParentAdvanceRefusalBase {
  /** Operator-facing message, composed by core at the point of diagnosis. */
  readonly message: string;
  /**
   * The run whose drain refused.
   *
   * REQUIRED, and the field the frontend renders into `details` — the same job
   * `LinkageCycleTrip` gives its `repeatedRunId`. Neither of core's two
   * `target_mismatch` messages names a run (one names the cursor, the other
   * names neither), and the walk recurses, so the refusing run is routinely an
   * ANCESTOR rather than the run the operator invoked. Without it the recovery
   * the refusal prescribes — prune the run and restart it from source — has no
   * run to name.
   */
  readonly runId: RunId;
}

export type InlineParentAdvanceRefusal = InlineParentAdvanceRefusalBase &
  (
    | {
        /** Completion did not address the active cursor. */
        readonly reason: 'target_mismatch';
        readonly code: typeof COMPLETION_TARGET_MISMATCH_CODE;
      }
    | {
        /** A persisted frontier cannot be disclosed without verified authority. */
        readonly reason: 'actor_context_required';
        readonly code: 'ACTOR_CONTEXT_REQUIRED';
      }
    | {
        /** Verified authority could not reproduce the persisted frontier. */
        readonly reason: 'projection_refused';
        readonly code: 'RD-821';
      }
    | {
        /** The projected frontier could not be consumed and remains pending. */
        readonly reason: 'consume_failed';
        readonly code: 'RD-829';
      }
  );

/**
 * Collapsed outcome of one inline parent-advance.
 *
 * `stopped` / `done` mean the advance drove the parent to that terminal and
 * atomically released it (the seam then recurses one level). `active` means the
 * parent is still running or waiting on sibling substeps (no recursion).
 *
 * `refused` is the fail-closed arm (#802). The advance applied nothing, so the
 * seam performs NO recursion and hands the refusal back on its
 * own return value — the same shape `linkage-cycle` uses, and for the same
 * reason: a refusal thrown as an exception unwinds past the frontend's
 * renderer and its `flush`, arriving as an undiagnosed envelope with the
 * buffered output already discarded.
 */
export type AdvanceInlineParentOutcome =
  | { readonly status: 'stopped' | 'done' | 'active' }
  | {
      /** The advance refused; nothing was applied. */
      readonly status: 'refused';
      /** What to tell the operator, and under which code. */
      readonly refusal: InlineParentAdvanceRefusal;
    };

/**
 * CLI-supplied Category-C callable that drains and advances an inline parent.
 *
 * The seam invokes this to run the parent's execution loop (subprocess spawn —
 * Category A). A terminal transition commits its addressed Run Release in the
 * same transaction; no later frame owns cleanup.
 *
 * @param input - Parent identity + terminal result. Data only.
 * @returns The collapsed advance status.
 */
export type AdvanceInlineParent = (
  input: AdvanceInlineParentInput,
) => Promise<AdvanceInlineParentOutcome>;

/**
 * Dispositions an INLINE linkage can yield from the upward walk.
 *
 * Named separately from {@link TerminalUpwardPropagationResult} because two
 * consumers narrow to exactly this subset — the CLI's `advanceParentForInlineChild`
 * and the collect path's `terminalInlineAdvance` — and both must keep the
 * `linkage-cycle` arm's payload. Deriving the full union from this one (rather
 * than restating members in both) is what stops the subset and the whole from
 * drifting apart when a member is added.
 *
 * `linkage-cycle` (#602) is the fail-closed trip of the upward walk's guard: the
 * walk reached a run id it had already visited, or the chain exceeded
 * {@link MAX_INLINE_PROPAGATION_CHAIN}. The inline linkage graph is a tree by
 * construction (a parent stamps a child's `parentLinkage.parentRunId` at launch,
 * always pointing at an already-existing ancestor), so either condition means the
 * persisted linkage graph is corrupt. Per the project's no-migration / "reject,
 * don't adapt" rule the seam refuses rather than guessing: it performs NO
 * propagation side effects for the repeated run and RETURNS the cause on the arm
 * itself (#603). It is the HIGHEST severity member — a cycle found deep in the
 * walk is never downgraded by a shallower `done`/`stopped`, and the arm bubbles up
 * UNCHANGED so its {@link LinkageCycleTrip} still names the run that actually
 * repeated. Consumers that cannot represent it (the CLI adapters, the collect
 * path) map it EXPLICITLY onto their pre-existing `blocked`, which carries "fail
 * closed, exit non-zero"; the trip they collapse away is theirs to render first.
 */
export type InlineUpwardPropagationResult =
  | { readonly kind: 'handled' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'not-applicable' }
  | {
      /** The walk's guard refused a corrupt linkage graph. */
      readonly kind: 'linkage-cycle';
      /** Which run to prune, why, and what to tell the operator. */
      readonly trip: LinkageCycleTrip;
    }
  | {
      /** The inline advance itself refused; nothing was applied (#802). */
      readonly kind: 'advance-refused';
      /** What to tell the operator, and under which code. */
      readonly refusal: InlineParentAdvanceRefusal;
    };

/**
 * Union of upward-propagation outcomes. Inline yields
 * {@link InlineUpwardPropagationResult}; delegation adds `reported` / `duplicate`
 * to the shared `blocked` / `not-applicable` / `linkage-cycle` arms.
 *
 * Discriminated objects, not bare strings (#603): the `linkage-cycle` arm carries
 * the trip that ended the walk, so the run to prune is recoverable from the return
 * type alone rather than arriving on a side channel a caller may or may not have
 * wired. This matches the precedent for the same condition on the same graph —
 * `SessionService.resolveActiveInlineForceTerminalPlan`'s
 * `{ status: 'inline-cycle', repeatedRunId }` — and lets every consumer narrow on
 * `kind` with no cast and no `typeof … === 'object'` check.
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
  | InlineUpwardPropagationResult
  | { readonly kind: 'reported' }
  | { readonly kind: 'duplicate' };

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

/**
 * Operator-facing error code for a refused linkage walk (#602).
 *
 * Deliberately the SAME code the force-terminal path already surfaces for a cyclic
 * inline chain (`lifecycle-command-service.ts`, via
 * `SessionService.resolveActiveInlineForceTerminalPlan`). Both are one operator
 * fact — the persisted linkage graph is not the tree it is built as — with one
 * recovery, so they share one index into that recovery rather than minting a
 * second code for the same condition.
 */
export const INLINE_PARENT_CYCLE_CODE = 'INLINE_PARENT_CYCLE';

/**
 * Compose the operator message for a back-edge in the parent linkage graph.
 *
 * Deliberately says "Parent linkage", NOT "Inline parent" (#602 review). This
 * walk's guard sits BEFORE the kind dispatch, so it also trips on a cyclic
 * DELEGATION linkage — reachable, because `propagateDrivenRunTerminal` routes a
 * delegation-linked child straight to the seam with no claim gate. Wording that
 * asserts "inline" would be flatly false for such a graph and would send the
 * operator hunting for a composition that does not exist. "Parent linkage" is
 * true of both kinds and costs the force-terminal path nothing: its inline-ness
 * is already carried by `reason: 'inline-cycle'` and the error code, not by this
 * text.
 *
 * The {@link INLINE_PARENT_CYCLE_CODE} is unaffected: it is an established
 * agent-facing identifier, and both conditions imply one recovery — prune the
 * named run. The code is the index into that recovery; the message is what a
 * human reads, and only the message has to be true about the linkage kind.
 *
 * SINGLE source of truth, shared with the force-terminal path
 * (`lifecycle-command-service`, via `resolveActiveInlineForceTerminalPlan`'s
 * `inline-cycle`). Both name the same run and prescribe the same recovery, so
 * they must not be able to word it differently. They previously carried
 * byte-identical copies of this string in two packages; the copies were
 * indistinguishable at the CLI boundary, which is precisely how a test can
 * assert one path while exercising the other (#602 review).
 *
 * @param repeatedRunId - The already-visited run the walk would have re-entered.
 * @returns The operator-facing message naming the run to prune.
 */
export function inlineParentCycleMessage(repeatedRunId: RunId): string {
  return `Parent linkage cycle detected at ${repeatedRunId}`;
}

/**
 * Compose the operator message for a linkage chain that outran the depth cap.
 *
 * Says "Parent linkage", NOT "Inline parent", for the same reason
 * {@link inlineParentCycleMessage} does — and the reason binds this arm just as
 * hard. The depth guard fires BEFORE the kind dispatch, so the run it stalls at
 * may carry a DELEGATION linkage: an inline chain that reaches the cap one level
 * below a delegation boundary trips here, and "inline" would be false of the very
 * linkage named. The wording rule is a property of the guard's position, not of
 * either arm; keeping the two arms' wording in lockstep is what stops the next
 * edit from re-splitting them.
 *
 * @param deepestRunId - The deepest run actually walked, whose parent was never reached.
 * @returns The operator-facing message naming the run to prune.
 */
export function inlineParentDepthMessage(deepestRunId: RunId): string {
  return `Parent linkage chain from ${deepestRunId} exceeded the maximum propagation depth of ${String(MAX_INLINE_PROPAGATION_CHAIN)}`;
}

/**
 * The trip that ended an upward propagation walk (#602).
 *
 * A discriminated union on `cause`, so each cause names the run it actually found
 * and no field's meaning depends on a sibling string: a `'repeat'` names the
 * already-visited ancestor the walk would have re-entered; a `'depth'` names the
 * deepest run actually walked (its parent was never reached). Both carry the
 * operator `message` and `code` because composing them is core's job — the same
 * shape `LifecycleTerminalOutcome` uses for this exact fact — leaving the frontend
 * to render, not to decide what a corrupt linkage graph should say.
 *
 * Reached through the `linkage-cycle` arm of {@link TerminalUpwardPropagationResult}
 * (#603): a caller holding the refusal necessarily holds the run to prune, so the
 * fail-closed exit code and the operator's recovery can never come apart.
 */
export type LinkageCycleTrip =
  | {
      /** The walk reached a run id it had already visited: a back-edge. */
      readonly cause: 'repeat';
      /** The already-visited run the walk would have re-entered. Prune this. */
      readonly repeatedRunId: RunId;
      /** Operator-facing message naming the offending run. */
      readonly message: string;
      /** Operator-facing error code. */
      readonly code: typeof INLINE_PARENT_CYCLE_CODE;
    }
  | {
      /** The chain exceeded {@link MAX_INLINE_PROPAGATION_CHAIN} without ending. */
      readonly cause: 'depth';
      /** The deepest run actually walked; its parent was never reached. */
      readonly deepestRunId: RunId;
      /** Operator-facing message naming the run the walk stalled at. */
      readonly message: string;
      /** Operator-facing error code. */
      readonly code: typeof INLINE_PARENT_CYCLE_CODE;
    };

/**
 * Dependencies for {@link propagateTerminalChildUpward}.
 *
 * `manager` / `completionService` are already-constructed core services;
 * `advanceInlineParent` is the CLI-supplied runtime callable (Category C). None
 * of these are persisted.
 *
 * There is deliberately NO diagnostic sink here (#603). Rendering a trip is a
 * Category A (frontend) side effect, but so is deciding WHEN to render it — and a
 * `void` callback can express neither "at most once per walk" nor "only when the
 * walk refuses" in the type system. The trip rides the return value instead, so
 * the frontend renders from data it already holds and callers that provably never
 * walk have nothing to stub.
 */
export interface PropagateTerminalChildUpwardDeps {
  /** State reader for reload-on-recursion. */
  readonly manager: InlineParentAdvanceStateReader;
  /** Completion service for recording the child's outcome against its parent. */
  readonly completionService: Pick<RunbookCompletionService, 'recordChildCompletion'>;
  /** CLI-supplied inline parent-advance execution callable. */
  readonly advanceInlineParent: AdvanceInlineParent;
}

/**
 * Upper bound on the number of runs one upward propagation walk may visit.
 *
 * Backstop for the acyclic-but-corrupt case the visited-set cannot bound: a chain
 * of N DISTINCT run ids costs N advances + N reloads before it ends.
 * Legitimate inline nesting is a handful of levels (a runbook composing a child
 * that composes a child), so 64 leaves ~2 orders of magnitude of headroom while
 * bounding worst-case side effects at 63 (the 64th run trips the guard BEFORE any
 * side effect of its own, so 64 runs are visited but only 63 advance). Exceeding it trips the same
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
 * the parent reaches terminal (`stopped`/`done`), recurse ONE level up
 * (single-level: inline chains advance synchronously; a delegation
 * boundary takes the report-only arm). Delegation: record report-only and stop.
 *
 * @remarks
 * The walk is guarded (#602): this wrapper seeds the visited-run set with the
 * child's own id and the depth at 1, then delegates to the private recursion. The
 * set is a recursion ARGUMENT, so it survives the reload of each parent —
 * a reloaded parent carries no memory of the walk that produced it. On a repeat, or
 * past {@link MAX_INLINE_PROPAGATION_CHAIN} levels, the walk returns
 * `{ kind: 'linkage-cycle', trip }` having performed no propagation side effects
 * for the repeated run. This mirrors
 * `SessionService.resolveActiveInlineForceTerminalPlan`, which fails closed on the
 * same chain with `{ status: 'inline-cycle', repeatedRunId }` — including in
 * shape: both name the offending run on the returned value (#603).
 *
 * @param deps - Core services + the inline-advance callable.
 * @param childState - The terminal child run's state.
 * @param result - Explicit operator result, or `undefined` for lifecycle inference.
 * @returns The upward-propagation outcome. A drain refusal arrives as
 *   `advance-refused` rather than as a rejection (#802).
 * @throws {Error} If the inline-advance callable rejects for any reason it has
 *   not diagnosed — an unexpected state-IO or subprocess failure, never the
 *   drain's own typed refusal.
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
  if (!linkage) return { kind: 'not-applicable' };

  const projection = projectDelegationTerminalOutcome(childState, result);
  if (projection.kind === 'not_terminal') return { kind: 'not-applicable' };
  if (projection.kind === 'command_infrastructure') return { kind: 'blocked' };

  // #602 guard — BEFORE any side effect, and before the kind dispatch, so a
  // cyclic delegation linkage is refused as firmly as a cyclic inline one. A
  // repeat means the persisted graph is not the tree it is built as; refuse
  // rather than re-run record → advance on a run already walked.
  //
  // The trip is composed HERE, at the level that found it, so it names the true
  // offending run; the severity collapse below returns the arm UNCHANGED so the
  // name survives the way back out (#603 — it used to survive only because a
  // side-channel sink fired before the collapse could discard it).
  // The 'depth' arm names `childState.id` — the deepest run actually walked —
  // because `linkage.parentRunId` was never reached.
  if (visited.has(linkage.parentRunId)) {
    return {
      kind: 'linkage-cycle',
      trip: {
        cause: 'repeat',
        repeatedRunId: linkage.parentRunId,
        code: INLINE_PARENT_CYCLE_CODE,
        message: inlineParentCycleMessage(linkage.parentRunId),
      },
    };
  }
  if (depth >= MAX_INLINE_PROPAGATION_CHAIN) {
    return {
      kind: 'linkage-cycle',
      trip: {
        cause: 'depth',
        deepestRunId: childState.id,
        code: INLINE_PARENT_CYCLE_CODE,
        message: inlineParentDepthMessage(childState.id),
      },
    };
  }

  if (linkage.kind === 'delegation') {
    const recorded = await deps.completionService.recordChildCompletion({
      childState,
      result: projection.result,
    });
    if (recorded === 'blocked') return { kind: 'blocked' };
    if (recorded === 'not-applicable') return { kind: 'not-applicable' };
    // 'recorded' = FRESH upward report; 'duplicate'/'cancelled' = the ancestor
    // already holds the row (or an ordinary cancel short-circuited). Preserve the
    // distinction so the collect path's `reportedTerminalOutcome` stays
    // 'recorded'-only (RD-598 review finding 2, pinned at
    // collection-service.test.ts:1429). The CLI adapters collapse both back to
    // 'reported'.
    if (recorded === 'recorded') return { kind: 'reported' };
    return { kind: 'duplicate' };
  }

  // Inline arm: record the child's outcome, then advance the composing parent.
  const recorded = await deps.completionService.recordChildCompletion({
    childState,
    result: projection.result,
  });
  if (recorded === 'not-applicable') return { kind: 'not-applicable' };
  if (recorded === 'cancelled') return { kind: 'handled' };
  if (recorded === 'blocked') return { kind: 'blocked' };

  const outcome = await deps.advanceInlineParent({
    parentRunId: linkage.parentRunId,
    parentFrameKey: linkage.parentFrameKey,
    parentEntry: linkage.parentEntry,
    result: projection.result,
  });

  // A refused advance applied nothing, so there is no terminal and nothing to
  // recurse into — the fail-closed shape `linkage-cycle` already
  // uses, and the reason this arm exists at all (#802). The refusal rides the
  // return value UNCHANGED so the frontend that owns the emitter renders it
  // before its own flush; the alternative it replaces was the callable throwing,
  // which unwound past both.
  if (outcome.status === 'refused') return { kind: 'advance-refused', refusal: outcome.refusal };

  // Parent is still running / waiting on sibling substeps: nothing to recurse.
  if (outcome.status === 'active') return { kind: 'handled' };

  // Parent reached a terminal through the callable. Its terminal transaction
  // already committed the addressed Run Release atomically; this seam owns only
  // upward propagation. Reload and recurse one level without a second release.
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
      // Stryker disable StringLiteral,ObjectLiteral: equivalent — the value only has to miss the three severity comparisons below
      { kind: 'not-applicable' };
  // Stryker restore StringLiteral,ObjectLiteral

  // Severity precedence: linkage-cycle > advance-refused > blocked > stopped >
  // handled. The first three lines extend the pre-#602 rule (blocked already
  // outranked stopped) to the two members that carry a diagnosis; the rest is
  // the same stopped/done collapse it always was.
  //
  // The escalating arms are returned AS THEY CAME BACK, not rebuilt: that is
  // what carries a deep level's `trip` (the run that actually repeated) out past
  // the shallower levels (#603), and a deep level's `refusal` with it (#802).
  // Rebuilding `{ kind: 'linkage-cycle' }` here would reintroduce the very loss
  // the old sink existed to work around, and OMITTING `advance-refused` was the
  // same loss in a worse form: the arm fell through to `stopped`/`handled`, so
  // a refusal raised one level up rendered nothing and exited 0 — quieter than
  // the RD-999 the refusal arm replaced. Both members must be listed here
  // BEFORE the two `outcome.status` lines below, which describe only this
  // level's own advance and would otherwise answer for the deeper one.
  if (propagated.kind === 'linkage-cycle') return propagated;
  if (propagated.kind === 'advance-refused') return propagated;
  if (propagated.kind === 'blocked') return propagated;
  if (outcome.status === 'stopped') return { kind: 'stopped' };
  if (propagated.kind === 'stopped') return { kind: 'stopped' };
  return { kind: 'handled' };
}
