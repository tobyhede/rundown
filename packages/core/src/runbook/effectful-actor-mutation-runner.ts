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
import type {
  CapturedRunStateResult,
  ParentAdvanceGuard,
  RunbookStore,
} from './storage/runbook-store.js';
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
  /**
   * Drop this target only when its controlling claim has been released.
   *
   * Narrower than {@link EffectfulActorMutationSetTarget.optional}: the target is
   * dropped on `claim_superseded` and on nothing else. It is honoured at both
   * pre-effect stages — the initial capture and the lease acquisition — because
   * the claim can be released in the window between them, while `beforeEffect`
   * reads the filesystem and prepares the mutation. Every other refusal still
   * refuses the set; in particular `execution_in_progress` means another owner
   * genuinely holds the lease, and committing without the target there would
   * silently drop a member the caller named.
   *
   * A target that also sets `optional` is unconditionally optional; this field
   * adds nothing to it.
   */
  readonly optionalWhenClaimSuperseded?: boolean;
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
  /**
   * When the release fires, relative to the run's PREPARED lifecycle.
   *
   * - `always` (the default) — the caller already knows the member reaches
   *   terminal in this transaction, as force-abort does when it force-stops a
   *   linked child. Preserves the original unconditional behaviour.
   * - `terminal` — release only if the prepared state actually completes or
   *   stops. For a caller whose preparation DECIDES the lifecycle, such as a
   *   collect whose drain may or may not advance the target to terminal, the
   *   condition is not knowable when the input is built, and releasing a run
   *   that stayed `running` would drop a live run off session targeting.
   *
   * This mirrors {@link EffectfulActorMutationRunnerInput.terminalRelease}'s
   * `onComplete`/`onStopped` flags, which the single-run path has always
   * evaluated against the prepared state for the same reason.
   */
  readonly when?: 'always' | 'terminal';
}

