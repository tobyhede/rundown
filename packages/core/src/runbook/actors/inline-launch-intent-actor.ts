import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import { fromPromise } from 'xstate';

import type { InlineLaunchIntent } from '../../events/types.js';
import { getErrorMessage } from '../../errors.js';
import { buildContextSnapshot } from '../delegation-context.js';
import type { ResolveDelegationRunbook } from '../delegation-inference.js';
import { isRunId } from '../run-id.js';
import { findSubstepState, type FrameKey, upsertSubstepState } from '../targeting.js';
import type { DelegationParentState, ResolvedStep, RunId, SubstepState } from '../types.js';

/** Parent state shape required to prepare durable inline launch metadata. */
export type InlineLaunchParentState = Omit<DelegationParentState, 'id'> & {
  /** Raw current parent run id, validated by the actor before intent preparation. */
  readonly id: unknown;
};

/** Runtime resolver for inline child runbook references. */
export type ResolveInlineRunbook = ResolveDelegationRunbook;

/** Inline launch intent before actor-service enriches it with `parentEntry`. */
export type InlineLaunchIntentWithoutParentEntry = Omit<InlineLaunchIntent, 'parentEntry'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * Type guard for a persisted inline-launch intent (pre-`parentEntry`).
 *
 * Validates the durable shape stored in `RunbookContext.inlineLaunchIntent` so
 * both the actor-service projection and the collection service can detect a
 * pending inline launch without duplicating the shape check.
 *
 * @param value - Candidate value (typically `context.inlineLaunchIntent`)
 * @returns True when `value` is an {@link InlineLaunchIntentWithoutParentEntry}
 */
export function isInlineLaunchIntentWithoutParentEntry(
  value: unknown,
): value is InlineLaunchIntentWithoutParentEntry {
  if (!isRecord(value)) return false;
  const childRunbookRef = value.childRunbookRef;
  return (
    typeof value.parentRunId === 'string' &&
    typeof value.parentStepId === 'string' &&
    typeof value.parentStep === 'string' &&
    typeof value.parentFrameKey === 'string' &&
    typeof value.childRunId === 'string' &&
    typeof value.childRunbookPath === 'string' &&
    isRecord(childRunbookRef) &&
    typeof childRunbookRef.source === 'string' &&
    typeof childRunbookRef.path === 'string' &&
    isRecord(value.contextSnapshot)
  );
}

/** Input shape for {@link inlineLaunchIntentActor}. */
export interface InlineLaunchIntentInput {
  /** Parent state data needed to prepare the child launch intent. */
  readonly state: InlineLaunchParentState;
  /** Resolved parent runbook steps. */
  readonly steps: readonly ResolvedStep[];
  /** Target substep id within the current parent step. */
  readonly substepId: string;
  /** Active frame key for the current parent execution frame. */
  readonly frameKey: FrameKey;
  /** Runtime resolver for child runbook references. */
  readonly resolveRunbook: ResolveInlineRunbook;
  /** Deterministic child run id generator supplied by the machine wiring. */
  readonly generateChildRunId: () => RunId;
  /** Clock supplied by the machine wiring for deterministic metadata. */
  readonly now: () => string;
}

/** Output shape for {@link inlineLaunchIntentActor}. */
export type InlineLaunchIntentOutput =
  | { readonly status: 'skipped' }
  | {
      readonly status: 'prepared';
      readonly intent: InlineLaunchIntentWithoutParentEntry;
      readonly substepStates: readonly SubstepState[];
    }
  | {
      readonly status: 'failed';
      readonly reason: 'inline_launch_failed' | 'inline_launch_forbidden';
      readonly message: string;
    };

/**
 * Machine-invoked actor that prepares durable inline child launch intent data.
 *
 * The actor performs no persistence and does not create, start, or execute the
 * child runbook. It returns updated parent substep state for the machine to
 * persist and a launch intent for the front end to consume later.
 */
export const inlineLaunchIntentActor = fromPromise<
  InlineLaunchIntentOutput,
  InlineLaunchIntentInput
>(async ({ input }) => {
  if (!isRunId(input.state.id)) {
    return {
      status: 'failed',
      reason: 'inline_launch_failed',
      message: 'Inline launch requires a valid parent RunId.',
    };
  }

  const parentState: DelegationParentState = {
    ...input.state,
    id: input.state.id,
  };

  if (parentState.parentLinkage?.kind === 'delegation') {
    return {
      status: 'failed',
      reason: 'inline_launch_forbidden',
      message: 'Automatic inline launch is not supported inside claimed child scopes.',
    };
  }

  const parentStep = input.steps.find((step) => step.name === parentState.step);
  if (!parentStep || !resolvedStepHasSubsteps(parentStep)) {
    return { status: 'skipped' };
  }

  const substep = parentStep.substeps.find((candidate) => candidate.id === input.substepId);
  if (!substep || substep.delegate || !substep.runbooks?.length) {
    return { status: 'skipped' };
  }

  if (substep.runbooks.length !== 1) {
    return {
      status: 'failed',
      reason: 'inline_launch_failed',
      message: `Inline launch requires exactly one child runbook on substep ${parentState.step}.${input.substepId}.`,
    };
  }

  const childRunbookRef = substep.runbooks[0];
  let resolved: Awaited<ReturnType<ResolveInlineRunbook>>;
  try {
    resolved = await input.resolveRunbook(childRunbookRef);
  } catch (error) {
    return {
      status: 'failed',
      reason: 'inline_launch_failed',
      message: `Unable to resolve inline child runbook "${childRunbookRef}": ${getErrorMessage(error)}`,
    };
  }

  if (!resolved) {
    return {
      status: 'failed',
      reason: 'inline_launch_failed',
      message: `Unable to resolve inline child runbook "${childRunbookRef}"`,
    };
  }

  const existing = findSubstepState(
    parentState.substepStates ?? [],
    input.substepId,
    input.frameKey,
  );
  const childRunId = existing?.inline?.childRunId ?? input.generateChildRunId();
  const createdAt = existing?.inline?.createdAt ?? input.now();
  const contextSnapshot =
    existing?.inline?.contextSnapshot ?? buildContextSnapshot(parentState, input.substepId);
  const startedAt = existing?.inline?.startedAt ?? null;

  const inline = {
    childRunbookPath: resolved.path,
    childRunbookRef: resolved.childRunbookRef,
    contextSnapshot,
    childRunId,
    createdAt,
    startedAt,
  };

  const substepStates = upsertSubstepState(
    parentState.substepStates ?? [],
    input.substepId,
    input.frameKey,
    {
      status: 'running',
      result: undefined,
      inline,
    },
  );

  return {
    status: 'prepared',
    intent: {
      parentRunId: parentState.id,
      parentStepId: input.substepId,
      parentStep: parentState.step,
      parentFrameKey: input.frameKey,
      childRunId,
      childRunbookPath: resolved.path,
      childRunbookRef: resolved.childRunbookRef,
      contextSnapshot,
    },
    substepStates,
  };
});
