import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import type { ResolvedStep } from '@rundown-org/parser';
import type { ClaimRecord } from './claim-id.js';
import { readDelegationCollectionPendingForPolicy } from './delegation-lifecycle-read-model.js';
import type { RunbookState } from './types.js';

/**
 * Whether a run participates in delegation or composition and therefore
 * requires named authority (`--run` / `--claim-id`) for mutations.
 *
 * `standalone` is the only exposure for which bare `direct_cli` evidence may
 * still map to run-controller trust. Exposure is sticky by construction for
 * every state-derived clause: delegation and inline substep-state records
 * (clauses d/f) never decay for the life of the run. The document-derived
 * static clauses (a and f's runbook-list signal) are re-parsed at decision
 * time — see the classifier TSDoc for the mid-run document-edit caveat.
 */
export type DelegationExposure = 'delegating' | 'standalone';

/** Input to {@link classifyDelegationExposure}. */
export interface DelegationExposureInput {
  /** Persisted run state for the run being classified. */
  readonly state: RunbookState;
  /** Resolved steps of the run's document (the seam's loadSteps result). */
  readonly steps: readonly ResolvedStep[];
  /** Open claimed children for this run (from listOpenClaimsForParent). */
  readonly openClaims: readonly ClaimRecord[];
}

/**
 * Classify a run's delegation exposure.
 *
 * A run is `delegating` iff any of: (a) its document authors a DELEGATE
 * substep; (b) it has open claimed children; (c) it has reported-but-
 * uncollected delegation outcomes; (d) any substep state carries a delegation
 * record (sticky history); (e) it carries parent linkage (inline or
 * delegation) — composed-pipeline stages are orchestrator-owned; (f) it
 * composes children inline — statically, any substep carries runbook-list
 * entries, or at runtime any substep state carries an inline launch record
 * (sticky, like d). Clauses (a) and (f-static) are recomputed from the parsed
 * document at decision time, so a mid-run edit of the runbook document can
 * flip a not-yet-issued run's static exposure; every state-derived clause is
 * monotone and never decays.
 *
 * @param input - State, parsed steps, and open claims for one run
 * @returns The run's delegation exposure
 */
export function classifyDelegationExposure(input: DelegationExposureInput): DelegationExposure {
  const { state, steps, openClaims } = input;
  if (openClaims.length > 0) return 'delegating';
  if (state.parentLinkage !== undefined) return 'delegating';
  if (
    state.substepStates?.some(
      (substep) => substep.delegation !== undefined || substep.inline !== undefined,
    )
  ) {
    return 'delegating';
  }
  if (readDelegationCollectionPendingForPolicy(state).pending) return 'delegating';
  if (
    steps.some(
      (step) =>
        resolvedStepHasSubsteps(step) &&
        step.substeps.some(
          (substep) => substep.delegate === true || (substep.runbooks?.length ?? 0) > 0,
        ),
    )
  ) {
    return 'delegating';
  }
  return 'standalone';
}
