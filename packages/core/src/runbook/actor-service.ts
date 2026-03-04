// packages/core/src/runbook/actor-service.ts

/**
 * XState actor lifecycle service for runbooks.
 *
 * Owns actor creation (with snapshot migration), state synchronisation
 * after transitions, and convenience methods for the two dominant patterns:
 * initialisation (create + sync, no event) and transition (create + send + sync).
 *
 * Composes RunbookStateManager for persistence — does not own disk I/O.
 *
 * @module
 */

import { createActor, type AnyActorRef } from 'xstate';
import type { Step, RunbookState, ForContext } from './types.js';
import type { RunbookStateManager } from './state.js';
import { compileRunbookToMachine, type RunbookEvent } from './compiler.js';
import { stepHasSubsteps } from '@rundown-org/parser';
import { logger } from '../logger.js';

/**
 * Re-export of XState's {@link https://stately.ai/docs/actors | AnyActorRef} type.
 *
 * Provided so CLI callers import from `@rundown-org/core` rather than
 * depending on `xstate` directly.
 */
export type { AnyActorRef } from 'xstate';

/**
 * Result of a {@link RunbookActorService.sendAndSync} operation.
 *
 * Bundles the updated persisted state and raw snapshot so callers
 * can inspect terminal states (COMPLETE / STOPPED) without an extra call.
 */
export interface ActorSyncResult {
  /** The persisted RunbookState after syncing from actor snapshot */
  state: RunbookState;
  /** The raw persisted snapshot for terminal-state inspection */
  snapshot: unknown;
}

/**
 * Manages XState actor lifecycle for runbooks.
 *
 * Encapsulates actor creation (with snapshot migration), state synchronisation
 * after transitions, and convenience methods for the two dominant usage patterns:
 * initialisation (create + sync with no event) and transition (create + send + sync).
 */
export class RunbookActorService {
  /**
   * @param manager - State manager for persisting runbook state to disk
   */
  constructor(private readonly manager: RunbookStateManager) {}

  /**
   * Create and start an XState actor from persisted state.
   *
   * Loads the persisted snapshot, applies migration from flat FOR fields
   * to forStack array if needed, compiles the machine, and starts the actor.
   *
   * @param id - Runbook state ID
   * @param steps - Parsed runbook steps for machine compilation
   * @returns Started actor, or null if state not found
   */
  async createActor(id: string, steps: Step[]): Promise<AnyActorRef | null> {
    const state = await this.manager.load(id);
    if (!state) return null;

    const machine = compileRunbookToMachine(steps, { sources: state.sources });

    // Migrate old snapshot context: flat FOR fields → forStack
    // Intentionally shallow copy — only snapshot.context is replaced during
    // migration, so other nested properties (e.g. snapshot.children) remain
    // aliased to the original. This is safe because we never mutate them.
    // Snapshot migration deals with untyped persisted data — any is unavoidable
    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unnecessary-type-assertion */
    const rawSnapshot = state.snapshot as any;
    let snapshot = rawSnapshot;
    if (rawSnapshot?.context && !rawSnapshot.context.forStack) {
      // Only copy when migration is needed — preserve original otherwise
      snapshot = { ...rawSnapshot };
      const ctx = { ...(rawSnapshot.context as any) };
      if (ctx.forIteration !== undefined) {
        // Derive stepId from snapshot.value (authoritative) with state.step fallback
        const stateValue = rawSnapshot.value as string | undefined;
        const stepMatch = stateValue
          ? (/^step::([^:]+)/.exec(stateValue) ?? /^step_([^_]+)/.exec(stateValue))
          : null;
        const stepId = stepMatch?.[1] ?? state.step;

        snapshot.context = {
          ...ctx,
          forStack: [
            {
              stepId,
              iteration: ctx.forIteration,
              start: ctx.forStart ?? 1,
              end: ctx.forEnd ?? ctx.forIteration,
              variable: ctx.forVariable,
              implicit: false,
              source: { kind: 'range' as const },
            },
          ],
          forIteration: undefined,
          forStart: undefined,
          forEnd: undefined,
          forVariable: undefined,
        };
      } else {
        // No active loop — just ensure forStack exists
        snapshot.context = { ...ctx, forStack: [] };
      }
    }
    /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unnecessary-type-assertion */

    const actor = createActor(machine, {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      snapshot,
    });
    actor.start();
    return actor;
  }

