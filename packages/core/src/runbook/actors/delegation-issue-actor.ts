import { fromPromise } from 'xstate';

import type { DelegateFrontierEntry } from '../../events/types.js';
import { getErrorMessage } from '../../errors.js';
import { createDelegation } from '../delegation-service.js';
import {
  inferAllDelegateSubsteps,
  type ResolveDelegationRunbook,
} from '../delegation-inference.js';
import type { FrameKey } from '../targeting.js';
import type { DelegationParentState, ResolvedStep, SubstepState } from '../types.js';

/** Input shape for {@link delegationIssueActor}. */
export interface DelegationIssueInput {
  /** Parent state data needed to issue delegation tokens. */
  readonly state: DelegationParentState;
  /** Resolved parent runbook steps. */
  readonly steps: readonly ResolvedStep[];
  /** Active frame key for the current parent execution frame. */
  readonly frameKey: FrameKey;
  /** Runtime resolver for child runbook references. */
  readonly resolveRunbook: ResolveDelegationRunbook;
}

/** Output shape for {@link delegationIssueActor}. */
export type DelegationIssueOutput =
  | { readonly status: 'skipped' }
  | {
      readonly status: 'issued';
      readonly frontier: readonly DelegateFrontierEntry[];
      readonly substepStates: readonly SubstepState[];
    }
  | {
      readonly status: 'failed';
      readonly reason: 'delegation_resolution_failed' | 'nested_delegation_forbidden';
      readonly message: string;
    };

/**
 * Machine-invoked actor that issues auto-delegation tokens for a DELEGATE frontier.
 *
 * The actor performs no persistence. It returns the updated substep state and
 * frontier entries for the machine to store atomically.
 */
export const delegationIssueActor = fromPromise<DelegationIssueOutput, DelegationIssueInput>(
  async ({ input }) => {
    let targets: ReturnType<typeof inferAllDelegateSubsteps>;

    try {
      targets = inferAllDelegateSubsteps(input.state, input.steps);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'RD-819') {
        return {
          status: 'failed',
          reason: 'nested_delegation_forbidden',
          message: getErrorMessage(error),
        };
      }
      return {
        status: 'failed',
        reason: 'delegation_resolution_failed',
        message: getErrorMessage(error),
      };
    }

    if (targets.length === 0) {
      return { status: 'skipped' };
    }

    let resolvedTargets: Array<{
      target: (typeof targets)[number];
      resolved: Awaited<ReturnType<typeof input.resolveRunbook>>;
    }>;
    try {
      resolvedTargets = await Promise.all(
        targets.map(async (target) => ({
          target,
          resolved: await input.resolveRunbook(target.runbookRef),
        })),
      );
    } catch (error) {
      return {
        status: 'failed',
        reason: 'delegation_resolution_failed',
        message: getErrorMessage(error),
      };
    }

    const unresolved = resolvedTargets.find((entry) => !entry.resolved);
    if (unresolved) {
      return {
        status: 'failed',
        reason: 'delegation_resolution_failed',
        message: `Unable to resolve delegation runbook "${unresolved.target.runbookRef}"`,
      };
    }

    let workingState: DelegationParentState = input.state;
    const frontier: DelegateFrontierEntry[] = [];

    for (const { target, resolved } of resolvedTargets) {
      if (!resolved) {
        return {
          status: 'failed',
          reason: 'delegation_resolution_failed',
          message: `Unable to resolve delegation runbook "${target.runbookRef}"`,
        };
      }

      const result = createDelegation(
        {
          state: workingState,
          stepId: target.stepId,
          childRunbookPath: resolved.path,
          childRunbookRef: resolved.childRunbookRef,
          frameKey: input.frameKey,
        },
        input.steps,
      );

      if (result.status === 'parent_is_delegated') {
        return {
          status: 'failed',
          reason: 'nested_delegation_forbidden',
          message: result.error.message,
        };
      }

      if (result.status !== 'created') {
        return {
          status: 'failed',
          reason: 'delegation_resolution_failed',
          message: result.error.message,
        };
      }

      frontier.push({
        id: target.stepId,
        runbook: target.runbookRef,
        token: result.token,
      });
      workingState = {
        ...workingState,
        substepStates: result.updatedSubstepStates,
      };
    }

    return {
      status: 'issued',
      frontier,
      substepStates: workingState.substepStates ?? [],
    };
  },
);
