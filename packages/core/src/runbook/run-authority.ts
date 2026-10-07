/**
 * Run authority under one writer per run (#901, ADR 0005).
 *
 * Two decisions the frontends must not make for themselves:
 *
 * - {@link resolveOwnedRun} — the ONLY way a mutating command names its run.
 *   An Owner Token resolves to the run it owns, together with the row version
 *   a later save must name; a run id authorizes nothing.
 * - {@link findUnsupportedComposition} — whether a runbook composes other
 *   runbooks, which T1 does not run. Inline composition returns in #903 and
 *   delegation in #904; until then `rundown run` refuses such a runbook and
 *   the CLI only renders the ids this function names.
 *
 * @module runbook/run-authority
 */

import { resolvedStepHasSubsteps, type ResolvedStep } from '@rundown-org/parser';
import { hashRunSecret, type OwnerToken } from './run-secrets.js';
import type { RunbookStateManager } from './state.js';
import type { StateVersion } from './storage/mutation-result.js';
import type { Lifecycle, RunbookState } from './types.js';

/**
 * A running run resolved by its Owner Token.
 *
 * Carries the `state_version` the state was read at, so the seam that
 * mutates it can hand that version to `save` and have a concurrent write
 * refused rather than overwritten.
 */
export interface OwnedRun {
  /** The validated run state. */
  readonly state: RunbookState;
  /** The row's version at read time; the expectation a later save names. */
  readonly stateVersion: StateVersion;
}

/** A lifecycle a finished run can carry. */
export type FinishedLifecycle = Exclude<Lifecycle, 'running'>;

/** Outcome of {@link resolveOwnedRun}. */
export type OwnedRunResolution =
  | {
      /** The token owns a running run. */
      readonly kind: 'running';
      readonly run: OwnedRun;
    }
  | {
      /** The token owns a run that already finished; the caller is told how. */
      readonly kind: 'finished';
      readonly state: RunbookState;
      readonly lifecycle: FinishedLifecycle;
    }
  | {
      /** No run carries the token's hash. */
      readonly kind: 'unknown_token';
    };

/**
 * Resolve an Owner Token to the run it owns.
 *
 * The token is hashed here and only the hash reaches the store; the plaintext
 * never appears in a message or a row. A run whose lifecycle is anything but
 * `running` resolves as `finished` so a late command on it can be told the
 * run finished (RD-303 / RD-304 at the CLI) instead of being applied.
 *
 * @param manager - State manager for the project
 * @param token - The presented Owner Token, already parsed by the frontend
 * @returns The owned run with its version, the finished run, or `unknown_token`
 * @throws {InvalidRunbookStateError} When the matching row fails the
 *   persisted-state gates or the structural parse — raised by the manager's
 *   lookup, not tested here
 */
export async function resolveOwnedRun(
  manager: RunbookStateManager,
  token: OwnerToken,
): Promise<OwnedRunResolution> {
  const owned = await manager.findByOwnerTokenHash(hashRunSecret(token));
  if (owned === null) return { kind: 'unknown_token' };
  const lifecycle = owned.state.lifecycle ?? 'running';
  if (lifecycle !== 'running') {
    return { kind: 'finished', state: owned.state, lifecycle };
  }
  return { kind: 'running', run: { state: owned.state, stateVersion: owned.stateVersion } };
}

/**
 * Name every substep that composes another runbook.
 *
 * A substep composes when it is authored `DELEGATE` or carries a non-empty
 * runbook list — the two predicates the compiler used to route into
 * delegation issuance and inline launch before #901 removed both. Ids are
 * qualified (`step.substep`) and returned in document order so the refusal
 * can list them verbatim.
 *
 * @param steps - Parsed runbook steps
 * @returns Qualified ids of the composing substeps; empty when the runbook
 *   composes nothing
 */
export function findUnsupportedComposition(steps: readonly ResolvedStep[]): readonly string[] {
  const ids: string[] = [];
  for (const step of steps) {
    if (!resolvedStepHasSubsteps(step)) continue;
    for (const substep of step.substeps) {
      const composes =
        substep.delegate === true ||
        (Array.isArray(substep.runbooks) && substep.runbooks.length > 0);
      if (composes) ids.push(`${step.name}.${substep.id}`);
    }
  }
  return ids;
}
