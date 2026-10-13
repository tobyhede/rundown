/**
 * Run authority under one writer per run (#901, ADR 0005).
 *
 * Two decisions the frontends must not make for themselves:
 *
 * - {@link resolveOwnedRun} — the ONLY way a mutating command names its run.
 *   An Owner Token resolves to the run it owns, together with the row version
 *   a later save must name; a run id authorizes nothing.
 * - {@link findUnsupportedComposition} — whether a runbook composes other
 *   runbooks in a form this build does not run: a substep listing more than
 *   one runbook. Inline Children (#903) and Delegations (#904) run.
 *   `RunbookStateManager.create` — the seam every run, child runs included,
 *   is created through — refuses such a runbook with
 *   {@link RunbookCompositionUnsupportedError} before writing a row, and a
 *   frontend only renders the ids the refusal names.
 *
 * @module runbook/run-authority
 */

import type { ResolvedStep, Step } from '@rundown-org/parser';
import { hashRunSecret, type OwnerToken } from './run-secrets.js';
import type { RunbookStateManager } from './state.js';
import type { StateVersion } from './storage/mutation-result.js';
import type { ExecutionLease } from './execution-lease.js';
import type { Lifecycle, RunbookState } from './types.js';
import type { ChildLinkage } from './child-linkage.js';

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
  /**
   * The execution lease the row carried at that version, or null. A save at
   * `stateVersion` clears it, so the seam applies the lease rule first (#902).
   */
  readonly lease: ExecutionLease | null;
  /**
   * The parent coordinate the run's row records, or null for a top-level run.
   * An Inline Child target carries its linkage (#903).
   */
  readonly linkage: ChildLinkage | null;
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
  return { kind: 'running', run: owned };
}

/**
 * Name every substep whose composition this build does not run.
 *
 * A runbook-list substep naming exactly one runbook runs it as a Child Run:
 * an Inline Child (#903), or a Delegation when it is `DELEGATE` (#904). A
 * substep listing more than one runbook does not run: the machine reserves
 * one Current Child per substep, so it would have to compose several children
 * for one unit. Ids are qualified (`step.substep`) and returned in document
 * order so the refusal can list them verbatim.
 *
 * Accepts parsed or resolved steps: `rundown check` warns from the parsed
 * runbook, `rundown run` refuses from the resolved one, and both must name
 * the same substeps.
 *
 * @param steps - Parsed or resolved runbook steps
 * @returns Qualified ids of the substeps this build does not run; empty when
 *   every composing substep names a single runbook
 */
export function findUnsupportedComposition(
  steps: readonly (Step | ResolvedStep)[],
): readonly string[] {
  const ids: string[] = [];
  for (const step of steps) {
    if (!('substeps' in step)) continue;
    for (const substep of step.substeps) {
      if ((substep.runbooks?.length ?? 0) > 1) ids.push(`${step.name}.${substep.id}`);
    }
  }
  return ids;
}

/**
 * Raised when a run would be created for a runbook whose composition this
 * build does not run (see {@link findUnsupportedComposition}). A child run
 * whose runbook composes that way is refused the same way.
 *
 * Thrown by {@link RunbookStateManager.create} before any store access, so a
 * refused runbook leaves no run row behind. Frontends render it; they do not
 * decide it.
 */
export class RunbookCompositionUnsupportedError extends Error {
  /** Qualified ids of the composing substeps, in document order. */
  readonly substeps: readonly string[];

  /**
   * Construct a composition refusal.
   *
   * @param substeps - Qualified unsupported substep ids from
   *   {@link findUnsupportedComposition}; never empty
   */
  constructor(substeps: readonly string[]) {
    super(
      `Runbook composes other runbooks in a form this build does not run at ${substeps.join(', ')}`,
    );
    this.name = 'RunbookCompositionUnsupportedError';
    this.substeps = substeps;
  }
}
