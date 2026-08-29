import { getErrorMessage } from '../errors.js';
import { projectDelegateFrontier } from '../events/execution-observation.js';
import type { DelegateFrontierEntry } from '../events/types.js';
import { PersistedDelegateFrontierEntrySchema } from '../schemas.js';
import type { RunbookActorService } from './actor-service.js';
import type { DelegationTokenDeriver } from './delegation-credential.js';
import type { EffectfulActorMutationRunner } from './effectful-actor-mutation-runner.js';
import { findStepOrThrow, resolveCurrentExecutionUnit } from './execution-units.js';
import type { RunProgressionAuthority } from './run-progression-authority.js';
import type { RunbookStateManager } from './state.js';
import { InvalidRunbookStateError } from './state.js';
import type { PersistedDelegateFrontierEntry, ResolvedStep, RunbookState } from './types.js';

/**
 * Refusal text for a persisted delegation frontier reached without the
 * verified claim authority needed to project it.
 *
 * Owned here, next to the seam it describes, and imported by every consumer —
 * the Run Progression activation and the CLI loop's not-yet-migrated paths —
 * so the `ERROR_OCCURRED` and any accompanying outcome cannot describe one
 * refusal differently across seams.
 */
export const FRONTIER_AUTHORITY_REQUIRED_MESSAGE =
  'Delegation frontier cannot be projected without verified claim authority';

/**
 * Refusal prefix for a persisted delegation frontier that the claim authority
 * present on this continuation cannot reproduce.
 *
 * The sibling of {@link FRONTIER_AUTHORITY_REQUIRED_MESSAGE}: there the
 * authority is absent, here it is present but wrong for this frontier — a
 * rotated run-control claim whose successor no longer derives its
 * predecessor's credentials, or a derived bearer that does not hash to the
 * persisted verifier.
 */
export const FRONTIER_PROJECTION_REFUSED_MESSAGE =
  'Delegation frontier cannot be projected by the presented claim authority';

/**
 * Failure text for a projected delegation frontier whose
 * `DELEGATE_FRONTIER_CONSUMED` synchronization did not commit.
 *
 * Not a refusal: no authority was rejected and no credential failed
 * verification. The frontier is still persisted and no bearer was disclosed,
 * so the remediation is to run the step again.
 */
export const FRONTIER_CONSUME_FAILED_MESSAGE =
  'Failed to consume delegation frontier after re-entry; the frontier is still pending, retry the run';

/**
 * Actor-service surface the FENCED half of the re-entry seam needs.
 *
 * Narrower than {@link ReEntryFrontierActorService} and deliberately excludes
 * the fenced runner derives its consume rather than committing one,
 * so a caller cannot accidentally reach the unfenced write through it.
 */
export type PrepareReEntryFrontierActorService = Pick<RunbookActorService, 'prepareActorMutation'>;

/**
 * Outcome of PREPARING a re-entry frontier projection and consume.
 *
 * The same classification as {@link ReEntryProjection} minus `consume_failed`:
 * a derivation cannot half-commit, so the only way the consume does not land is
 * that the enclosing transaction refused, which the caller reports as its own
 * transactional refusal rather than as a frontier-specific retryable failure.
 * The `projected` arm carries what the commit must persist and what may be
 * disclosed only after it does.
 */
export type PreparedReEntryProjection =
  | { readonly status: 'none' }
  | {
      /** The frontier reconstructed its bearers and the consume was derived. */
      readonly status: 'projected';
      /** Prepared state after `DELEGATE_FRONTIER_CONSUMED`, for the owned commit. */
      readonly nextState: RunbookState;
      /**
       * The reconstructed bearers, to be disclosed ONLY after the commit lands.
       *
       * Held as data rather than as a rendered entry because entering the unit
       * reads committed state — doing it here would disclose bearers a refused
       * commit never consumed.
       */
      readonly frontier: readonly DelegateFrontierEntry[];
    }
  | {
      /** A disclosure boundary refused the projection. */
      readonly status: 'projection_refused';
      /**
       * Refusal detail from the projector. Safe to surface: it names the
       * frontier id or the issuer-claim divergence, never a bearer.
       */
      readonly message: string;
    };

/**
 * Result of the fenced Run Progression frontier turn.
 *
 * Unlike the legacy unfenced projection, a consume refusal is a real
 * execution-fence outcome. The frontier remains persisted and no bearer is
 * disclosed. A vanished run is kept distinct: disappearance is not
 * contention and retrying a consume cannot recreate it.
 */
