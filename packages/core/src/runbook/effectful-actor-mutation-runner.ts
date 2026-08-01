/**
 * Project-bound construction seam for fenced actor mutations.
 *
 * Frontends receive this narrow core capability instead of opening storage or
 * assembling leases themselves. Each call uses the store registry's one shared
 * driver/store graph, captures authority and state atomically, computes without
 * persistence, and commits under the exact execution attempt.
 *
 * @module runbook/effectful-actor-mutation-runner
 */

import type { ActorSyncResult } from './actor-service.js';
import type { ClaimLookupKey } from './claim-id.js';
import {
  CoreEffectfulMutationExecutor,
  RunbookStoreActorCommitter,
  type PreparedActorMutation,
} from './effectful-mutation-executor.js';
import type { RunId } from './run-id.js';
import type { RunbookState } from './types.js';
import { SqliteExecutionLeaseService, type LeaseWaitPolicy } from './storage/execution-lease.js';
import type { GuardedMutationResult } from './storage/mutation-result.js';
import type { CapturedAuthority } from './storage/mutation-result.js';
import type { CapturedRunStateResult, ParentAdvanceGuard } from './storage/runbook-store.js';
import type { AbandonedAttemptSetOutcome } from './storage/execution-lease.js';
import { openRunbookStore } from './storage/store-registry.js';
import { projectRunbookRelease } from './session-service.js';
import { getErrorMessage } from '../errors.js';
import { logger } from '../logger.js';
import {
  ExecutionRecoveryService,
  type RecoveryActorFactory,
} from './execution-recovery-service.js';

/** Input to one project-bound fenced actor mutation. */
export interface EffectfulActorMutationRunnerInput {
  /** Run whose authority and state must be captured. */
  readonly runId: RunId;
  /** Presented bearer lookup key; absent for an authorized bare/run caller. */
  readonly claimKey?: ClaimLookupKey;
  /** Prepare the actor-derived next state from the exact captured state. */
  readonly compute: (capturedState: RunbookState) => Promise<PreparedActorMutation>;
  /** Rehydrate the same runbook graph with external callables made inert. */
  readonly makeRecoveryActor: RecoveryActorFactory;
  /** Optional finite contention wait policy. */
  readonly wait?: LeaseWaitPolicy;
  /** Optional open-delegated-child guard evaluated in the owned commit transaction. */
  readonly guard?: ParentAdvanceGuard;
  /** Optional terminal session release folded into the owned-state commit. */
  readonly terminalRelease?: {
    /** Release when the prepared state completes. */
    readonly onComplete: boolean;
    /** Release when the prepared state stops. */
    readonly onStopped: boolean;
    /** Preserve matching claims as terminal evidence. */
    readonly retainClaimsAsTerminal?: boolean;
  };
}

/** Narrow core capability used by lifecycle command services. */
export interface EffectfulActorMutationRunner {
  /**
   * Capture, execute, and commit one actor mutation through the execution fence.
   *
   * @param input - Target authority and pure preparation callback.
   * @returns The committed actor sync result or a typed capture/execution refusal.
   */
  run(input: EffectfulActorMutationRunnerInput): Promise<GuardedMutationResult<ActorSyncResult>>;

  /**
   * Capture, execute, and atomically commit a dependency-ordered run set.
   *
   * @param input - Aggregate targets, preparation callback, and release plan.
   * @returns The committed value or a typed aggregate refusal.
   */
  runAll<TResult>(
    input: EffectfulActorMutationSetRunnerInput<TResult>,
  ): Promise<EffectfulActorMutationSetRunnerResult<TResult>>;
}

/** One dependency-ordered aggregate target. */
export interface EffectfulActorMutationSetTarget {
  /** Affected run. */
  readonly runId: RunId;
  /** Presented claim authority for this run, when required. */
  readonly claimKey?: ClaimLookupKey;
  /**
   * Whether a capture or pre-effect lease refusal drops this target instead of
   * refusing the set.
   *
   * For a target the mutation only writes opportunistically — a delegating
   * parent receiving a terminal report — a run that cannot be captured must not veto the
   * whole aggregate. A delegating parent legitimately has no controlling claim
   * of its own (released or pruned while its delegation is still live), and a
   * bare capture refuses exactly that with `claim_superseded`. Treating it as
   * required would strand a child that can then never be closed. Dropped
   * targets are absent from the `captured` array, so preparation sees the same
   * shape it does when the target was never named.
   */
  readonly optional?: boolean;
}

/** Exact state and authority captured for one aggregate target. */
export interface CapturedActorMutationRun {
  /** Captured mutation authority. */
  readonly authority: CapturedAuthority;
  /** State captured in the same read transaction. */
  readonly state: RunbookState;
}

/** One prepared aggregate state write. */
export interface PreparedActorMutationSetMember {
  /** Run receiving the prepared state. */
  readonly runId: RunId;
  /** Prepared machine/domain-derived state. */
  readonly nextState: RunbookState;
}

