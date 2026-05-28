/**
 * @packageDocumentation
 *
 * Test-only producers for branded core types.
 *
 * Lives in `src/testing/` so it builds into `dist/testing/` and is reachable
 * from sibling packages via the `@rundown-org/core/testing/effective-vars`
 * subpath export. INTERNAL/TEST USE ONLY — intentionally NOT re-exported
 * from `src/index.ts` and intentionally undocumented in the public barrel.
 * Consumers outside `@rundown-org/core` should treat this module as an
 * internal test-affordance, not a stable API.
 *
 * Routing the producers through `dist/testing/effective-vars.js` keeps a
 * single module identity for the trust brand: tsc resolution from
 * `@rundown-org/core` (dist barrel) and from
 * `@rundown-org/core/testing/effective-vars` (this subpath) converge on the
 * same compiled `.d.ts`, so the `unique symbol` brand declared in
 * `src/runbook/effective-vars.ts` remains nominally identical across both
 * resolutions. The runtime symbol `trustedArtifactBrand` stays
 * module-private inside `src/runbook/effective-vars.ts`; consumers go
 * through the test producers below so the brand contract stays in one
 * place.
 */
import {
  brandEffectiveVars,
  brandInitialTemplateVars,
  brandStoredOutputs,
  brandTrustedArtifactArray,
  brandTrustedArtifactRecord,
  brandTrustedArtifactValue,
  type EffectiveVars,
  type InitialTemplateVars,
  type PublicArtifactValue,
  type StoredOutputs,
  type TrustedArtifactArray,
  type TrustedArtifactRecord,
  type TrustedArtifactValue,
  type VariableValue,
} from '../runbook/effective-vars.js';
import type { ArtifactRecord } from '../runbook/artifact-schema.js';
import { assertRunId, type RunId } from '../runbook/run-id.js';
import { flattenTemplateVars, type FlattenedTemplateVars } from '../runbook/output-evaluator.js';
import type { TemplateVarValue } from '../runbook/types.js';

/**
 * Test-only producer of {@link InitialTemplateVars} for fixture construction.
 *
 * Delegates to the production `brandInitialTemplateVars`, which is itself an
 * identity cast — so behaviour is unchanged but the brand contract stays in
 * one place. Production code MUST also go through `brandInitialTemplateVars`
 * at the Zod parse seam or the RunbookStateManager.create boundary.
 *
 * @param vars - Plain template-variable record to brand.
 * @returns The same record typed as `InitialTemplateVars`.
 */
export function brandInitialTemplateVarsForTest(
  vars: Readonly<Record<string, TemplateVarValue>>,
): InitialTemplateVars {
  return brandInitialTemplateVars(vars);
}

/**
 * Test-only producer of {@link StoredOutputs} for fixture construction.
 *
 * Delegates to the production `brandStoredOutputs`, which is itself an
 * identity cast — so behaviour is unchanged but the brand contract stays in
 * one place. Production code MUST also go through `brandStoredOutputs` at
 * the Zod parse seam or the RunbookStateManager.create / update boundary.
 *
 * @param vars - Plain stored-output record to brand.
 * @returns The same record typed as `StoredOutputs`.
 */
export function brandStoredOutputsForTest(
  vars: Readonly<Record<string, VariableValue>>,
): StoredOutputs {
  return brandStoredOutputs(vars);
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
 * stays in one place. Production code MUST go through `mergeEffectiveVars`
 * at the actor-boundary seam; tests only need to hand the brand to fixture
 * builders.
 *
 * @param vars - Optional plain effective-var record to brand; defaults to empty.
 * @returns The same record typed as `EffectiveVars`.
 */
export function brandEffectiveVarsForTest(
  vars: Readonly<Record<string, TemplateVarValue>> = {},
): EffectiveVars {
  return brandEffectiveVars(vars);
}

/**
 * Test-only producer of {@link FlattenedTemplateVars} for fixture construction.
 *
 * Delegates to the production `flattenTemplateVars` so the brand contract
 * stays in one place (per the doc comment on `flattenTemplateVars`, that
 * function is the sole sanctioned brand producer). Use when a call site
 * requires `FlattenedTemplateVars` but the specific values aren't the
 * subject of the test (e.g. passing `{}` to `compileRunbookToMachine(steps,
 * { templateVars })`).
 *
 * @param vars - Optional template vars; defaults to empty.
 * @returns Branded `FlattenedTemplateVars`.
 */
export function brandFlattenedTemplateVarsForTest(
  vars: Readonly<Record<string, TemplateVarValue>> = {},
): FlattenedTemplateVars {
  return flattenTemplateVars(vars);
}

/**
 * Test-only producer of a single {@link TrustedArtifactRecord} for fixture
 * construction.
 *
 * Calls the production `brandTrustedArtifactRecord`, which attaches the
 * runtime brand symbol via `Object.defineProperty`. Fixtures constructed
 * via this helper satisfy `isTrustedArtifactRecord` at runtime — type-only
 * casts would silently break every brand-path test.
 *
 * @param record - Plain `ArtifactRecord` to brand
 * @returns The same record reference, now carrying the trusted-artifact brand
 */
export function brandTrustedArtifactRecordForTest(record: ArtifactRecord): TrustedArtifactRecord {
  return brandTrustedArtifactRecord(record);
}

/**
 * Test-only producer of a {@link TrustedArtifactArray} (container brand).
 *
 * Use this for the empty-array case as well — `isTrustedArtifactArray([])`
 * is `false` for a forged `[]`, so tests that simulate the zero-match
 * selector path MUST construct the empty array via this helper.
 *
 * @param records - Records (may be empty)
 * @returns The same array reference, now carrying the trusted-artifact brand
 */
export function brandTrustedArtifactArrayForTest(
  records: readonly ArtifactRecord[],
): TrustedArtifactArray {
  return brandTrustedArtifactArray(records);
}

/**
 * Test-only producer of a {@link TrustedArtifactValue} — dispatches on shape.
 *
 * @param value - Single `ArtifactRecord` or readonly `ArtifactRecord[]`
 * @returns The same value reference, branded
 */
export function brandTrustedArtifactValueForTest(value: PublicArtifactValue): TrustedArtifactValue {
  return brandTrustedArtifactValue(value);
}
