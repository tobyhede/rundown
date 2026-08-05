// __tests__/helpers/delegation-runtime-helpers.ts
// The ONE place the CLI test tree fabricates a `DelegationRuntimeCapabilities`.
//
// The production type carries a module-private `unique symbol` brand whose only
// producer is `delegationRuntimeCapabilities(authority)` in
// `packages/core/src/runbook/delegation-credential.ts`. The brand is the point:
// it proves both callables were bound to the SAME verified authority, so no
// consumer can assemble a pair out of two unrelated claims and no shape can
// express one half alone. An object literal therefore cannot satisfy it from
// outside that module, which is exactly the invariant the consolidation exists
// to enforce.
//
// CLI suites still need mock functions rather than real claim-derived closures:
// they assert on call identity (`toBe(issueDelegationCredential)`), and most of
// them replace `@rundown-org/core` wholesale with `jest.unstable_mockModule`, so
// the real producer is not even reachable from them. The escape hatch is one
// cast, concentrated here rather than scattered across four suites — a cast per
// call site would reintroduce, one file at a time, precisely the freedom the
// brand removes.
//
// Both halves are REQUIRED here, mirroring the production interface: a test
// double must not be able to express a one-sided pair the type forbids.

import type {
  DelegationCredentialIssuer,
  DelegationRuntimeCapabilities,
  DelegationTokenDeriver,
} from '@rundown-org/core';

/** The two callables a `DelegationRuntimeCapabilities` double stands in for. */
export interface DelegationRuntimeDoubleParts {
  /** Stand-in for the authority's credential issuer. */
  readonly issueDelegationCredential: DelegationCredentialIssuer;
  /** Stand-in for the same authority's token deriver. */
  readonly deriveDelegationToken: DelegationTokenDeriver;
}

/**
 * Brand a mock issuer/deriver pair as `DelegationRuntimeCapabilities`.
 *
 * The single sanctioned cast past the module-private brand. Use it only where a
 * test needs jest mock functions to observe calls or identities; where a suite
 * can reach the real `delegationRuntimeCapabilities` producer, prefer that, so
 * the same-authority pairing is exercised rather than asserted.
 *
 * @param parts - Both capabilities, exactly as the production interface requires.
 * @returns The same object reference, typed as the branded pair.
 */
export function delegationRuntimeDouble(
  parts: DelegationRuntimeDoubleParts,
): DelegationRuntimeCapabilities {
  return parts as unknown as DelegationRuntimeCapabilities;
}

/**
 * An issuer half that fails loudly if the code under test ever invokes it.
 *
 * For sites that exercise only the derivation half — projecting a frontier that
 * was already persisted — where the branded pair still has to carry an issuer.
 * A throwing stand-in keeps that half honest: it makes "issuance never happens
 * on this path" an assertion rather than a silent `jest.fn()` no-op.
 *
 * @returns An issuer that throws on any call.
 */
export function unusedDelegationCredentialIssuer(): DelegationCredentialIssuer {
  return () => {
    throw new Error('Unexpected delegation credential issuance');
  };
}

/**
 * A deriver half that fails loudly if the code under test ever invokes it.
 *
 * The mirror of {@link unusedDelegationCredentialIssuer}, for sites that
 * exercise only issuance.
 *
 * @returns A deriver that throws on any call.
 */
export function unusedDelegationTokenDeriver(): DelegationTokenDeriver {
  return () => {
    throw new Error('Unexpected delegation token derivation');
  };
}