/** Aggregate preparation returned before the atomic owned commit. */
export interface PreparedActorMutationSet<TResult> {
  /** Prepared states in the same dependency order as the targets. */
  readonly members: readonly PreparedActorMutationSetMember[];
  /** Command-facing value returned after commit. */
  readonly value: TResult;
}

/** Declarative terminal release restricted to an owned aggregate member. */
export interface AggregateTerminalRelease {
  /** Owned run to release. */
  readonly runId: RunId;
  /** Preserve matching claims as terminal evidence. */
  readonly retainClaimsAsTerminal?: boolean;
}

/** Input to {@link EffectfulActorMutationRunner.runAll}. */
export interface EffectfulActorMutationSetRunnerInput<TResult> {
  /** Dependency-ordered affected runs. */
  readonly targets: readonly EffectfulActorMutationSetTarget[];
  /** Prepare every state from the exact captured set. */
  readonly compute: (
    captured: readonly CapturedActorMutationRun[],
  ) => Promise<PreparedActorMutationSet<TResult>>;
  /** Terminal releases committed with the owned state set. */
  readonly releases?: readonly AggregateTerminalRelease[];
  /** Build inert recovery actors for interrupted members. */
  readonly makeRecoveryActor: (
    runId: RunId,
    state: RunbookState,
  ) => ReturnType<RecoveryActorFactory>;
  /** Optional finite contention wait policy. */
  readonly wait?: LeaseWaitPolicy;
}

/** Result of an aggregate project-bound actor mutation. */
export type EffectfulActorMutationSetRunnerResult<TResult> =
  | GuardedMutationResult<TResult>
  | AbandonedAttemptSetOutcome;

/** Registry-backed implementation of {@link EffectfulActorMutationRunner}. */
class ProjectEffectfulActorMutationRunner implements EffectfulActorMutationRunner {
  /**
   * Construct a project-bound runner.
   *
   * @param cwd - Project root identifying the shared store graph.
   */
  constructor(private readonly cwd: string) {}

  async run(
    input: EffectfulActorMutationRunnerInput,
  ): Promise<GuardedMutationResult<ActorSyncResult>> {
    const { driver, store } = await openRunbookStore(this.cwd);
    const captured =
      input.claimKey === undefined
        ? await store.captureRunAuthorityState(input.runId)
        : await store.captureAuthorityState(input.runId, input.claimKey);
    if (captured.kind !== 'captured') return captured;

    const executor = new CoreEffectfulMutationExecutor(new SqliteExecutionLeaseService(driver));
    const terminalRelease = input.terminalRelease;
    const committer = new RunbookStoreActorCommitter(
      store,
      captured.authority,
      input.guard,
      terminalRelease === undefined
        ? undefined
        : (prepared, session) => {
            const lifecycle = prepared.nextState.lifecycle;
            const shouldRelease =
              (lifecycle === 'completed' && terminalRelease.onComplete) ||
              (lifecycle === 'stopped' && terminalRelease.onStopped);
            if (shouldRelease) {
              projectRunbookRelease(session, input.runId, {
                retainClaimsAsTerminal: terminalRelease.retainClaimsAsTerminal,
              });
            }
          },
    );
    const result = await executor.run({
      captured: captured.authority,
      compute: () => input.compute(captured.state),
      commit: (attempt, prepared) => committer.commit(attempt, prepared),
      ...(input.wait === undefined ? {} : { wait: input.wait }),
    });
    if (result.kind !== 'recovery_required') return result;

    const recovered = await new ExecutionRecoveryService(store, input.makeRecoveryActor).recover(
      input.runId,
      result.epoch,
    );
    switch (recovered.kind) {
      case 'recovered':
      case 'not_pending':
      case 'superseded':
        // Recovery either committed here or another exact recovery already won.
        // Preserve the no-retry command outcome in every case.
        return result;
      case 'missing':
        return {
          kind: 'missing',
          runId: input.runId,
          message: `Run ${input.runId} disappeared before execution recovery completed.`,
        };
      default: {
        const _exhaustive: never = recovered;
        return _exhaustive;
      }
    }
  }

