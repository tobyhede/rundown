// __tests__/helpers/brand-helpers.ts
// Test-only producers for branded core types (FrameKey, EffectiveVars).
//
// Mirrors the precedent in `core/__tests__/helpers/effective-vars.ts`:
// production code goes through `buildFrameKey` / `mergeEffectiveVars` /
// `brandEffectiveVars`. Tests need ergonomic constructors that route
// through the same brand seam so the brand contract stays in one place.

import {
  brandEffectiveVars,
  brandInitialTemplateVars,
  brandStoredOutputs,
  assertDelegationTokenHash,
  buildAgentOwnerKey,
  buildFrameKey,
  type AgentOwnerIdentity,
  type AgentOwnerKey,
  type DelegationTokenHash,
  type EffectiveVars,
  type FrameKey,
  type InitialTemplateVars,
  type StoredOutputs,
  type TemplateVarValue,
} from '@rundown-org/core';

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
 * Test-only producer of {@link AgentOwnerKey}.
 *
 * Delegates to the production owner-key builder so fixtures use the same
 * stable key derivation as session ownership code.
 *
 * @param identity - Agent identity used to derive the persisted owner key
 * @returns Branded `AgentOwnerKey`
 */
export function brandAgentOwnerKeyForTest(identity: AgentOwnerIdentity): AgentOwnerKey {
  return buildAgentOwnerKey(identity);
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
  vars: Readonly<Record<string, string>> = {},
): StoredOutputs {
  return brandStoredOutputs(vars);
}
