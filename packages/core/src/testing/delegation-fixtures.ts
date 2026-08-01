/**
 * Typed fixture factories for parent-side delegation state.
 *
 * Shipped rather than test-local because both packages need them: a delegated
 * parent's substep row is what {@link classifyDelegationLiveness} classifies
 * against, so any fixture standing in for a delegating parent must carry one.
 * Hand-writing that shape in a `seedRawRunState` payload type-checks as
 * `Record<string, unknown>` and is only validated when the state is read back,
 * so a missing or invented field surfaces as a downstream refusal (a claim that
 * reads `cursor-advanced`, a `pop` that exits 1) rather than an error naming the
 * bad field. These factories make that a compile error instead.
 *
 * @module testing/delegation-fixtures
 */

import type { ContextSnapshot, StepDelegation, SubstepState } from '../runbook/types.js';
import {
  assertClaimLookupKey,
  generateClaimBearer,
  parseClaimBearer,
} from '../runbook/claim-id.js';
import {
  createDelegationCredentialIssuer,
  type DelegationCredentialIssuer,
} from '../runbook/delegation-credential.js';
import {
  assertDelegationIssuanceNonce,
  assertDelegationTokenHash,
  type DelegationCredentialDescriptor,
} from '../runbook/delegation-token.js';
import { assertRunId } from '../runbook/run-id.js';
import { buildFrameKey, type FrameKey } from '../runbook/targeting.js';
import { brandEffectiveVarsForTest } from './effective-vars.js';

/** Token hash used by every fixture that does not name its own. */
const DEFAULT_TOKEN_HASH = `sha256:${'a'.repeat(64)}`;

/**
 * Build a non-secret delegation credential descriptor with valid canonical coordinates.
 *
 * @param partial - Overrides for any credential descriptor field.
 * @returns A valid credential descriptor.
 */
export function makeDelegationCredentialDescriptor(
  partial: Partial<DelegationCredentialDescriptor> = {},
): DelegationCredentialDescriptor {
  return {
    version: 1,
    issuerClaimKey: assertClaimLookupKey(`rdclk_${'b'.repeat(32)}`),
    issuanceNonce: assertDelegationIssuanceNonce('A'.repeat(43)),
    parentRunId: assertRunId(`rd_${'c'.repeat(32)}`),
    parentStepId: '1.1',
    parentFrameKey: buildFrameKey('1'),
    parentEntry: 1,
    ...partial,
  };
}

/**
 * Build a claim-bound credential issuer for delegation primitive tests.
 *
 * @returns A fresh issuer whose bearer remains local to the test process.
 */
export function makeDelegationCredentialIssuer(): DelegationCredentialIssuer {
  const parsed = parseClaimBearer(generateClaimBearer());
  return createDelegationCredentialIssuer({
    kind: 'bearer',
    claimId: parsed.claimId,
    claimKey: parsed.claimKey,
  });
}

/**
 * Build a `ContextSnapshot` with a branded empty `EffectiveVars`.
 *
 * `vars` is brand-protected so it cannot be populated by a hand-rolled record;
 * this is the sanctioned way for a fixture to satisfy it.
 *
 * @param partial - Overrides for snapshot fields.
 * @returns A valid `ContextSnapshot` with required fields filled.
 */
export function makeContextSnapshot(partial: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    vars: brandEffectiveVarsForTest({}),
    ancestors: [],
    ...partial,
  };
}

/**
 * Build a `StepDelegation` with every required field filled.
 *
 * @param partial - Overrides for any StepDelegation field.
 * @returns A valid `StepDelegation`.
 */
export function makeStepDelegation(partial: Partial<StepDelegation> = {}): StepDelegation {
  return {
    credential: makeDelegationCredentialDescriptor(),
    tokenHash: assertDelegationTokenHash(DEFAULT_TOKEN_HASH),
    childRunbookPath: 'child.md',
    childRunbookRef: { source: 'project', path: 'child.md' },
    contextSnapshot: makeContextSnapshot(),
    childRunId: null,
    createdAt: '2026-02-27T10:00:00.000Z',
    cancelledAt: null,
    ...partial,
  };
}

/** Inputs for {@link makeDelegatedSubstepState}. */
export interface DelegatedSubstepOptions {
  /** Substep id the delegation occupies (e.g. `'1.1'`, or `'1'` for a bare step). */
  readonly id: string;
  /** Frame key of the parent's execution frame; defaults to the frame of `id`'s step. */
  readonly frameKey?: FrameKey;
  /** Substep status; defaults to `running` (an open delegation). */
  readonly status?: SubstepState['status'];
  /** Delegation overrides, e.g. a specific `tokenHash` matching a claim fixture. */
  readonly delegation?: Partial<StepDelegation>;
}

/**
 * Build the parent-side substep row an open delegation writes.
 *
 * This is the row a delegated claim's liveness is decided against: without it, a
 * parent is indistinguishable from one whose cursor advanced past the
 * delegation, and every claim against it is correctly refused as superseded.
 * Fixtures standing in for a delegating parent must include it.
 *
 * @param options - Substep id, frame, status, and delegation overrides.
 * @returns A `SubstepState` carrying a valid delegation.
 */
export function makeDelegatedSubstepState(options: DelegatedSubstepOptions): SubstepState {
  const step = options.id.split('.')[0] ?? options.id;
  return {
    id: options.id,
    frameKey: options.frameKey ?? buildFrameKey(step),
    status: options.status ?? 'running',
    delegation: makeStepDelegation(options.delegation),
  };
}
