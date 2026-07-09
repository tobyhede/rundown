import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import type { ResolvedStep, Substep } from '@rundown-org/parser';
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
 * Split of a run's exposure into its two independent axes.
 *
 * The distinction matters because the two axes gate mutations differently:
 * `delegation` exposure requires named authority for *every* mutation, whereas
 * `inlineComposition` exposure is the contiguous inline chain the terminal path
 * (`complete`/`stop`) is designed to force as a unit with a bare command. A run
 * may be both at once (an inline stage that itself delegates).
 */
export interface DelegationExposureDetail {
  /**
   * True when the run delegates work to independently-authored children —
   * clauses: (a) authored DELEGATE substep; (b) open claimed children; (c)
   * reported-but-uncollected outcomes; (d) sticky substep-state delegation
   * record; (e) delegation parent linkage.
   */
  readonly delegation: boolean;
  /**
   * True when the run composes children inline — clauses: (e) inline parent
   * linkage; (d) sticky substep-state inline record; (f) authored runbook-list
   * substep.
   */
  readonly inlineComposition: boolean;
}

/**
 * Classify a run's exposure along both axes independently.
 *
 * Delegation and inline-composition clauses are recomputed here; the
 * document-derived static clauses ((a) DELEGATE substep and (f) runbook-list)
 * are re-parsed from `steps` at decision time, so a mid-run document edit can
 * flip a not-yet-issued run's static exposure. Every state-derived clause is
 * monotone and never decays.
 *
 * @param input - State, parsed steps, and open claims for one run
 * @returns The run's exposure split into delegation and inline-composition axes
 */
export function classifyDelegationExposureDetail(
  input: DelegationExposureInput,
): DelegationExposureDetail {
  const { state, steps, openClaims } = input;
  const substepStates = state.substepStates ?? [];
  const anyAuthoredSubstep = (predicate: (substep: Substep) => boolean): boolean =>
    steps.some((step) => resolvedStepHasSubsteps(step) && step.substeps.some(predicate));

  const delegation =
    openClaims.length > 0 ||
    state.parentLinkage?.kind === 'delegation' ||
    substepStates.some((substep) => substep.delegation !== undefined) ||
    readDelegationCollectionPendingForPolicy(state).pending ||
    anyAuthoredSubstep((substep) => substep.delegate === true);

  const inlineComposition =
    state.parentLinkage?.kind === 'inline' ||
    substepStates.some((substep) => substep.inline !== undefined) ||
    anyAuthoredSubstep((substep) => (substep.runbooks?.length ?? 0) > 0);

  return { delegation, inlineComposition };
}

/**
 * Classify a run's delegation exposure.
 *
 * A run is `delegating` iff it is exposed on either axis reported by
 * {@link classifyDelegationExposureDetail} — any of: (a) its document authors a
 * DELEGATE substep; (b) it has open claimed children; (c) it has reported-but-
 * uncollected delegation outcomes; (d) any substep state carries a delegation
 * or inline record (sticky history); (e) it carries parent linkage (inline or
 * delegation) — composed-pipeline stages are orchestrator-owned; (f) it
 * composes children inline via runbook-list entries. This is the union used by
 * pass/fail/goto to refuse *any* bare mutation on a non-standalone run;
 * terminal-force consults the `delegation` axis alone so it can still force an
 * inline chain bare.
 *
 * @param input - State, parsed steps, and open claims for one run
 * @returns The run's delegation exposure
 */
export function classifyDelegationExposure(input: DelegationExposureInput): DelegationExposure {
  const { delegation, inlineComposition } = classifyDelegationExposureDetail(input);
  return delegation || inlineComposition ? 'delegating' : 'standalone';
}