  /**
   * Synchronise persisted state from actor snapshot.
   *
   * Extracts step/substep position, variables, forStack, and lastAction
   * from the actor's persisted snapshot and writes to disk.
   *
   * @param id - Runbook state ID
   * @param actor - The XState actor to read snapshot from
   * @param steps - Parsed runbook steps for step name lookup
   * @returns Updated persisted RunbookState and the raw snapshot
   * @throws {Error} If the actor snapshot's stateValue is not a string
   * @throws {Error} If the provided steps array is empty (for non-terminal states)
   */
  async updateFromActor(
    id: string,
    actor: AnyActorRef,
    steps: Step[],
  ): Promise<{ state: RunbookState; snapshot: unknown }> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const snapshot = actor.getPersistedSnapshot() as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const rawValue: unknown = snapshot.value;

    if (typeof rawValue !== 'string') {
      throw new Error(
        `Unexpected non-string stateValue for runbook "${id}": ${JSON.stringify(rawValue)}`,
      );
    }
    const stateValue = rawValue;

    // If the runbook is in a final state, don't try to parse a step number.
    // Just update the snapshot and variables, preserving the last step number.
    if (stateValue === 'COMPLETE' || stateValue === 'STOPPED') {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const variables = (snapshot.context?.variables ?? {}) as Record<
        string,
        boolean | number | string
      >;
      const state = await this.manager.update(id, {
        variables,
        snapshot,
        // Clear FOR loop state on completion
        forStack: undefined,
        iterationResults: undefined,
      });
      return { state, snapshot };
    }

    if (!steps.length) {
      throw new Error(
        `updateFromActor called with empty steps array for runbook "${id}" (stateValue: "${stateValue}")`,
      );
    }

    // Parse step name from XState state value
    const primaryMatch = /^step::(.+?)(?:::(.+))?$/.exec(stateValue);
    const legacyMatch = !primaryMatch ? /^step_([^_]+)(?:_([^_]+))?$/.exec(stateValue) : null;
    if (legacyMatch) {
      console.warn(
        'Deprecated state-ID format "step_…" detected. Please restart execution to migrate to "step::…" format.',
      );
    }
    const match = primaryMatch ?? legacyMatch;
    const stepName = match ? match[1] : steps[0].name;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    let substep = snapshot.context?.substep as string | undefined;
    if (!substep && match?.[2]) {
      substep = match[2];
    }

    // Find step by name (unified lookup)
    const step = steps.find((s) => s.name === stepName) ?? steps[0];

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const retryCount = (snapshot.context?.retryCount as number | undefined) ?? 0;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const variables = (snapshot.context?.variables ?? {}) as Record<
      string,
      boolean | number | string
    >;

    // FOR loop context
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const forStack = snapshot.context?.forStack as ForContext[] | undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const iterationResults = snapshot.context?.iterationResults as ('pass' | 'fail')[] | undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const lastAction = snapshot.context?.lastAction as RunbookState['lastAction'];

    // Filter implicit ForContext entries — don't persist synthetic loop state
    const realForStack = forStack?.filter((fc) => !fc.implicit);
    const computedForStack = realForStack?.length ? realForStack : undefined;

    // Only clear iterationResults when all stack entries were implicit.
    // When forStack is empty after explicit FOR exit, iterationResults
    // must be preserved for parent-step aggregation.
    const hasOnlyImplicit = forStack?.length ? forStack.every((fc) => fc.implicit) : false;
    const computedIterationResults = hasOnlyImplicit ? undefined : iterationResults;

