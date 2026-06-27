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
 * Per-field runtime validators for the persisted inline-launch intent shape.
 *
 * Typed as a COMPLETE map over `keyof InlineLaunchIntentWithoutParentEntry`:
 * adding or removing a field on {@link InlineLaunchIntent} breaks compilation
 * here until this guard is brought back in sync, so the runtime check can no
 * longer silently drift from the type it is supposed to validate.
 */
const INLINE_LAUNCH_INTENT_FIELD_GUARDS: Record<
  keyof InlineLaunchIntentWithoutParentEntry,
  (value: unknown) => boolean
> = {
  parentRunId: (value) => typeof value === 'string',
  parentStepId: (value) => typeof value === 'string',
  parentStep: (value) => typeof value === 'string',
  parentFrameKey: (value) => typeof value === 'string',
  childRunId: (value) => typeof value === 'string',
  childRunbookPath: (value) => typeof value === 'string',
  childRunbookRef: (value) =>
    isRecord(value) && typeof value.source === 'string' && typeof value.path === 'string',
  contextSnapshot: (value) => isRecord(value),
};

/**
 * Type guard for a persisted inline-launch intent (pre-`parentEntry`).
 *
 * Validates the durable shape stored in `RunbookContext.inlineLaunchIntent` so
 * both the actor-service projection and the collection service can detect a
 * pending inline launch without duplicating the shape check. Validation is
 * driven by {@link INLINE_LAUNCH_INTENT_FIELD_GUARDS}, which is keyed by the
 * intent type so the two cannot drift apart.
 *
 * @param value - Candidate value (typically `context.inlineLaunchIntent`)
 * @returns True when `value` is an {@link InlineLaunchIntentWithoutParentEntry}
 */
export function isInlineLaunchIntentWithoutParentEntry(
  value: unknown,
): value is InlineLaunchIntentWithoutParentEntry {
  if (!isRecord(value)) return false;
  return Object.entries(INLINE_LAUNCH_INTENT_FIELD_GUARDS).every(([key, validate]) =>
    validate(value[key]),
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
