import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import { CompletionLock } from './completion-lock.js';
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
 * Module-private brand symbol for {@link CurrentCursorResolvedCompletion}.
 *
 * Declared as a real `Symbol()` (typed as `unique symbol`) so callers outside
 * this module cannot forge the branded shape: TypeScript treats the symbol as
 * a distinct nominal value, and the binding is not exported. The only producer
 * of branded values is `validateCurrentCompletionTarget` inside this module.
 */
const currentCursorValidatedBrand: unique symbol = Symbol('currentCursorValidated');

/**
 * Resolved completion that has been validated against the machine's active cursor.
 *
 * The `currentCursorValidatedBrand` symbol is unique to this module and cannot
 * be produced outside `validateCurrentCompletionTarget`, so callers receiving
 * this type can rely on `targetSubstep` matching the current cursor.
 */
export type CurrentCursorResolvedCompletion = ResolvedCompletion & {
  /** Substep is required after current-cursor validation. */
  readonly targetSubstep: string;
  /** Unforgeable brand proving this completion passed current-cursor validation. */
  readonly [currentCursorValidatedBrand]: true;
};

/** Completion applied to the machine during a drain pass. */
export interface AppliedResolvedCompletion {
  /**
   * Lifecycle key consumed for this application. Matches the key returned by
   * `consumeResolvedCompletion` — when the exact key was missing and a
   * sentinel-keyed completion was consumed, this reflects the sentinel key,
   * so logs and audits stay consistent with the lifecycle row that was
   * actually deleted.
   */
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
  /** Discriminant: drain refused to apply this completion. */
  readonly status: 'failed';
  /** Specific reason for the refusal — currently only `target_mismatch`. */
  readonly reason: 'target_mismatch';
  /** Human-readable diagnostic message naming the current cursor. */
  readonly message: string;
  /** The unvalidated completion that triggered the mismatch. */
  readonly completion: ResolvedCompletion;
}

/** Target mismatch returned from a resolved-completion drain pass. */
export interface DrainCompletionTargetMismatch extends CompletionTargetMismatch {
  /** Count of substeps still without a persisted completion. */
  readonly unresolved: number;
  /** Completions applied before the mismatch was detected. */
  readonly applied: readonly AppliedResolvedCompletion[];
}

/** Result of recording a deferred completion. */
export type RecordCompletionResult =
  | {
      /** Discriminant: a new lifecycle row was written. */
      readonly status: 'recorded';
      /** Canonical completion key under which the completion was written. */
      readonly key: string;
    }
  | {
      /** Discriminant: an existing row already covered this target. */
      readonly status: 'duplicate';
      /** Canonical key of the pre-existing row that blocked the write. */
      readonly key: string;
    };

/** Arguments for recording a manual parent/substep completion. */
export interface RecordManualCompletionArgs {
  /** Run id of the parent state owning the lifecycle row. */
  readonly runbookId: RunId;
  /** Current persisted parent state — used for active-frame detection only. */
  readonly currentState: RunbookState;
  /** Target step id the completion is being recorded against. */
  readonly targetStep: string;
  /** Target substep id within the parent step. */
  readonly targetSubstep: string;
  /** Optional FOR iteration index if the target is inside a FOR-loop frame. */
  readonly targetIteration?: number;
  /** Frame key identifying the (step, iteration) the target belongs to. */
  readonly targetFrameKey: FrameKey;
  /** Recorded result — drives the eventual PASS/FAIL raise on drain. */
  readonly result: 'pass' | 'fail';
  /** Agent identifier (`delegation`, `inline`, or a manual command id). */
  readonly agentId: string;
  /** Optional ISO 8601 timestamp; defaults to current time when omitted. */
  readonly completedAt?: string;
  /** Final variables produced by a child runbook, merged into context on drain. */
  readonly finalVars?: Readonly<Record<string, string>>;
  /**
   * Explicit frame-entry counter — overrides the active-frame entry. Pass when
   * the caller already resolved the entry (e.g., child propagation).
   */
  readonly targetEntry?: number;
}

