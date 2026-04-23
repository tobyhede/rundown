import {
  brandInitialTemplateVars,
  brandStoredOutputs,
  type InitialTemplateVars,
  type StoredOutputs,
} from '../../src/runbook/effective-vars.js';
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
export function brandStoredOutputsForTest(vars: Readonly<Record<string, string>>): StoredOutputs {
  return brandStoredOutputs(vars);
}