export type FencedReEntryProjection =
  | { readonly status: 'reselect'; readonly state: RunbookState }
  | {
      readonly status: 'projected';
      readonly state: RunbookState;
      /** Transient bearers supplied to the machine's post-commit entry state. */
      readonly frontier: readonly DelegateFrontierEntry[];
    }
  | { readonly status: 'projection_refused'; readonly message: string }
  | { readonly status: 'consume_failed' }
  | {
      readonly status: 'claim_superseded';
      readonly message: string;
    }
  | { readonly status: 'recovery_required'; readonly message: string }
  | { readonly status: 'aggregate_recovery_required'; readonly message: string }
  | { readonly status: 'run_missing'; readonly message: string };

/** Actor-service surface needed by the fenced progression turn. */
export type FencedReEntryFrontierActorService = Pick<
  RunbookActorService,
  'prepareActorMutation' | 'createRecoveryActor'
>;

/** Inputs to {@link projectAndConsumeReEntryFrontierFenced}. */
export interface ProjectAndConsumeReEntryFrontierFencedInput {
  /** Exact state whose compiled machine selected this turn. */
  readonly state: RunbookState;
  /** One core-minted run-bound authority; its capabilities are never split. */
  readonly authority: RunProgressionAuthority;
  /** Project-bound SQLite execution fence. */
  readonly actorMutationRunner: EffectfulActorMutationRunner;
  /** Actor transition/entry seam. */
  readonly actorService: FencedReEntryFrontierActorService;
  /** State reader used only to reselect after a write-free frontier result. */
  readonly manager: Pick<RunbookStateManager, 'load'>;
  /** Parsed graph for the selected run. */
  readonly steps: readonly ResolvedStep[];
}

/**
 * Project, consume, and commit one re-entry frontier as a fenced turn.
 *
 * Projection is derived in `runAll.beforeEffect` against the exact state and
 * claim generation captured by the runner. A write-free `none` result reloads
 * the run and asks the compiled machine to reselect progression, while
 * `projection_refused` is revalidated without acquiring an execution lease.
 * A projected consume is then committed once under that capture; only
 * after the commit does the result expose the reconstructed bearers to the
 * compiled machine's explicit entry state. This preserves
 * commit-before-disclosure while keeping the stale unfenced path out of
 * migrated progression. This service deliberately does not enter the unit:
 * entry selection remains XState-owned.
 *
 * @param input - Selected state, one authority, fence, actor seam, and graph.
 * @returns The closed frontier turn for the compiled machine to classify.
 */
export async function projectAndConsumeReEntryFrontierFenced(
  input: ProjectAndConsumeReEntryFrontierFencedInput,
): Promise<FencedReEntryProjection> {
  if (input.state.id !== input.authority.runId) {
    throw new Error(
      `Run Progression authority for ${input.authority.runId} cannot project frontier for ${input.state.id}`,
    );
  }
  const deriveToken = input.authority.delegationRuntime?.deriveDelegationToken;
  if (deriveToken === undefined) {
    throw new Error('Run Progression selected frontier projection without delegation authority');
  }

  let prepared: Extract<PreparedReEntryProjection, { readonly status: 'projected' }> | undefined;
  const result = await input.actorMutationRunner.runAll<PreparedReEntryProjection>({
    targets: [
      {
        runId: input.authority.runId,
        ...(input.authority.claimKey === undefined ? {} : { claimKey: input.authority.claimKey }),
      },
    ],
    beforeEffect: async ([captured]) => {
      const projection = await prepareReEntryFrontierConsume({
        actorService: input.actorService,
        steps: input.steps,
        state: captured.state,
        deriveToken,
      });
      if (projection.status !== 'projected') {
        return { kind: 'return' as const, value: projection };
      }
      prepared = projection;
      return { kind: 'continue' as const };
    },
    compute: ([captured]) => {
      if (prepared === undefined) {
        throw new Error('Frontier consume reached the commit turn without a prepared projection');
      }
      return Promise.resolve({
        members: [{ runId: captured.state.id, nextState: prepared.nextState }],
        value: prepared,
      });
    },
    makeRecoveryActor: (_runId, state) =>
      input.actorService.createRecoveryActor(state, [...input.steps]),
  });

  if (result.kind !== 'committed') {
    if (result.kind === 'missing') {
      return { status: 'run_missing', message: result.message };
    }
    if (result.kind === 'concurrent_modification' || result.kind === 'execution_in_progress') {
      return { status: 'consume_failed' };
    }
    if (result.kind === 'claim_superseded') {
      return { status: 'claim_superseded', message: result.message };
    }
    if (result.kind === 'recovery_required') {
      return { status: 'recovery_required', message: result.message };
    }
    return { status: 'aggregate_recovery_required', message: result.message };
  }
  if (result.value.status === 'none') {
    const current = await input.manager.load(input.authority.runId);
    return current === null
      ? {
          status: 'run_missing',
          message: `Run ${input.authority.runId} disappeared before frontier entry`,
        }
      : { status: 'reselect', state: current };
  }
  if (result.value.status === 'projection_refused') {
    return result.value;
  }

  // Bind the transient bearer to the EXACT state its consume committed. A
  // reload here can observe a later GOTO/PASS from another writer and attach
  // this frontier's bearer to that newer cursor's STEP_ENTERED observation.
  // Later durable state is observed after this committed turn is delivered;
  // it cannot change which entry this bearer belongs to retroactively.
  return {
    status: 'projected',
    state: result.value.nextState,
    frontier: result.value.frontier,
  };
}

