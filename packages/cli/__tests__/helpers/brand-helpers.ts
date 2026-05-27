// __tests__/helpers/brand-helpers.ts
// Test-only producers for branded core types (FrameKey, EffectiveVars).
//
// Mirrors the precedent in `core/src/testing/effective-vars.ts`:
// production code goes through `buildFrameKey` / `mergeEffectiveVars` /
// `brandEffectiveVars`. Tests need ergonomic constructors that route
// through the same brand seam so the brand contract stays in one place.

import {
  brandEffectiveVars,
  brandInitialTemplateVars,
  brandStoredOutputs,
  assertRunId,
  assertDelegationTokenHash,
  buildFrameKey,
  type ArtifactRecord,
  type DelegationTokenHash,
  type EffectiveVars,
  type FrameKey,
  type InitialTemplateVars,
  type PublicArtifactValue,
  type RunId,
  type StoredOutputs,
  type TemplateVarValue,
  type TrustedArtifactArray,
  type TrustedArtifactRecord,
  type TrustedArtifactValue,
  type VariableValue,
} from '@rundown-org/core';
import {
  brandTrustedArtifactArrayForTest as coreBrandTrustedArtifactArrayForTest,
  brandTrustedArtifactRecordForTest as coreBrandTrustedArtifactRecordForTest,
  brandTrustedArtifactValueForTest as coreBrandTrustedArtifactValueForTest,
} from '@rundown-org/core/testing/effective-vars';

/**
 * Test-only producer of {@link FrameKey}.
 *
 * Delegates to the production `buildFrameKey`. Use for fixture
 * construction wherever a `FrameKey` is required (e.g. `parentFrameKey`
 * on `DelegationLinkage`, `targetFrameKey` on completion records).
 *
 * @param step - Step identifier (e.g. `"1"`, `"ErrorHandler"`)
 * @param iteration - Optional FOR loop iteration number
 * @returns Branded `FrameKey` (`"<step>|<iteration-or-empty>"`)
 */
export function brandFrameKeyForTest(step: string, iteration?: number): FrameKey {
  return buildFrameKey(step, iteration);
}

/**
 * Test-only producer of {@link DelegationTokenHash}.
 *
 * Delegates to the production assertion helper so test fixtures use the
 * same canonical hash validation as production code.
 *
 * @param hash - Candidate persisted delegation token hash
 * @returns Branded `DelegationTokenHash`
 * @throws {Error} If `hash` is not a canonical `sha256:<64 lowercase hex>` value
 */
export function brandDelegationTokenHashForTest(hash: string): DelegationTokenHash {
  return assertDelegationTokenHash(hash);
}

/**
 * Test-only producer of {@link RunId}.
 *
 * Delegates to the production assertion helper so test fixtures use the
 * same canonical run-id validation as production code.
 *
 * @param runId - Candidate persisted run id
 * @returns Branded `RunId`
 * @throws {Error} If `runId` is not a canonical `rd_<32 lowercase hex>` value
 */
export function brandRunIdForTest(runId: string): RunId {
  return assertRunId(runId);
}

/**
 * Test-only producer of {@link EffectiveVars} for fixture construction.
 *
 * Delegates to the production `brandEffectiveVars` so the brand contract
 * stays in one place. Use when a call site requires `EffectiveVars` but
 * the specific values aren't the subject of the test (e.g.
 * `vars: brandEffectiveVarsForTest()` on a `ContextSnapshot`).
 *
 * @param vars - Optional plain effective-var record to brand; defaults to empty
 * @returns Branded `EffectiveVars`
 */
export function brandEffectiveVarsForTest(
  vars: Readonly<Record<string, TemplateVarValue>> = {},
): EffectiveVars {
  return brandEffectiveVars(vars);
}

/**
 * Test-only producer of {@link InitialTemplateVars}.
 *
 * Delegates to the production `brandInitialTemplateVars`. Production
 * code goes through `brandInitialTemplateVars` at the Zod parse seam
 * or the `RunbookStateManager.create` boundary.
 *
 * @param vars - Optional plain template-variable record; defaults to empty
 * @returns Branded `InitialTemplateVars`
 */
export function brandInitialTemplateVarsForTest(
  vars: Readonly<Record<string, TemplateVarValue>> = {},
): InitialTemplateVars {
  return brandInitialTemplateVars(vars);
}

/**
 * Test-only producer of {@link StoredOutputs}.
 *
 * Delegates to the production `brandStoredOutputs`. Production code
 * goes through `brandStoredOutputs` at the Zod parse seam or the
 * `RunbookStateManager.create` / `update` boundary.
 *
 * @param vars - Optional plain stored-output record; defaults to empty
 * @returns Branded `StoredOutputs`
 */
export function brandStoredOutputsForTest(
  vars: Readonly<Record<string, VariableValue>> = {},
): StoredOutputs {
  return brandStoredOutputs(vars);
}

/**
 * Test-only producer of {@link TrustedArtifactRecord} for fixture construction.
 *
 * Re-exports the core test helper so CLI tests can mint trusted records
 * without crossing the package barrier (the production
 * `brandTrustedArtifactRecord` is intentionally not exported from
 * `@rundown-org/core`). Calls the runtime producer — fixtures satisfy
 * `isTrustedArtifactRecord` at runtime.
 *
 * @param record - Plain `ArtifactRecord` to brand
 * @returns The same record reference, now branded
 */
export function brandTrustedArtifactRecordForTest(record: ArtifactRecord): TrustedArtifactRecord {
  return coreBrandTrustedArtifactRecordForTest(record);
}

/**
 * Test-only producer of {@link TrustedArtifactArray} (container brand).
 *
 * Use for the empty-array (zero-match selector) case — `isTrustedArtifactArray`
 * checks the container brand, so a bare `[]` returns `false`.
 *
 * @param records - Records (may be empty)
 * @returns The same array reference, now branded
 */
export function brandTrustedArtifactArrayForTest(
  records: readonly ArtifactRecord[],
): TrustedArtifactArray {
  return coreBrandTrustedArtifactArrayForTest(records);
}

/**
 * Test-only producer of {@link TrustedArtifactValue} — dispatches on shape.
 *
 * @param value - Single `ArtifactRecord` or readonly `ArtifactRecord[]`
 * @returns The same value reference, branded
 */
export function brandTrustedArtifactValueForTest(value: PublicArtifactValue): TrustedArtifactValue {
  return coreBrandTrustedArtifactValueForTest(value);
}
