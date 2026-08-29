import { getErrorMessage } from '../errors.js';
import { projectDelegateFrontier } from '../events/execution-observation.js';
import type { DelegateFrontierEntry } from '../events/types.js';
import { PersistedDelegateFrontierEntrySchema } from '../schemas.js';
import type { RunbookActorService } from './actor-service.js';
import type { DelegationTokenDeriver } from './delegation-credential.js';
import type { EffectfulActorMutationRunner } from './effectful-actor-mutation-runner.js';
import { findStepOrThrow, resolveCurrentExecutionUnit } from './execution-units.js';
import type { ExecutionUnitEntry } from './execution-unit-entry.js';
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
 * Outcome of projecting and consuming a persisted delegation re-entry frontier.
 *
 * The four arms are the complete classification of the seam: every frontend
 * switches on exactly these, so one condition cannot be reported as two
 * different facts depending on which command drove it.
 *
 * - `none` — nothing to re-enter: no frontier persisted, an empty one, or an
 *   execution unit that cannot carry one. The caller proceeds normally.
 * - `projected` — the frontier reconstructed its bearers, the entry was
 *   observed, and `DELEGATE_FRONTIER_CONSUMED` committed. Only this arm
 *   discloses tokens.
 * - `projection_refused` — a credential disclosure-boundary refusal: the
 *   presenting claim is not the issuing claim, or the reconstructed bearer does
 *   not hash to the persisted verifier. Not retryable — the same authority
 *   refuses identically.
 * - `consume_failed` — projection succeeded but the machine did not accept the
 *   consume, so the frontier is still persisted. Retryable, and the unit is
 *   never entered: no observations are returned, no bearer tokens would be
 *   orphaned by the next attempt, and no render side effect runs for a commit
 *   that never landed.
 */
export type ReEntryProjection =
  | { readonly status: 'none' }
  | {
      /** The frontier projected, was observed, and the consume committed. */
      readonly status: 'projected';
      /**
       * The classified entry carrying the reconstructed delegation bearers.
       *
       * The whole entry rather than its observations alone: the caller needs the
       * same `awaiting` / `runnable` / `inline-launch` classification here that it
       * gets from an ordinary entry, and re-deriving it outside the seam would be
       * a second renderer.
       */
      readonly entered: ExecutionUnitEntry;
      /** Committed state after `DELEGATE_FRONTIER_CONSUMED`. */
      readonly state: RunbookState;
    }
  | {
      /** A disclosure boundary refused the projection. */
      readonly status: 'projection_refused';
      /**
       * Refusal detail from the projector. Safe to surface: it names the
       * frontier id or the issuer-claim divergence, never a bearer.
       */
      readonly message: string;
    }
  | { readonly status: 'consume_failed' };

/**
 * Actor-service surface the re-entry seam needs.
 *
 * Structural rather than the whole {@link RunbookActorService} so a caller may
 * pass a narrower double, and so this module never depends on the class.
 */
export type ReEntryFrontierActorService = Pick<
  RunbookActorService,
  'enterExecutionUnit' | 'sendAndSync'
>;

/**
 * Actor-service surface the FENCED half of the re-entry seam needs.
 *
 * Narrower than {@link ReEntryFrontierActorService} and deliberately excludes
 * `sendAndSync`: the fenced twin derives its consume rather than committing one,
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
 * commit-before-disclosure while removing the stale `sendAndSync` path from
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

/** Inputs for {@link projectAndConsumeReEntryFrontier}. */
export interface ProjectAndConsumeReEntryFrontierInput {
  /** Actor service used to observe the entry and commit the consume. */
  readonly actorService: ReEntryFrontierActorService;
  /** Parsed runbook steps for the run carrying the frontier. */
  readonly steps: readonly ResolvedStep[];
  /**
   * Committed run state whose persisted snapshot carries the frontier. Its `id`
   * is the run the entry is observed on and the consume is sent to.
   */
  readonly state: RunbookState;
  /**
   * Verified same-issuer deriver. A runtime-only capability bound to the exact
   * issuing claim — never persisted, never read from context.
   */
  readonly deriveToken: DelegationTokenDeriver;
}

/**
 * Whether the unit a run's cursor names is a substep.
 *
 * The one fact the seam used to read off a caller-supplied entry, and the
 * complete reason that parameter existed. Deriving it from the state the seam
 * already holds removes the last route by which a caller could hand the seam an
 * entry that disagrees with the run: a non-substep unit can never carry a
 * frontier, so getting this wrong would gate credential disclosure on someone
 * else's rendering decision.
 *
 * @param state - Run whose cursor is being resolved.
 * @param steps - Parsed steps for that run.
 * @returns True when the cursor resolves to a live substep.
 * @throws {Error} When the cursor names a step the runbook does not define.
 */
function cursorIsOnSubstep(state: RunbookState, steps: readonly ResolvedStep[]): boolean {
  return (
    'id' in resolveCurrentExecutionUnit(findStepOrThrow(steps, state.step, state.id), state.substep)
  );
}

/**
 * Whether this exact run state carries a frontier its current unit may disclose.
 *
 * @param state - Run state whose persisted frontier is being inspected.
 * @param steps - Exact parsed graph paired with the run state.
 * @returns True when a frontier exists on the cursor's current substep.
 */