/** Inputs for {@link prepareReEntryFrontierConsume}. */
export interface PrepareReEntryFrontierConsumeInput {
  /** Actor service used to derive the consume transition. */
  readonly actorService: PrepareReEntryFrontierActorService;
  /** Parsed runbook steps for the run carrying the frontier. */
  readonly steps: readonly ResolvedStep[];
  /** The EXACT state captured under the caller's lease. */
  readonly state: RunbookState;
  /** Verified same-issuer deriver, bound to the exact issuing claim. */
  readonly deriveToken: DelegationTokenDeriver;
}

/**
 * Derive a frontier projection and its consume against one captured state.
 *
 * The fenced twin of {@link projectAndConsumeReEntryFrontier}, sharing its
 * disclosure boundary verbatim — same reader, same projector, same refusal arm —
 * and differing only in WHEN the consume lands. The unfenced seam commits the
 * consume itself and returns rendered observations; this one returns the
 * prepared state plus the entry metadata to observe, leaving both the commit and
 * the disclosure to the caller's transaction.
 *
 * The ordering guarantee is preserved and in fact strengthened: the unfenced
 * seam guarantees "no bearers disclosed unless the consume committed" by
 * committing first, which leaves it exposed to a consume that commits while the
 * surrounding work does not. Here the caller cannot observe until its ONE commit
 * has landed, so a refused transaction discloses nothing and consumes nothing.
 *
 * @param input - Actor service, steps, captured state, and verified deriver.
 * @returns The prepared re-entry outcome.
 * @throws {Error} When the run's cursor names a step the parsed runbook does not
 *   define.
 * @throws {InvalidRunbookStateError} When the persisted snapshot carries a
 *   `delegateFrontier` that is not an array of structurally valid entries. Per
 *   the no-migration rule this is corrupt/incompatible persisted state, and the
 *   recovery path is explicit user action (finish, stop, prune, restart).
 * @throws {Error} If {@link RunbookActorService.prepareActorMutation} rejects the
 *   derived snapshot (invalid shape, actor error state).
 */
export async function prepareReEntryFrontierConsume(
  input: PrepareReEntryFrontierConsumeInput,
): Promise<PreparedReEntryProjection> {
  const persistedFrontier = readPersistedReEntryFrontier(input.state);
  if (persistedFrontier.length === 0 || !cursorIsOnSubstep(input.state, input.steps)) {
    return { status: 'none' };
  }

  let frontier: ReturnType<typeof projectDelegateFrontier>;
  try {
    frontier = projectDelegateFrontier(persistedFrontier, input.deriveToken);
  } catch (error) {
    return { status: 'projection_refused', message: getErrorMessage(error) };
  }

  const mutation = await input.actorService.prepareActorMutation(
    input.state.id,
    input.state,
    input.steps,
    { type: 'DELEGATE_FRONTIER_CONSUMED' },
  );
  return { status: 'projected', nextState: mutation.nextState, frontier };
}

function cursorIsOnSubstep(state: RunbookState, steps: readonly ResolvedStep[]): boolean {
  return (
    'id' in resolveCurrentExecutionUnit(findStepOrThrow(steps, state.step, state.id), state.substep)
  );
}

/** Whether this exact run state carries a frontier its current unit may disclose. */
export function hasCurrentReEntryFrontier(
  state: RunbookState,
  steps: readonly ResolvedStep[],
): boolean {
  return readPersistedReEntryFrontier(state).length > 0 && cursorIsOnSubstep(state, steps);
}

function isPersistedDelegateFrontierEntry(value: unknown): value is PersistedDelegateFrontierEntry {
  return PersistedDelegateFrontierEntrySchema.safeParse(value).success;
}

/** Read and structurally validate the persisted delegation re-entry frontier. */
export function readPersistedReEntryFrontier(
  state: RunbookState,
): readonly PersistedDelegateFrontierEntry[] {
  const context = (state.snapshot as { readonly context?: Record<string, unknown> } | undefined)
    ?.context;
  const rawFrontier = context?.delegateFrontier;
  if (rawFrontier === undefined) return [];
  if (!Array.isArray(rawFrontier) || !rawFrontier.every(isPersistedDelegateFrontierEntry)) {
    throw new InvalidRunbookStateError(
      `Run ${state.id} carries a malformed delegateFrontier in its persisted snapshot`,
      { runId: state.id, reason: 'malformed_delegate_frontier' },
    );
  }
  return rawFrontier;
}