/** Arguments for recording a completed child run against its parent. */
export interface RecordChildCompletionArgs {
  /** Terminal child state carrying `parentLinkage` and optional `finalVars`. */
  readonly childState: RunbookState;
  /** Optional explicit result; defaults to the child's terminal lifecycle. */
  readonly result?: 'pass' | 'fail';
  /** Optional ISO 8601 timestamp; defaults to current time when omitted. */
  readonly completedAt?: string;
  /**
   * Bypass the `delegation.cancelledAt` short-circuit. The default behavior
   * returns `'cancelled'` without writing a completion when the parent
   * substep has been cancelled, which protects against a still-running child
   * racing past a user-initiated cancel. The `abort --force` path persists
   * `cancelledAt` *as* the propagation event and needs the FAIL completion
   * recorded anyway, so it sets this flag.
   */
  readonly ignoreCancellation?: boolean;
}

/** Arguments for draining persisted completions into the current machine cursor. */
export interface DrainResolvedCompletionsArgs {
  /** Run id of the runbook being drained. */
  readonly runbookId: RunId;
  /** Resolved step definitions for the runbook (used for substep ordering). */
  readonly steps: readonly ResolvedStep[];
  /** Current persisted state to derive active frame/cursor from. */
  readonly currentState: RunbookState;
  /**
   * Optional override frame key — when supplied and not equal to the active
   * frame, drain short-circuits to `not_active` without dispatching any event.
   */
  readonly frameKeyOverride?: FrameKey;
  /**
   * Optional upper bound on completions to apply in this drain pass.
   *
   * Used by callers that must observe each machine transition before the next
   * persisted completion is applied. Omitted means drain all currently
   * applicable completions.
   */
  readonly maxApplied?: number;
}

