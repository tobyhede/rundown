// packages/core/src/runbook/actor-service.ts

/**
 * XState actor lifecycle service for runbooks.
 *
 * Owns actor creation, state synchronisation after transitions, and convenience
 * methods for the two dominant patterns: initialisation (create + sync, no event)
 * and transition (create + send + sync).
 *
 * Composes RunbookStateManager for persistence — does not own disk I/O.
 *
 * @module
 */

import { createActor, type AnyActorRef, type Snapshot } from 'xstate';
import type { ResolvedStep, RunbookState, ForContext } from './types.js';
import type { RunbookStateManager } from './state.js';
import { compileRunbookToMachine, type RunbookEvent, type RunbookContext } from './compiler.js';
import { flattenTemplateVars } from './output-evaluator.js';
import { resolvedStepHasSubsteps } from '@rundown-org/parser';
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
 * Typed shape of the persisted snapshot returned by `actor.getPersistedSnapshot()`
 * within `updateFromActor`. Only the fields accessed in that method are declared;
 * the full XState snapshot envelope is otherwise opaque.
 */
type PersistedRunbookSnapshot = {
  value: unknown;
  context?: Partial<RunbookContext>;
};

/**
 * Manages XState actor lifecycle for runbooks.
 *
 * Encapsulates actor creation (with snapshot migration), state synchronisation
 * after transitions, and convenience methods for the two dominant usage patterns:
 * initialisation (create + sync with no event) and transition (create + send + sync).
 */
export class RunbookActorService {
  /**
   * Create a new RunbookActorService.
   *
   * @param manager - State manager for persisting runbook state to disk
   */
  constructor(private readonly manager: RunbookStateManager) { }

  /**
   * Create and start an XState actor from persisted state.
   *
   * Loads the persisted snapshot, compiles the machine, and starts the actor.
   * The compiler is seeded with `state.templateVars` (flattened) and
   * `state.frontmatterOutputs` so OUTPUTS evaluation works identically on
   * resume as on initial start.
   *
   * @remarks
   * **Invariant (load-bearing):** `snapshot.context.templateVars` must never
   * contain `JsonArrayStream` values. {@link flattenTemplateVars} is the
   * enforcement point — it strips any `isJsonArrayStream(value) === true`
   * entries from `state.templateVars` before they reach the compiler, so the
   * XState snapshot this actor later persists can never carry live file-stream
   * references.
   *
   * The type system enforces this at the compile boundary:
   * `compileRunbookToMachine.options.templateVars` requires
   * `FlattenedTemplateVars` — a nominally branded record produced only by
   * {@link flattenTemplateVars}. The brand symbol is module-private to
   * `output-evaluator.ts`, so external code cannot synthesize a branded
   * value via a plain `as FlattenedTemplateVars` cast. Removing or bypassing
   * the flatten call at this site is therefore a compile error.
   *
   * The runtime stripping inside {@link flattenTemplateVars} remains the
   * actual behaviour guarantee — the brand communicates the contract but
   * does not enforce runtime shape. This matters because the persisted
   * `snapshot` field in `RunbookStateSchema` is `z.unknown().optional()` — it
   * is intentionally *not* structurally validated against `JsonArrayStream`
   * (the XState snapshot envelope is opaque and unstable, see
   * `.work/xstate-patterns/README.md` type-check matrix). Safety on reload
   * relies on this flatten step running.
   *
   * **Do not remove, inline, or bypass the `flattenTemplateVars` call below.**
   * If you need to refactor this seeding, preserve the stream-stripping contract
   * and keep the regression coverage in
   * `packages/core/__tests__/runbook/output-evaluator.test.ts`
   * (`describe('flattenTemplateVars', …)`) plus the end-to-end guard in
   * `packages/core/__tests__/runbook/actor-service.test.ts`
   * (`strips JsonArrayStream from templateVars before seeding the machine
   * context`). The brand tightens the types; the tests still exercise
   * runtime behaviour.
   *
   * @param id - Runbook state ID
   * @param steps - Parsed runbook steps for machine compilation
   * @returns Started actor, or null if state not found
   * @throws {Error} When the loaded state is stale — specifically when
   *   `state.frontmatterOutputs` is `undefined`. Callers should treat this
   *   as a signal to run `rundown prune` and restart execution; the stale
   *   state cannot be migrated in place.
   */
  async createActor(id: string, steps: ResolvedStep[]): Promise<AnyActorRef | null> {
    const state = await this.manager.load(id);
    if (!state) return null;

    if (state.frontmatterOutputs === undefined) {
      throw new Error(
        `Stale runbook state for "${id}": missing frontmatter outputs declarations. ` +
        'Run `rundown prune` and restart execution.',
      );
    }

    const machine = compileRunbookToMachine(steps, {
      templateVars: flattenTemplateVars(state.templateVars ?? {}),
      frontmatterOutputs: state.frontmatterOutputs,
    });

    const actor = createActor(machine, {
      snapshot: state.snapshot as Snapshot<unknown> | undefined,
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
    steps: ResolvedStep[],
  ): Promise<{ state: RunbookState; snapshot: unknown }> {
    const snapshot = actor.getPersistedSnapshot() as unknown as PersistedRunbookSnapshot;
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
      const variables = snapshot.context?.variables ?? {};
      const rawFinalVars = (snapshot.context?.finalVars ?? {}) as Record<string, string>;
      // Empty finalVars on terminal: explicitly write `undefined` so the persisted
      // state has no `finalVars` field. This matches the schema's optional contract
      // and avoids storing a misleading empty object.
      const finalVars = Object.keys(rawFinalVars).length > 0 ? rawFinalVars : undefined;
      const lifecycle =
        snapshot.context?.lifecycle ?? (stateValue === 'COMPLETE' ? 'completed' : 'stopped');
      const state = await this.manager.update(id, {
        variables,
        finalVars,
        lifecycle,
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

    let substep = snapshot.context?.substep;
    if (!substep && match?.[2]) {
      substep = match[2];
    }

    // Find step by name (unified lookup)
    const step = steps.find((s) => s.name === stepName) ?? steps[0];

    const retryCount = snapshot.context?.retryCount ?? 0;
    const variables = snapshot.context?.variables ?? {};

    // FOR loop context
    const forStack = snapshot.context?.forStack as ForContext[] | undefined;
    const iterationResults = snapshot.context?.iterationResults;
    const lastAction = snapshot.context?.lastAction;

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
      lifecycle: snapshot.context?.lifecycle ?? 'running',
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
  async initializeState(id: string, steps: ResolvedStep[]): Promise<RunbookState | null> {
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
    steps: ResolvedStep[],
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
          currentStep && resolvedStepHasSubsteps(currentStep) ? currentStep.substeps.length : 0;

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
          resolvedStepHasSubsteps(currentStep) &&
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