    const state = await this.manager.update(id, {
      step: stepName, // string
      substep,
      stepName: step.description,
      retryCount,
      variables,
      snapshot,
      forStack: computedForStack,
      iterationResults: computedIterationResults,
      lastAction,
    });
    return { state, snapshot };
  }

  /**
   * Initialise actor state without sending any event.
   *
   * Creates actor, syncs snapshot to persistence, and returns the state.
   * Used at runbook startup to populate initial forStack/context.
   *
   * @param id - Runbook state ID
   * @param steps - Parsed runbook steps
   * @returns Updated state, or null if state not found
   */
  async initializeState(id: string, steps: Step[]): Promise<RunbookState | null> {
    const actor = await this.createActor(id, steps);
    if (!actor) return null;
    try {
      const { state } = await this.updateFromActor(id, actor, steps);
      return state;
    } finally {
      actor.stop();
    }
  }

  /**
   * Create actor, send event, sync state, and return updated state + snapshot.
   *
   * This is the dominant usage pattern: create actor from persisted state,
   * send a transition event (PASS/FAIL/GOTO), sync the result back to disk,
   * and return state + snapshot for the caller to inspect terminal states.
   * The actor is stopped before returning.
   *
   * @param id - Runbook state ID
   * @param steps - Parsed runbook steps
   * @param event - Runbook event to send (PASS, FAIL, RETRY, or GOTO)
   * @throws {Error} If the actor snapshot's stateValue is not a string (from {@link updateFromActor})
   * @throws {Error} If the steps array is empty for a non-terminal state (from {@link updateFromActor})
   * @returns Updated state and snapshot; or null if state not found
   */
  async sendAndSync(
    id: string,
    steps: Step[],
    event: RunbookEvent,
  ): Promise<ActorSyncResult | null> {
    const actor = await this.createActor(id, steps);
    if (!actor) return null;
    try {
      if (logger.isDebugEnabled()) {
        // Pre-send diagnostics
        const preSnapshot = actor.getPersistedSnapshot() as Record<string, unknown>;
        const preValue = preSnapshot.value as string;
        const preCtx = preSnapshot.context as Record<string, unknown> | undefined;
        const preSubstep = preCtx?.substep as string | undefined;
        const stepMatch = /^step::(.+?)(?:::(.+))?$/.exec(preValue);
        const currentStepName = stepMatch?.[1];
        const currentStep = currentStepName
          ? steps.find((s) => s.name === currentStepName)
          : undefined;
        const substepCount =
          currentStep && stepHasSubsteps(currentStep) ? currentStep.substeps.length : 0;

        void logger.debug('sendAndSync:pre-send', {
          runbookId: id,
          stateValue: preValue,
          eventType: event.type,
          substep: preSubstep,
          substepCount,
        });

        actor.send(event);

        // Post-send diagnostics
        const postSnapshot = actor.getPersistedSnapshot() as Record<string, unknown>;
        const postValue = postSnapshot.value as string;
        const postCtx = postSnapshot.context as Record<string, unknown> | undefined;
        const postLastAction = postCtx?.lastAction as { type: string } | undefined;

        void logger.debug('sendAndSync:post-send', {
          runbookId: id,
          stateValue: postValue,
          lastAction: postLastAction?.type,
          transition: `${preValue} → ${postValue}`,
        });

        // Anomaly: non-last substep transitions to terminal state
        if (
          (postValue === 'COMPLETE' || postValue === 'STOPPED') &&
          currentStep &&
          stepHasSubsteps(currentStep) &&
          currentStep.substeps.length > 0 &&
          preSubstep
        ) {
          const isLastSubstep =
            preSubstep === currentStep.substeps[currentStep.substeps.length - 1].id;
          if (!isLastSubstep) {
            void logger.warn('sendAndSync:anomaly — non-last substep reached terminal state', {
              runbookId: id,
              stepName: currentStepName,
              substep: preSubstep,
              substepCount,
              terminalState: postValue,
              lastAction: postLastAction?.type,
              eventType: event.type,
            });
          }
        }
      } else {
        actor.send(event);
      }

      const { state, snapshot } = await this.updateFromActor(id, actor, steps);
      return { state, snapshot };
    } finally {
      actor.stop();
    }
  }
}
