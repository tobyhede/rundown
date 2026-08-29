/**
 * Core types and report-only operation for terminal child outcomes.
 *
 * XState-owned Run Progression owns inline composition. This module retains the
 * typed refusal vocabulary shared by that activation and the delegated
 * report-only operation, which records one outcome row and leaves collection
 * pending.
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
import type { RunId } from './run-id.js';
import type { DelegationOutcome, RunbookState } from './types.js';

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

/**
 * The typed refusal union handed back by the inline parent-advance seam.
 *
 * Each member pairs a `reason` discriminant with its stable diagnostic code on
 * top of {@link InlineParentAdvanceRefusalBase}'s message and refusing run, so
 * frontends narrow on `reason` and render without re-deriving the condition.
 */
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
 * The trip that ended an upward propagation walk (#602).
 *
 * The trip names the already-visited ancestor the walk would have re-entered.
 * It carries the operator `message` and `code` because composing them is core's job — the same
 * shape `LifecycleTerminalOutcome` uses for this exact fact — leaving the frontend
 * to render, not to decide what a corrupt linkage graph should say.
 *
 * Carried on a typed terminal-propagation refusal: a caller holding the refusal
 * necessarily holds the run to prune, so the
 * fail-closed exit code and the operator's recovery can never come apart.
 */
export type LinkageCycleTrip = {
  /** The walk reached a run id it had already visited: a back-edge. */
  readonly cause: 'repeat';
  /** The already-visited run the walk would have re-entered. Prune this. */
  readonly repeatedRunId: RunId;
  /** Operator-facing message naming the offending run. */
  readonly message: string;
  /** Operator-facing error code. */
  readonly code: typeof INLINE_PARENT_CYCLE_CODE;
};

/** Dependencies for report-only delegated terminal propagation. */
export interface ReportDelegatedTerminalDeps {
  /** Completion service that atomically records the child outcome on its parent. */
  readonly completionService: Pick<RunbookCompletionService, 'recordChildCompletion'>;
}

/** Closed outcome of report-only delegated terminal propagation. */
export type DelegatedTerminalReportResult =
  | { readonly kind: 'reported' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'not-applicable' }
  | { readonly kind: 'linkage-cycle'; readonly trip: LinkageCycleTrip };

/**
 * Record a delegated terminal report without exposing inline advancement to a frontend.
 *
 * @param deps - Core completion service.
 * @param childState - Terminal delegated child.
 * @param result - Explicit authored result, or lifecycle inference when absent.
 * @returns The closed report-only outcome.
 */
export async function reportDelegatedTerminal(
  deps: ReportDelegatedTerminalDeps,
  childState: RunbookState,
  result: DelegationOutcome | undefined,
): Promise<DelegatedTerminalReportResult> {
  const linkage = childState.parentLinkage;
  if (linkage?.kind !== 'delegation') return { kind: 'not-applicable' };

  const projection = projectDelegationTerminalOutcome(childState, result);
  if (projection.kind === 'not_terminal') return { kind: 'not-applicable' };
  if (projection.kind === 'command_infrastructure') return { kind: 'refused' };
  if (linkage.parentRunId === childState.id) {
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

  const recorded = await deps.completionService.recordChildCompletion({
    childState,
    result: projection.result,
  });
  if (recorded === 'blocked') return { kind: 'refused' };
  if (recorded === 'not-applicable') return { kind: 'not-applicable' };
  if (recorded === 'recorded') return { kind: 'reported' };
  return { kind: 'duplicate' };
}