  async runAll<TResult>(
    input: EffectfulActorMutationSetRunnerInput<TResult>,
  ): Promise<EffectfulActorMutationSetRunnerResult<TResult>> {
    if (input.targets.length === 0) {
      throw new Error('Aggregate actor mutation requires at least one target.');
    }
    const targetIds = new Set(input.targets.map(({ runId }) => runId));
    if (targetIds.size !== input.targets.length) {
      throw new Error('Aggregate actor mutation repeats a target run.');
    }
    for (const release of input.releases ?? []) {
      if (!targetIds.has(release.runId)) {
        throw new Error(`Aggregate release for ${release.runId} is outside the owned run set.`);
      }
    }

    const { driver, store } = await openRunbookStore(this.cwd);
    const captured: CapturedActorMutationRun[] = [];
    const droppedRunIds = new Set<RunId>();
    // Retained so an all-optional set can refuse with a real capture outcome
    // instead of a synthesized one — the caller sees why the run could
    // not be captured, not merely that the set came out empty.
    let lastDropped: Exclude<CapturedRunStateResult, { readonly kind: 'captured' }> | undefined;
    for (const target of input.targets) {
      const result =
        target.claimKey === undefined
          ? await store.captureRunAuthorityState(target.runId)
          : await store.captureAuthorityState(target.runId, target.claimKey);
      if (result.kind !== 'captured') {
        if (!target.optional) return result;
        void logger.debug('dropping optional aggregate target that could not be captured', {
          runId: target.runId,
          refusal: result.kind,
        });
        droppedRunIds.add(target.runId);
        lastDropped = result;
        continue;
      }
      captured.push({ authority: result.authority, state: result.state });
    }
    if (captured.length === 0) {
      // Every target was optional and none survived capture. There is nothing to
      // own and nothing to commit, but this is an ordinary refusal the caller can
      // render — not an invariant violation — so it must not throw out of a seam
      // whose contract is typed outcomes. `lastDropped` is always set here: an
      // empty `captured` with no drop would require zero targets, which the
      // length check above already rejected.
      if (lastDropped === undefined) {
        throw new Error('Aggregate actor mutation captured no target and recorded no refusal.');
      }
      return lastDropped;
    }

    const executor = new CoreEffectfulMutationExecutor(new SqliteExecutionLeaseService(driver));
    let activeCaptured = captured;
    const result = await executor.runAll({
      captured: captured.map(({ authority }) => authority),
      optionalRunIds: input.targets.filter(({ optional }) => optional).map(({ runId }) => runId),
      compute: (activeAuthorities) => {
        const activeRunIds = new Set(activeAuthorities.map(({ runId }) => runId));
        for (const member of captured) {
          if (!activeRunIds.has(member.state.id)) droppedRunIds.add(member.state.id);
        }
        activeCaptured = captured.filter(({ state }) => activeRunIds.has(state.id));
        return input.compute(activeCaptured);
      },
      commit: async (attempts, prepared) => {
        if (prepared.members.length !== activeCaptured.length) {
          throw new Error('Aggregate preparation must provide one state for every target.');
        }
        const members = prepared.members.map((member, index) => {
          const exact = activeCaptured[index];
          const attempt = attempts[index];
          if (member.runId !== exact.state.id) {
            throw new Error('Aggregate preparation order does not match the captured targets.');
          }
          return {
            captured: exact.authority,
            execution: attempt,
            next: member.nextState,
          };
        });
        // A release names an owned member, so a dropped optional target takes
        // its release with it — releasing a run this transaction does not own
        // would be an unfenced session write.
        const releases = (input.releases ?? []).filter(
          (release) => !droppedRunIds.has(release.runId),
        );
        const committed = await store.commitOwnedRunSet({
          members,
          ...(releases.length === 0
            ? {}
            : {
                updateSession: (session) => {
                  for (const release of releases) {
                    projectRunbookRelease(session, release.runId, {
                      retainClaimsAsTerminal: release.retainClaimsAsTerminal,
                    });
                  }
                },
              }),
        });
        return committed.kind === 'committed'
          ? { kind: 'committed', value: prepared.value }
          : committed;
      },
      ...(input.wait === undefined ? {} : { wait: input.wait }),
    });
    if (result.kind !== 'aggregate_recovery_required') return result;

    for (const interrupted of result.attempts) {
      // Best-effort per member. This loop exists to DOWNGRADE an ambiguous
      // aggregate effect into a typed outcome that names every run needing
      // recovery; letting one member's failure escape would replace that
      // outcome with an opaque throw while leaving the whole set
      // `recovery_pending` and the caller uninformed about which runs those
      // are. The attempt stays pending either way, so a later pass — or
      // dead-owner recovery — can still complete it.
      let outcome: Awaited<ReturnType<ExecutionRecoveryService['recover']>>;
      try {
        outcome = await new ExecutionRecoveryService(store, (state) =>
          input.makeRecoveryActor(interrupted.runId, state),
        ).recover(interrupted.runId, interrupted.epoch);
      } catch (recoveryError) {
        void logger.warn('aggregate member recovery failed; attempt left pending', {
          runId: interrupted.runId,
          epoch: interrupted.epoch,
          error: getErrorMessage(recoveryError),
        });
        continue;
      }
      switch (outcome.kind) {
        case 'recovered':
        case 'not_pending':
        case 'superseded':
          break;
        case 'missing':
          return {
            kind: 'missing',
            runId: interrupted.runId,
            message: `Run ${interrupted.runId} disappeared before aggregate recovery completed.`,
          };
        default: {
          const _exhaustive: never = outcome;
          return _exhaustive;
        }
      }
    }
    return result;
  }
}

/**
 * Build the narrow project-bound actor-mutation runner.
 *
 * Construction is synchronous; the shared store opens lazily on the first run.
 *
 * @param cwd - Project root identifying the shared store graph.
 * @returns A core-owned fenced actor-mutation capability.
 */
export function createEffectfulActorMutationRunner(cwd: string): EffectfulActorMutationRunner {
  return new ProjectEffectfulActorMutationRunner(cwd);
}
