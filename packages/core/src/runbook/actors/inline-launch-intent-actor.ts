import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import { fromPromise } from 'xstate';

import type { InlineLaunchIntent } from '../../events/types.js';
import { getErrorMessage } from '../../errors.js';
import { buildContextSnapshot } from '../delegation-context.js';
import type { ResolveDelegationRunbook } from '../delegation-inference.js';
import { findSubstepState, type FrameKey, upsertSubstepState } from '../targeting.js';
import type { DelegationParentState, ResolvedStep, RunId, SubstepState } from '../types.js';

/** Parent state shape required to prepare durable inline launch metadata. */
export type InlineLaunchParentState = DelegationParentState;

/** Runtime resolver for inline child runbook references. */
export type ResolveInlineRunbook = ResolveDelegationRunbook;

/** Inline launch intent before actor-service enriches it with `parentEntry`. */
export type InlineLaunchIntentWithoutParentEntry = Omit<InlineLaunchIntent, 'parentEntry'>;

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
  if (input.state.parentLinkage?.kind === 'delegation') {
    return {
      status: 'failed',
      reason: 'inline_launch_forbidden',
      message: 'Automatic inline launch is not supported inside claimed child scopes.',
    };
  }

  const parentStep = input.steps.find((step) => step.name === input.state.step);
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
      message: `Inline launch requires exactly one child runbook on substep ${input.state.step}.${input.substepId}.`,
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
    input.state.substepStates ?? [],
    input.substepId,
    input.frameKey,
  );
  const childRunId = existing?.inline?.childRunId ?? input.generateChildRunId();
  const createdAt = existing?.inline?.createdAt ?? input.now();
  const contextSnapshot =
    existing?.inline?.contextSnapshot ?? buildContextSnapshot(input.state, input.substepId);
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
    input.state.substepStates ?? [],
    input.substepId,
    input.frameKey,
    {
      status: 'running',
      inline,
    },
  );

  return {
    status: 'prepared',
    intent: {
      parentRunId: input.state.id,
      parentStepId: input.substepId,
      parentStep: input.state.step,
      parentFrameKey: input.frameKey,
      childRunId,
      childRunbookPath: resolved.path,
      childRunbookRef: resolved.childRunbookRef,
      contextSnapshot,
    },
    substepStates,
  };
});
