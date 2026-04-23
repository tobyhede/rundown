import type { InitialTemplateVars, StoredOutputs } from '../../src/runbook/effective-vars.js';
import type { TemplateVarValue } from '../../src/runbook/types.js';

/**
 * Test-only producer of {@link InitialTemplateVars} for fixture construction.
 *
 * Production code MUST go through `brandInitialTemplateVars` at the Zod
 * parse seam or the RunbookStateManager.create boundary. This helper exists
 * so RunbookState fixture builders can populate `templateVars` without each
 * test re-implementing the cast.
 */
export function brandInitialTemplateVarsForTest(
  vars: Readonly<Record<string, TemplateVarValue>>,
): InitialTemplateVars {
  return vars as InitialTemplateVars;
}

/**
 * Test-only producer of {@link StoredOutputs} for fixture construction.
 *
 * Production code MUST go through `brandStoredOutputs` at the Zod parse
 * seam or the RunbookStateManager.create / update boundary. This helper
 * exists so RunbookState fixture builders can populate `variables` without
 * each test re-implementing the cast.
 */
export function brandStoredOutputsForTest(vars: Readonly<Record<string, string>>): StoredOutputs {
  return vars as StoredOutputs;
}