/** Public contract for one dependency-ordered aggregate actor mutation. */
export interface EffectfulActorMutationSetRunnerInput<TResult> {
  /** Dependency-ordered affected runs. */
  readonly targets: readonly EffectfulActorMutationSetTarget[];
  /** Return a captured-state no-op before acquiring or crossing an effect boundary. */
  readonly beforeEffect?: (
    captured: readonly CapturedActorMutationRun[],
  ) =>
    | { readonly kind: 'continue' }
    | { readonly kind: 'return'; readonly value: TResult }
    | Promise<{ readonly kind: 'continue' } | { readonly kind: 'return'; readonly value: TResult }>;
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

/** A refusal naming exactly one run whose execution outcome is unknown. */
type SingleRunRecoveryRefusal = Extract<
  GuardedMutationResult<never>,
  { readonly kind: 'recovery_required' }
>;

/** What driving recovery for one named run can answer. */
type NamedRunRecoveryOutcome = Extract<
  GuardedMutationResult<never>,
  { readonly kind: 'recovery_required' | 'missing' }
>;

/**
 * Drive machine-owned recovery for the one run a `recovery_required` names.
 *
 * Shared by the run-level and set-level paths because the variant means the same
 * thing on both: one run's execution outcome is unknown and its attempt sits
 * `recovery_pending`. It reaches either path from two places — the lease's
 * dead-owner probe during acquisition, and a commit that found its attempt no
 * longer `effect_started` — and the answer is the same for both, so neither
 * origin is inspected. Recovery is idempotent by construction: an attempt that
 * is not pending answers `not_pending` and nothing is written.
 *
 * The refusal is preserved on every resolved outcome. Recovery unblocks the run
 * for a LATER call; it does not retroactively perform the mutation this call
 * refused, so reporting anything else would claim work that never happened.
 *
 * @param store - Store the recovery commits through.
 * @param refusal - The refusal naming the run and its interrupted epoch.
 * @param makeRecoveryActor - Builds the inert recovery actor for that run.
 * @returns The original refusal once the run is recoverable again, `missing`
 *   when the run vanished first, or recovery's own `recovery_required` when it
 *   could not complete.
 * @throws {Error} When recovery itself fails — a run-level fault the caller sees
 *   rather than a per-member one the aggregate loop degrades to a log.
 */
async function recoverNamedRun(
  store: RunbookStore,
  refusal: SingleRunRecoveryRefusal,
  makeRecoveryActor: RecoveryActorFactory,
): Promise<NamedRunRecoveryOutcome> {
  const recovered = await new ExecutionRecoveryService(store, makeRecoveryActor).recover(
    refusal.runId,
    refusal.epoch,
  );
  switch (recovered.kind) {
    case 'recovered':
    case 'not_pending':
    case 'superseded':
      // Recovery either committed here or another exact recovery already won.
      // Preserve the no-retry command outcome in every case.
      return refusal;
    case 'recovery_required':
      return recovered;
    case 'missing':
      return {
        kind: 'missing',
        runId: refusal.runId,
        message: `Run ${refusal.runId} disappeared before execution recovery completed.`,
      };
  }
}

/** One aggregate outcome weighed against the conditional-optionality policy. */
interface SupersededDropDecision<TResult> {
  /** The executor's aggregate outcome. */
  readonly outcome: EffectfulActorMutationSetRunnerResult<TResult>;
  /** Whether the aggregate `compute` — the external effect — was entered. */
  readonly effectStarted: boolean;
  /** Authorities presented to the refused acquisition or validation. */
  readonly acquiring: readonly CapturedAuthority[];
  /** Runs the caller marked {@link EffectfulActorMutationSetTarget.optionalWhenClaimSuperseded}. */
  readonly supersededOptionalRunIds: ReadonlySet<RunId>;
  /** Runs the caller marked {@link EffectfulActorMutationSetTarget.optional}. */
  readonly optionalRunIds: ReadonlySet<RunId>;
}

/**
 * Select the one opportunistic target a pre-effect refusal drops, if any.
 *
 * The executor's optional-target policy is a flat run-id set: a listed run is
 * dropped on any acquisition refusal. `optionalWhenClaimSuperseded` is a
 * conditional policy that set cannot express, so the aggregate runner — which
 * owns the conditional flag — re-applies it here against the pre-effect refusal
 * rather than widening the unconditional policy. Applying it at capture alone
 * would leave the capture-to-acquisition window unguarded, and that window is
 * real work: a caller's `beforeEffect` loads runbook steps off disk and prepares
 * an actor mutation, so a racing terminal-child report can retire the target's
 * claim inside it.
 *
 * A drop is only sound before the effect boundary. `effectStarted` records
 * whether the aggregate `compute` ran; once it has, re-entering acquisition
 * would repeat an ambiguous external effect, which the fence forbids. Before it,
 * an all-or-none acquisition refusal leaves nothing acquired and nothing
 * written, so a narrower retry starts from the same ground state.
 *
 * Shared by both pre-effect refusal stages — acquisition, and the write-free
 * `beforeEffect` revalidation — so one policy decides both rather than two
 * transcriptions of it drifting apart.
 *
 * @param decision - The refused outcome, effect-boundary flag, and both policies.
 * @returns The run to drop before retrying acquisition or validation, or
 *   undefined to surface the outcome unchanged.
 */
function selectSupersededDrop<TResult>(
  decision: SupersededDropDecision<TResult>,
): RunId | undefined {
  const { outcome, effectStarted, acquiring, supersededOptionalRunIds, optionalRunIds } = decision;
  if (effectStarted || outcome.kind !== 'claim_superseded') return undefined;
  if (!supersededOptionalRunIds.has(outcome.runId)) return undefined;
  // The executor requires a captured set holding at least one required run and
  // throws on one that does not. Surfacing the real refusal instead keeps that
  // boundary a typed outcome the caller can render — the same reason the capture
  // loop returns its last drop rather than throwing on an emptied set.
  const remaining = acquiring.filter(({ runId }) => runId !== outcome.runId);
  if (!remaining.some(({ runId }) => !optionalRunIds.has(runId))) return undefined;
  return outcome.runId;
}

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

    return recoverNamedRun(store, result, input.makeRecoveryActor);
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
        if (
          !target.optional &&
          !(target.optionalWhenClaimSuperseded && result.kind === 'claim_superseded')
        ) {
          return result;
        }
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

    const optionalRunIds = new Set(
      input.targets.filter(({ optional }) => optional).map(({ runId }) => runId),
    );
    // `optional` already drops on every refusal, so a target carrying both flags
    // is unconditionally optional and never reaches the conditional policy.
    const supersededOptionalRunIds = new Set(
      input.targets
        .filter(
          ({ optional, optionalWhenClaimSuperseded }) => !optional && optionalWhenClaimSuperseded,
        )
        .map(({ runId }) => runId),
    );

