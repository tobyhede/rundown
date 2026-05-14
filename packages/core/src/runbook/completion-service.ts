import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import { DelegationLock } from './delegation-lock.js';
import type { ExecutionLifecycleService } from './execution-lifecycle-service.js';
import type { RunbookActorService, ActorSyncResult } from './actor-service.js';
import type { RunbookStateManager } from './state.js';
import {
  SENTINEL_ENTRY,
  buildCompletionKey,
  buildResolvedCompletion,
  deriveActiveFrame,
  findSubstepState,
  upsertSubstepState,
  type FrameKey,
} from './targeting.js';
import type { ResolvedCompletion, ResolvedStep, RunId, RunbookState } from './types.js';

/**
 * Resolved completion that has been validated against the machine's active cursor.
 */
export interface CurrentCursorResolvedCompletion extends ResolvedCompletion {
  /** Substep is required after current-cursor validation. */
  readonly targetSubstep: string;
  /** Brand proving this completion passed current-cursor validation. */
  readonly __currentCursorValidated: true;
}

/** Completion applied to the machine during a drain pass. */
export interface AppliedResolvedCompletion {
  /** Persisted completion key consumed for this application. */
  readonly key: string;
  /** Validated completion sent into the machine. */
  readonly completion: CurrentCursorResolvedCompletion;
  /** State before the completion was applied. */
  readonly stateBefore: RunbookState;
  /** State after the completion was applied. */
  readonly stateAfter: RunbookState;
  /** Raw actor snapshot after the completion was applied. */
  readonly snapshot: unknown;
}

/** Target mismatch returned when a persisted completion is not for the active cursor. */
export interface CompletionTargetMismatch {
  readonly status: 'failed';
  readonly reason: 'target_mismatch';
  readonly message: string;
  readonly completion: ResolvedCompletion;
}

/** Result of recording a deferred completion. */
export type RecordCompletionResult =
  | { readonly status: 'recorded'; readonly key: string }
  | { readonly status: 'duplicate'; readonly key: string };

/** Arguments for recording a manual parent/substep completion. */
export interface RecordManualCompletionArgs {
  readonly runbookId: RunId;
  readonly currentState: RunbookState;
  readonly targetStep: string;
  readonly targetSubstep: string;
  readonly targetIteration?: number;
  readonly targetFrameKey: FrameKey;
  readonly result: 'pass' | 'fail';
  readonly agentId: string;
  readonly completedAt?: string;
  readonly finalVars?: Readonly<Record<string, string>>;
  readonly targetEntry?: number;
}

/** Arguments for recording a completed child run against its parent. */
export interface RecordChildCompletionArgs {
  readonly childState: RunbookState;
  readonly result?: 'pass' | 'fail';
  readonly completedAt?: string;
}

/** Arguments for draining persisted completions into the current machine cursor. */
export interface DrainResolvedCompletionsArgs {
  readonly runbookId: RunId;
  readonly steps: readonly ResolvedStep[];
  readonly currentState: RunbookState;
  readonly frameKeyOverride?: FrameKey;
}

/** Result of a resolved-completion drain pass. */
export type DrainResolvedCompletionsResult =
  | {
      readonly status: 'continue';
      readonly state: RunbookState;
      readonly unresolved: number;
      readonly applied: readonly AppliedResolvedCompletion[];
    }
  | {
      readonly status: 'done' | 'stopped';
      readonly unresolved: number;
      readonly applied: readonly AppliedResolvedCompletion[];
    }
  | CompletionTargetMismatch
  | {
      readonly status: 'not_active';
      readonly frameKey: FrameKey;
      readonly activeFrameKey: FrameKey;
      readonly unresolved: number;
      readonly applied: readonly [];
    };

function findStepOrThrow(steps: readonly ResolvedStep[], stepName: string): ResolvedStep {
  const step = steps.find((candidate) => candidate.name === stepName);
  if (!step) throw new Error(`Step "${stepName}" not found`);
  return step;
}

function terminalStatus(result: ActorSyncResult): 'done' | 'stopped' | undefined {
  if (result.state.lifecycle === 'completed') return 'done';
  if (result.state.lifecycle === 'stopped') return 'stopped';
  return undefined;
}

/**
 * Core service for recording and applying resolved runbook completions.
 */
export class RunbookCompletionService {
  /**
   * Create a completion service.
   *
   * @param manager - Runbook state manager
   * @param lifecycleService - Lifecycle persistence helper
   * @param actorService - DI-aware actor service used to apply validated completions
   */
  constructor(
    private readonly manager: RunbookStateManager,
    private readonly lifecycleService: ExecutionLifecycleService,
    private readonly actorService: RunbookActorService,
  ) {}

