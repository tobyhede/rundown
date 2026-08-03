import { getErrorMessage } from '../errors.js';
import {
  projectDelegateFrontier,
  type ExecutionObservationEffect,
  type StepEntryMetadata,
} from '../events/execution-observation.js';
import { PersistedDelegateFrontierEntrySchema } from '../schemas.js';
import type { RunbookActorService } from './actor-service.js';
import type { DelegationTokenDeriver } from './delegation-credential.js';
import { InvalidRunbookStateError } from './state.js';
import type { PersistedDelegateFrontierEntry, ResolvedStep, RunbookState } from './types.js';

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
 *   consume, so the frontier is still persisted. Retryable, and no observations
 *   are returned: their tokens would be orphaned by the next attempt.
 */
export type ReEntryProjection =
  | { readonly status: 'none' }
  | {
      /** The frontier projected, was observed, and the consume committed. */
      readonly status: 'projected';
      /** Entry observations carrying the reconstructed delegation bearers. */
      readonly observations: readonly ExecutionObservationEffect[];
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
  'observeExecutionUnitEntry' | 'sendAndSync'
>;

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
  /**
   * Frontend-rendered entry metadata for the execution unit being (re-)entered.
   * The seam supplies `delegateFrontier`; everything else is the caller's
   * rendering decision. A non-substep entry can never carry a frontier, so
   * `isSubstep: false` short-circuits to `none` without observing.
   */
  readonly entry: Omit<StepEntryMetadata, 'delegateFrontier'>;
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
 * Frontends contribute only their rendered {@link StepEntryMetadata}, and map the
 * returned arms onto their own envelopes — emitter wiring and exit codes.
 *
 * Ordering is deliberate: the consume commits BEFORE the observations are
 * returned, so a failed consume discloses no bearers. The frontier stays
 * persisted in that case, and the next attempt re-projects it.
 *
 * @param input - Actor service, steps, committed state, verified deriver, and rendered entry metadata.
 * @returns The classified re-entry outcome.
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
  if (persistedFrontier.length === 0 || !input.entry.isSubstep) {
    return { status: 'none' };
  }

  let frontier: ReturnType<typeof projectDelegateFrontier>;
  try {
    frontier = projectDelegateFrontier(persistedFrontier, input.deriveToken);
  } catch (error) {
    return { status: 'projection_refused', message: getErrorMessage(error) };
  }

  const observations = await input.actorService.observeExecutionUnitEntry(
    input.state.id,
    [...input.steps],
    { ...input.entry, delegateFrontier: frontier },
  );

  const consumed = await input.actorService.sendAndSync(input.state.id, [...input.steps], {
    type: 'DELEGATE_FRONTIER_CONSUMED',
  });
  if (!consumed) {
    return { status: 'consume_failed' };
  }

  return { status: 'projected', observations, state: consumed.state };
}