    const beforeEffect = await input.beforeEffect?.(captured);
    if (beforeEffect?.kind === 'return') {
      // The write-free return is the THIRD pre-effect stage, after capture and
      // acquisition, and the conditional policy has to be applied at every one
      // of them. Nothing has been written and nothing acquired here, so an
      // opportunistic target superseded inside `beforeEffect` is exactly the
      // case the flag names: dropping it and revalidating the rest lets the
      // caller's own resolution stand, where surfacing `claim_superseded` would
      // attribute a write-free refusal to a run the caller already said it
      // would proceed without.
      //
      // Bounded by construction: every iteration removes exactly one authority.
      let validating = captured.map(({ authority }) => authority);
      for (;;) {
        const validation = await store.validateCapturedRunSet(validating);
        if (validation.kind === 'committed') {
          return { kind: 'committed', value: beforeEffect.value };
        }
        const drop = selectSupersededDrop<TResult>({
          outcome: validation,
          effectStarted: false,
          acquiring: validating,
          supersededOptionalRunIds,
          optionalRunIds,
        });
        if (drop === undefined) return validation;
        void logger.debug('dropping opportunistic aggregate target superseded before validation', {
          runId: drop,
          refusal: 'claim_superseded',
        });
        droppedRunIds.add(drop);
        validating = validating.filter(({ runId }) => runId !== drop);
      }
    }

    const executor = new CoreEffectfulMutationExecutor(new SqliteExecutionLeaseService(driver));
    let activeCaptured = captured;
    let acquiring = captured.map(({ authority }) => authority);
    let result: EffectfulActorMutationSetRunnerResult<TResult>;
    // Bounded by construction: every continue removes exactly one run from
    // `acquiring`, so the conditional policy can retry at most once per target.
    for (;;) {
      // The executor's own optional policy is a flat run-id set, which cannot
      // express `optionalWhenClaimSuperseded`. Recording whether the aggregate
      // effect ran is what keeps the conditional drop below strictly pre-effect.
      let effectStarted = false;
      const outcome = await executor.runAll({
        captured: acquiring,
        optionalRunIds: [...optionalRunIds],
        compute: (activeAuthorities) => {
          effectStarted = true;
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
            if (attempt.runId !== exact.state.id) {
              throw new Error('Aggregate execution order does not match the captured targets.');
            }
            return {
              captured: exact.authority,
              execution: attempt,
              next: member.nextState,
            };
          });
          // A release names an owned member, so a dropped optional target takes
          // its release with it — releasing a run this transaction does not own
          // would be an unfenced session write. A `when: 'terminal'` release is
          // additionally gated on the PREPARED lifecycle, evaluated here because
          // this is the first point the prepared states exist.
          const preparedLifecycles = new Map(
            prepared.members.map(({ runId, nextState }) => [runId, nextState.lifecycle]),
          );
          const releases = (input.releases ?? []).filter((release) => {
            if (droppedRunIds.has(release.runId)) return false;
            if (release.when !== 'terminal') return true;
            const lifecycle = preparedLifecycles.get(release.runId);
            return lifecycle === 'completed' || lifecycle === 'stopped';
          });
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
      const drop = selectSupersededDrop({
        outcome,
        effectStarted,
        acquiring,
        supersededOptionalRunIds,
        optionalRunIds,
      });
      if (drop === undefined) {
        result = outcome;
        break;
      }
      void logger.debug('dropping opportunistic aggregate target superseded before acquisition', {
        runId: drop,
        refusal: 'claim_superseded',
      });
      droppedRunIds.add(drop);
      acquiring = acquiring.filter(({ runId }) => runId !== drop);
    }
    if (result.kind === 'recovery_required') {
      // Acquisition refused because a member's owner died AFTER the effect
      // boundary: the lease's dead-owner probe parked that attempt and named it
      // with the single-run variant, which the aggregate loop below cannot see —
      // it iterates `attempts`, and this outcome carries none. Left unhandled,
      // the attempt stays `recovery_pending` forever and every retry re-probes
      // it to the same refusal, so the set could never acquire. Recovery is not
      // optional here the way a post-effect member's is: no set outcome names
      // the other runs, so there is nothing a swallowed failure would protect.
      return recoverNamedRun(store, result, (state) =>
        input.makeRecoveryActor(result.runId, state),
      );
    }
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
        case 'recovery_required':
          void logger.warn('aggregate member recovery remains required', {
            runId: interrupted.runId,
            epoch: interrupted.epoch,
            message: outcome.message,
          });
          break;
        case 'missing':
          // A member pruned out from under the recovery pass is best-effort like
          // every other per-member failure. Returning a single-run `missing`
          // here would strand every interrupted member behind it AND replace the
          // outcome naming the whole set with one naming a run that no longer
          // exists — the caller would be told less about more runs. There is
          // nothing left to recover for this run either way: no row, no attempt.
          void logger.warn('aggregate member disappeared before recovery completed', {
            runId: interrupted.runId,
            epoch: interrupted.epoch,
          });
          break;
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