  private activeFrameEntry(state: RunbookState, frameKey: FrameKey): number {
    if (state.activeFrameKey === frameKey && state.activeEntry !== undefined) {
      return state.activeEntry;
    }
    return state.frameEntries?.[frameKey] ?? 1;
  }

  private duplicateCandidateKeys(args: {
    readonly frameKey: FrameKey;
    readonly exactEntry: number;
    readonly substep: string;
  }): readonly string[] {
    return [
      buildCompletionKey(args.frameKey, args.exactEntry, args.substep),
      buildCompletionKey(args.frameKey, SENTINEL_ENTRY, args.substep),
    ];
  }

  private async findExistingCompletion(
    runbookId: RunId,
    keys: readonly string[],
  ): Promise<string | null> {
    for (const key of keys) {
      const existing = await this.lifecycleService.getResolvedCompletion(runbookId, key);
      if (existing) return key;
    }
    return null;
  }

  private validateCurrentCompletionTarget(
    state: RunbookState,
    completion: ResolvedCompletion,
    ensured: { readonly frameKey: FrameKey; readonly entry: number },
  ): CurrentCursorResolvedCompletion | CompletionTargetMismatch {
    if (!state.substep) {
      return {
        status: 'failed',
        reason: 'target_mismatch',
        message: 'Resolved completion cannot apply because the current cursor has no substep.',
        completion,
      };
    }
    const activeFrameKey = state.activeFrameKey ?? deriveActiveFrame(state).frameKey;
    const activeEntry = state.activeEntry ?? ensured.entry;
    const mismatch =
      completion.targetStep !== state.step ||
      completion.targetSubstep !== state.substep ||
      completion.targetFrameKey !== activeFrameKey ||
      (completion.targetEntry !== activeEntry && completion.targetEntry !== SENTINEL_ENTRY);
    if (mismatch) {
      return {
        status: 'failed',
        reason: 'target_mismatch',
        message: `Resolved completion target does not match current cursor ${state.step}.${state.substep}.`,
        completion,
      };
    }
    return {
      ...completion,
      targetSubstep: state.substep,
      targetEntry: activeEntry,
      __currentCursorValidated: true,
    };
  }

  /**
   * Record a manual completion for a parent substep.
   *
   * @param args - Manual completion target and result
   * @returns Whether a completion was recorded or already existed
   */
  async recordManualCompletion(args: RecordManualCompletionArgs): Promise<RecordCompletionResult> {
    const activeFrameKey =
      args.currentState.activeFrameKey ?? deriveActiveFrame(args.currentState).frameKey;
    const isActiveFrame = args.targetFrameKey === activeFrameKey;
    const exactEntry =
      args.targetEntry ?? this.activeFrameEntry(args.currentState, args.targetFrameKey);
    const entry = isActiveFrame ? exactEntry : SENTINEL_ENTRY;
    const keys = this.duplicateCandidateKeys({
      frameKey: args.targetFrameKey,
      exactEntry,
      substep: args.targetSubstep,
    });
    const existingKey = await this.findExistingCompletion(args.runbookId, keys);
    if (existingKey) return { status: 'duplicate', key: existingKey };

    const key = buildCompletionKey(args.targetFrameKey, entry, args.targetSubstep);
    const completion = buildResolvedCompletion({
      agentId: args.agentId,
      result: args.result,
      targetStep: args.targetStep,
      targetSubstep: args.targetSubstep,
      targetIteration: args.targetIteration,
      targetFrameKey: args.targetFrameKey,
      targetEntry: entry,
      finalVars: args.finalVars,
      completedAt: args.completedAt,
    });
    await this.lifecycleService.upsertResolvedCompletion(args.runbookId, key, completion);
    return { status: 'recorded', key };
  }

  /**
   * Record a parent substep completion through the same duplicate rules as manual completion.
   *
   * @param args - Parent substep completion target and result
   * @returns Whether a completion was recorded or already existed
   */
  async recordParentSubstepCompletion(
    args: RecordManualCompletionArgs,
  ): Promise<RecordCompletionResult> {
    return this.recordManualCompletion(args);
  }