/** Result of a resolved-completion drain pass. */
export type DrainResolvedCompletionsResult =
  | {
      /** Drain advanced the cursor with remaining substeps still pending. */
      readonly status: 'continue';
      /** State after the last applied completion (or current state if none). */
      readonly state: RunbookState;
      /** Count of substeps still without a persisted completion. */
      readonly unresolved: number;
      /** Each completion applied during this pass, in dispatch order. */
      readonly applied: readonly AppliedResolvedCompletion[];
    }
  | {
      /** Runbook reached a terminal lifecycle (`done` or `stopped`). */
      readonly status: 'done' | 'stopped';
      /** Always zero on terminal exits. */
      readonly unresolved: number;
      /** Each completion applied during this pass, in dispatch order. */
      readonly applied: readonly AppliedResolvedCompletion[];
    }
  | DrainCompletionTargetMismatch
  | {
      /** Requested frame is not currently active; drain is observation-only. */
      readonly status: 'not_active';
      /** Frame key that was requested via `frameKeyOverride`. */
      readonly frameKey: FrameKey;
      /** Frame key the machine is actually positioned on. */
      readonly activeFrameKey: FrameKey;
      /** Count of substeps still without a persisted completion. */
      readonly unresolved: number;
      /** Always empty when `not_active`. */
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

function assertCompleteParentLinkage(
  childState: RunbookState,
): NonNullable<RunbookState['parentLinkage']> {
  const linkage = childState.parentLinkage;
  if (!linkage) {
    throw new Error(`Child run ${childState.id} has no parentLinkage.`);
  }
  return linkage;
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

  private async countUnresolvedForState(
    runbookId: RunId,
    steps: readonly ResolvedStep[],
    state: RunbookState,
  ): Promise<number> {
    const currentStep = findStepOrThrow(steps, state.step);
    if (!resolvedStepHasSubsteps(currentStep) || !state.substep) return 0;
    const activeFrameKey = state.activeFrameKey ?? deriveActiveFrame(state).frameKey;
    const entry = state.activeEntry ?? this.activeFrameEntry(state, activeFrameKey);
    const resolved = await this.lifecycleService.listResolvedCompletions(
      runbookId,
      activeFrameKey,
      entry,
    );
    const resolvedSubsteps = new Set(
      resolved
        .map(({ completion }) => completion.targetSubstep)
        .filter((substep): substep is string => substep !== undefined),
    );
    return currentStep.substeps.filter((substep) => !resolvedSubsteps.has(substep.id)).length;
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
      [currentCursorValidatedBrand]: true,
    };
  }

  /**
   * Record a manual completion for a parent substep.
   *
   * Acquires a per-run {@link CompletionLock} around duplicate detection and
   * persistence so concurrent CLI processes cannot both miss the existing row
   * and write competing exact/sentinel completions.
   *
   * @param args - Manual completion target and result
   * @returns Whether a completion was recorded or already existed
   */
  async recordManualCompletion(args: RecordManualCompletionArgs): Promise<RecordCompletionResult> {
    const lock = new CompletionLock(this.manager.cwd);
    await lock.acquire(args.runbookId);
    try {
      return await this.recordManualCompletionUnlocked(args);
    } finally {
      await lock.release(args.runbookId);
    }
  }

  /**
   * Record a manual completion while the caller already holds the completion lock.
   *
   * @param args - Manual completion target and result
   * @returns Whether a completion was recorded or already existed
   */
  private async recordManualCompletionUnlocked(
    args: RecordManualCompletionArgs,
  ): Promise<RecordCompletionResult> {
    const activeFrameKey =
      args.currentState.activeFrameKey ?? deriveActiveFrame(args.currentState).frameKey;
    const isActiveFrame = args.targetFrameKey === activeFrameKey;
    const explicitExactEntry =
      args.targetEntry !== undefined && args.targetEntry !== SENTINEL_ENTRY
        ? args.targetEntry
        : undefined;
    const exactEntry =
      explicitExactEntry ?? this.activeFrameEntry(args.currentState, args.targetFrameKey);
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
   * Record a completed child run against its parent linkage.
   *
   * Acquires the parent {@link DelegationLock} for the duration of the
   * recording. Callers that already hold the parent delegation lock must use
   * {@link recordChildCompletionUnlocked} instead to avoid deadlock.
   *
   * @param args - Child completion input
   * @returns Recording outcome
   */
  async recordChildCompletion(
    args: RecordChildCompletionArgs,
  ): Promise<'recorded' | 'duplicate' | 'not-applicable' | 'cancelled'> {
    const linkage = args.childState.parentLinkage;
    if (!linkage) return 'not-applicable';
    assertCompleteParentLinkage(args.childState);

    const lock = new DelegationLock(this.manager.cwd);
    await lock.acquire(linkage.parentRunId);
    try {
      return await this.recordChildCompletionUnlocked(args);
    } finally {
      await lock.release(linkage.parentRunId);
    }
  }

  /**
   * Record a completed child run against its parent linkage, assuming the
   * caller already holds the parent {@link DelegationLock}.
   *
   * Locking contract: this method performs no locking and MUST only be called
   * by code paths that already hold the parent delegation lock (for example,
   * the `abort --force` command which acquires the lock to mutate substep
   * state before recording the failure). Callers without the lock should use
   * {@link recordChildCompletion}.
   *
   * @param args - Child completion input
   * @returns Recording outcome
   */
  async recordChildCompletionUnlocked(
    args: RecordChildCompletionArgs,
  ): Promise<'recorded' | 'duplicate' | 'not-applicable' | 'cancelled'> {
    if (!args.childState.parentLinkage) return 'not-applicable';
    const linkage = assertCompleteParentLinkage(args.childState);
    const result =
      args.result ??
      (args.childState.lifecycle === 'completed'
        ? 'pass'
        : args.childState.lifecycle === 'stopped'
          ? 'fail'
          : undefined);
    if (!result) return 'not-applicable';

    const parentState = await this.manager.load(linkage.parentRunId);
    if (!parentState) return 'not-applicable';
    const frameKey = linkage.parentFrameKey;
    const substepState = findSubstepState(
      parentState.substepStates ?? [],
      linkage.parentStepId,
      frameKey,
    );
    if (
      linkage.kind === 'delegation' &&
      substepState?.delegation?.cancelledAt &&
      !args.ignoreCancellation
    ) {
      return 'cancelled';
    }
    const entry = linkage.parentEntry;
    const recorded = await this.recordManualCompletion({
      runbookId: linkage.parentRunId,
      currentState: parentState,
      targetStep: linkage.parentStep,
      targetSubstep: linkage.parentStepId,
      targetFrameKey: frameKey,
      targetEntry: entry,
      result,
      agentId: linkage.kind === 'inline' ? 'inline' : 'delegation',
      finalVars: args.childState.finalVars,
      completedAt: args.completedAt,
    });
    if (recorded.status === 'recorded') {
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
    }
    return recorded.status;
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

    for (;;) {
      const currentStep = findStepOrThrow(args.steps, state.step);
      if (!resolvedStepHasSubsteps(currentStep) || !state.substep) {
        return { status: 'continue', state, unresolved: 0, applied };
      }

      const lock = new CompletionLock(this.manager.cwd);
      await lock.acquire(args.runbookId);
      try {
        const ensured = await this.lifecycleService.ensureActiveEntry(
          args.runbookId,
          undefined,
          state,
        );
        state = ensured.state;
        const activeFrameKey = state.activeFrameKey ?? ensured.frameKey;
        if (args.frameKeyOverride && args.frameKeyOverride !== activeFrameKey) {
          // The cursor has moved off the override frame. Two cases:
          //
          // 1. Initial mismatch (`applied.length === 0`): the override targets a
          //    frame other than the current cursor — drain is observation-only.
          //    Return `not_active` so the caller knows nothing was applied.
          //
          // 2. Subsequent mismatch (`applied.length > 0`): we already drained
          //    the override frame, and the apply itself advanced the cursor to
          //    a new frame (e.g., a FOR loop-back into the next iteration). We
          //    must NOT discard the applied entries — the CLI still needs to
          //    observe them so STEP_TRANSITIONED is emitted. Stop draining here
          //    and return `continue` with what we have; the next iteration's
          //    frame belongs to a different delegation/claim flow.
          if (applied.length > 0) {
            return { status: 'continue', state, unresolved: 0, applied };
          }
          const overrideResolved = await this.lifecycleService.listResolvedCompletions(
            args.runbookId,
            args.frameKeyOverride,
            SENTINEL_ENTRY,
          );
          const overrideResolvedSubsteps = new Set(
            overrideResolved
              .map(({ completion }) => completion.targetSubstep)
              .filter((substep): substep is string => substep !== undefined),
          );
          const unresolved = currentStep.substeps.filter(
            (substep) => !overrideResolvedSubsteps.has(substep.id),
          ).length;
          return {
            status: 'not_active',
            frameKey: args.frameKeyOverride,
            activeFrameKey,
            unresolved,
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
        if (!(currentCursorValidatedBrand in validated))
          return { ...validated, unresolved, applied };

        const result = await this.actorService.sendAndSync(args.runbookId, args.steps, {
          type: 'APPLY_CURRENT_RESOLVED_COMPLETION',
          completionKey: current.key,
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
        if (args.maxApplied !== undefined && applied.length >= args.maxApplied) {
          const remaining = await this.countUnresolvedForState(
            args.runbookId,
            args.steps,
            result.state,
          );
          return { status: 'continue', state: result.state, unresolved: remaining, applied };
        }
        state = result.state;
      } finally {
        await lock.release(args.runbookId);
      }
    }
  }
}
