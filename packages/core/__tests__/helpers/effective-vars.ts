import {
  brandEffectiveVars,
  brandInitialTemplateVars,
  brandStoredOutputs,
  type EffectiveVars,
  type InitialTemplateVars,
  type StoredOutputs,
  type VariableValue,
} from '../../src/runbook/effective-vars.js';
import { assertRunId, type RunId } from '../../src/runbook/run-id.js';
import {
  flattenTemplateVars,
  type FlattenedTemplateVars,
} from '../../src/runbook/output-evaluator.js';
import type { TemplateVarValue } from '../../src/runbook/types.js';

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