  /**
   * Record a completed child run against its parent linkage.
   *
   * @param args - Child completion input
   * @returns Recording outcome
   */
  async recordChildCompletion(
    args: RecordChildCompletionArgs,
  ): Promise<'recorded' | 'duplicate' | 'not-applicable' | 'cancelled'> {
    const linkage = args.childState.parentLinkage;
    if (!linkage) return 'not-applicable';
    const result =
      args.result ??
      (args.childState.lifecycle === 'completed'
        ? 'pass'
        : args.childState.lifecycle === 'stopped'
          ? 'fail'
          : undefined);
    if (!result) return 'not-applicable';

    const lock = new DelegationLock(this.manager.cwd);
    await lock.acquire(linkage.parentRunId);
    try {
      const parentState = await this.manager.load(linkage.parentRunId);
      if (!parentState) return 'not-applicable';
      const frameKey = linkage.parentFrameKey ?? deriveActiveFrame(parentState).frameKey;
      const substepState = findSubstepState(
        parentState.substepStates ?? [],
        linkage.parentStepId,
        frameKey,
      );
      if (linkage.kind === 'delegation' && substepState?.delegation?.cancelledAt) {
        return 'cancelled';
      }
      const entry = linkage.parentEntry ?? this.activeFrameEntry(parentState, frameKey);
      const recorded = await this.recordManualCompletion({
        runbookId: linkage.parentRunId,
        currentState: parentState,
        targetStep: linkage.parentStep ?? parentState.step,
        targetSubstep: linkage.parentStepId,
        targetFrameKey: frameKey,
        targetEntry: entry,
        result,
        agentId: linkage.kind === 'inline' ? 'inline' : 'delegation',
        finalVars: args.childState.finalVars,
        completedAt: args.completedAt,
      });
      const freshParent = await this.manager.load(linkage.parentRunId);
      if (freshParent) {
        await this.manager.update(linkage.parentRunId, {
          substepStates: upsertSubstepState(
            freshParent.substepStates ?? [],
            linkage.parentStepId,
            frameKey,
            { status: 'done', result },
          ),
        });
      }
      return recorded.status;
    } finally {
      await lock.release(linkage.parentRunId);
    }
  }

  /**
   * Drain active-frame resolved completions into the runbook state machine.
   *
   * @param args - Drain target and current state
   * @returns Drain outcome
   */
  async drainResolvedCompletions(
    args: DrainResolvedCompletionsArgs,
  ): Promise<DrainResolvedCompletionsResult> {
    let state = args.currentState;
    const applied: AppliedResolvedCompletion[] = [];

    while (true) {
      const currentStep = findStepOrThrow(args.steps, state.step);
      if (!resolvedStepHasSubsteps(currentStep) || !state.substep) {
        return { status: 'continue', state, unresolved: 0, applied };
      }

      const ensured = await this.lifecycleService.ensureActiveEntry(
        args.runbookId,
        undefined,
        state,
      );
      state = ensured.state;
      const activeFrameKey = state.activeFrameKey ?? ensured.frameKey;
      if (args.frameKeyOverride && args.frameKeyOverride !== activeFrameKey) {
        return {
          status: 'not_active',
          frameKey: args.frameKeyOverride,
          activeFrameKey,
          unresolved: currentStep.substeps.length,
          applied: [],
        };
      }

      const entry = state.activeEntry ?? ensured.entry;
      const resolved = await this.lifecycleService.listResolvedCompletions(
        args.runbookId,
        activeFrameKey,
        entry,
      );
      const resolvedBySubstep = new Map(
        resolved
          .filter(({ completion }) => completion.targetSubstep !== undefined)
          .map(({ completion }) => [completion.targetSubstep, completion]),
      );
      const unresolved = currentStep.substeps.filter(
        (substep) => !resolvedBySubstep.has(substep.id),
      ).length;
      const currentKey = buildCompletionKey(activeFrameKey, entry, state.substep);
      const current =
        resolved.find(({ key }) => key === currentKey) ??
        resolved.find(
          ({ key, completion }) =>
            key === buildCompletionKey(activeFrameKey, SENTINEL_ENTRY, state.substep) ||
            completion.targetSubstep === state.substep,
        );
      if (!current) {
        return { status: 'continue', state, unresolved, applied };
      }

      const validated = this.validateCurrentCompletionTarget(state, current.completion, ensured);
      if ('status' in validated) return validated;

      const consumed = await this.lifecycleService.consumeResolvedCompletion(
        args.runbookId,
        currentKey,
      );
      if (!consumed) {
        return { status: 'continue', state, unresolved, applied };
      }

      const result = await this.actorService.sendAndSync(args.runbookId, args.steps, {
        type: 'APPLY_CURRENT_RESOLVED_COMPLETION',
        completion: validated,
      });
      if (!result) {
        return { status: 'continue', state, unresolved, applied };
      }
      applied.push({
        key: current.key,
        completion: validated,
        stateBefore: state,
        stateAfter: result.state,
        snapshot: result.snapshot,
      });
      const terminal = terminalStatus(result);
      if (terminal) return { status: terminal, unresolved: 0, applied };
      state = result.state;
    }
  }
}
