/**
 * Canonical refusal-kind → symbolic-code maps for storage-layer refusals.
 *
 * Core owns the refusal kinds ({@link GuardedMutationResult},
 * {@link SessionMutationRefusal}, {@link AbandonedAttemptSetOutcome}), so core
 * owns the one mapping from each kind to the registered symbolic code it is
 * reported under. Before this module the mapping lived twice — the CLI's
 * `session-mutation-result.ts` switch and core's Run Progression activation —
 * and a remapped code string would have changed one seam's reporting without
 * the other's.
 *
 * Frontends that must not value-import the core barrel (the CLI's
 * `session-mutation-result.ts` is loaded under partial barrel mocks in many
 * suites) restate the object literal locally and check it with
 * `satisfies TransactionalRefusalCodeByKind` / `satisfies
 * SessionRefusalCodeByKind`: the `typeof`-derived types pin every key AND every
 * literal value, so a divergent restatement fails to compile while the runtime
 * import graph stays type-only.
 *
 * @module runbook/storage/refusal-codes
 */

import type { AbandonedAttemptSetOutcome } from './execution-lease.js';
import type { GuardedMutationResult } from './mutation-result.js';
import type { SessionMutationRefusal } from './runbook-store.js';

/**
 * The one session-ownership refusal kind → code mapping.
 *
 * Keys are exhaustive over {@link SessionMutationRefusal} by the `satisfies`
 * check: a kind added to the union fails compilation here until it is mapped,
 * rather than silently falling into a default arm somewhere downstream.
 */
export const SESSION_REFUSAL_CODE_BY_KIND = {
  execution_in_progress: 'EXECUTION_IN_PROGRESS',
  recovery_required: 'RECOVERY_REQUIRED',
} as const satisfies Record<SessionMutationRefusal['kind'], string>;

/**
 * Shape of {@link SESSION_REFUSAL_CODE_BY_KIND}, for compile-time-only
 * derivations in frontends that restate the literal (see the module doc).
 */
export type SessionRefusalCodeByKind = typeof SESSION_REFUSAL_CODE_BY_KIND;

/**
 * The one transactional refusal kind → code mapping: every non-committed
 * {@link GuardedMutationResult} arm plus the aggregate lease-recovery arm.
 *
 * `AGGREGATE_RECOVERY_REQUIRED` stays distinct from the single-run
 * `RECOVERY_REQUIRED`: only the aggregate arm carries `details.runs`, so an
 * agent routing on `code` can tell the two envelope shapes apart without
 * inspecting `details`.
 */
export const TRANSACTIONAL_REFUSAL_CODE_BY_KIND = {
  ...SESSION_REFUSAL_CODE_BY_KIND,
  claim_superseded: 'STALE_CLAIM',
  concurrent_modification: 'CONCURRENT_MODIFICATION',
  missing: 'RUN_TARGET_UNAVAILABLE',
  aggregate_recovery_required: 'AGGREGATE_RECOVERY_REQUIRED',
} as const satisfies Record<
  | Exclude<GuardedMutationResult<never>, { readonly kind: 'committed' }>['kind']
  | AbandonedAttemptSetOutcome['kind'],
  string
>;

/**
 * Shape of {@link TRANSACTIONAL_REFUSAL_CODE_BY_KIND}, for compile-time-only
 * derivations in frontends that restate the literal (see the module doc).
 */
export type TransactionalRefusalCodeByKind = typeof TRANSACTIONAL_REFUSAL_CODE_BY_KIND;