export function hasCurrentReEntryFrontier(
  state: RunbookState,
  steps: readonly ResolvedStep[],
): boolean {
  return readPersistedReEntryFrontier(state).length > 0 && cursorIsOnSubstep(state, steps);
}

/**
 * Runtime guard for a single persisted delegate-frontier entry.
 *
 * `RunbookState.snapshot` is typed `unknown`, so a frontier read out of it cannot
 * be trusted to match {@link PersistedDelegateFrontierEntry} on type alone — the
 * persisted blob may be malformed. Validate each entry's shape before use.
 *
 * @param value - Candidate frontier entry read from the persisted snapshot.
 * @returns A type predicate narrowing `value` to {@link PersistedDelegateFrontierEntry}.
 */
function isPersistedDelegateFrontierEntry(value: unknown): value is PersistedDelegateFrontierEntry {
  return PersistedDelegateFrontierEntrySchema.safeParse(value).success;
}

/**
 * Read and validate the delegation re-entry frontier persisted on a run.
 *
 * The single reader for that blob. Frontends that must know whether a frontier
 * is pending BEFORE they can supply a deriver call this rather than reaching
 * into the snapshot themselves, so the structural guard below applies to every
 * reader of the field.
 *
 * @param state - Committed run state whose snapshot may carry a frontier.
 * @returns The validated frontier entries; empty when none is persisted.
 * @throws {InvalidRunbookStateError} When the persisted `delegateFrontier` is
 *   not an array of structurally valid entries. Per the no-migration rule this
 *   is corrupt/incompatible persisted state, and the recovery path is explicit
 *   user action (finish, stop, prune, restart) rather than trusting the blob.
 */
export function readPersistedReEntryFrontier(
  state: RunbookState,
): readonly PersistedDelegateFrontierEntry[] {
  const context = (state.snapshot as { readonly context?: Record<string, unknown> } | undefined)
    ?.context;
  const rawFrontier = context?.delegateFrontier;
  // No frontier persisted: nothing to re-enter.
  if (rawFrontier === undefined) {
    return [];
  }
  // `snapshot` is `unknown`: a non-array or structurally invalid frontier is a
  // corrupt/incompatible persisted snapshot. Per the no-migration rule, reject it
  // (the CLI maps InvalidRunbookStateError to finish/stop/prune/restart) rather
  // than trusting malformed data or crashing mid-operation.
  if (!Array.isArray(rawFrontier) || !rawFrontier.every(isPersistedDelegateFrontierEntry)) {
    throw new InvalidRunbookStateError(
      `Run ${state.id} carries a malformed delegateFrontier in its persisted snapshot`,
      { runId: state.id, reason: 'malformed_delegate_frontier' },
    );
  }
  return rawFrontier;
}

/**
 * Project a persisted delegation re-entry frontier, observe the entry that
 * carries it, and consume the frontier — as one seam shared by every frontend.
 *
 * This is the single implementation of the retry re-entry disclosure boundary.
 * `rundown collect` (via `collectDelegationOutcomes`) and `rundown run` (via the
 * CLI execution loop) both reach the same persisted data under the same
 * conditions; sharing the seam is what keeps one condition reported as one fact.
 * Frontends contribute nothing to the entry: the seam enters the unit through
 * `RunbookActorService.enterExecutionUnit`, which renders it from the run's own
 * state. Callers map the returned arms onto their own envelopes — emitter wiring
 * and exit codes — and read the classified entry off the `projected` arm.
 *
 * Ordering is deliberate: the consume commits BEFORE the unit is entered, so a
 * failed consume neither discloses bearers nor renders. Rendering can run
 * arbitrary `--helpers` JS, so this is not only a disclosure boundary — it also
 * bounds a non-idempotent helper to running at most once per commit. The
 * frontier stays persisted when the consume fails, and the next attempt
 * re-projects it; had rendering already run on that attempt, the retry would
 * re-invoke the same helper a second time.
 *
 * @param input - Actor service, steps, committed state, and verified deriver.
 * @returns The classified re-entry outcome.
 * @throws {Error} When the run's cursor names a step the parsed runbook does not
 *   define, or when entering the unit cannot render it.
 * @throws {InvalidRunbookStateError} When the persisted snapshot carries a
 *   `delegateFrontier` that is not an array of structurally valid entries. Per
 *   the no-migration rule this is corrupt/incompatible persisted state, and the
 *   recovery path is explicit user action (finish, stop, prune, restart) rather
 *   than trusting the blob.
 */
export async function projectAndConsumeReEntryFrontier(
  input: ProjectAndConsumeReEntryFrontierInput,
): Promise<ReEntryProjection> {
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

  const consumed = await input.actorService.sendAndSync(input.state.id, [...input.steps], {
    type: 'DELEGATE_FRONTIER_CONSUMED',
  });
  if (!consumed) {
    return { status: 'consume_failed' };
  }

  // The COMMITTED state, not `input.state`: rendering must describe the run as
  // it exists after the consume landed, and must not run before the commit that
  // gates it — see the ordering note above.
  const entered = await input.actorService.enterExecutionUnit({
    state: consumed.state,
    steps: input.steps,
    delegateFrontier: frontier,
  });

  return { status: 'projected', entered, state: consumed.state };
}
