import { describe, expect, it } from '@jest/globals';
import {
  mintInlineCompositionProgressionAuthority,
  mintRunProgressionAuthority,
} from '../../src/runbook/run-progression-authority.js';
import { claimKeyFromBearer, generateClaimBearer } from '../../src/runbook/claim-id.js';
import type { DelegationRuntimeCapabilities } from '../../src/runbook/delegation-credential.js';
import { brandRunIdForTest } from '../../src/testing/effective-vars.js';

// The two optional halves of a progression authority are OMITTED, never present
// and undefined. Nothing at runtime can tell the two apart — `authority.claimKey`
// reads `undefined` either way — so only the own-key check pins it. It is
// load-bearing at the type level: `claimKey?: ClaimLookupKey` under
// `exactOptionalPropertyTypes` accepts an absent key and rejects an explicit
// `undefined`, so a mint that stamped the key would spread into a shape the
// consuming seams' types say cannot exist.

const RUN_ID = brandRunIdForTest('rd_cccccccccccccccccccccccccccccccc');

/** Delegation capabilities are opaque to the mint: it binds them, it never reads them. */
const DELEGATION_RUNTIME = {
  issueDelegationCredential: () => {
    throw new Error('not called');
  },
} as unknown as DelegationRuntimeCapabilities;

describe('mintRunProgressionAuthority', () => {
  it('omits claimKey entirely for an authorized bare caller', () => {
    const authority = mintRunProgressionAuthority({ runId: RUN_ID });

    expect(Object.hasOwn(authority, 'claimKey')).toBe(false);
    expect(authority.runId).toBe(RUN_ID);
  });

  it('binds the presented claim key when the continuation is claim-authenticated', () => {
    const claimKey = claimKeyFromBearer(generateClaimBearer());

    const authority = mintRunProgressionAuthority({ runId: RUN_ID, claimKey });

    expect(Object.hasOwn(authority, 'claimKey')).toBe(true);
    expect(authority.claimKey).toBe(claimKey);
  });

  it('omits delegationRuntime entirely when the caller presented no delegation authority', () => {
    const authority = mintRunProgressionAuthority({ runId: RUN_ID });

    expect(Object.hasOwn(authority, 'delegationRuntime')).toBe(false);
  });

  it('binds verified delegation capabilities when the seam derived them', () => {
    const authority = mintRunProgressionAuthority({
      runId: RUN_ID,
      delegationRuntime: DELEGATION_RUNTIME,
    });

    expect(Object.hasOwn(authority, 'delegationRuntime')).toBe(true);
    expect(authority.delegationRuntime).toBe(DELEGATION_RUNTIME);
  });
});

describe('mintInlineCompositionProgressionAuthority', () => {
  it('authorizes only the composing parent, carrying neither claim key nor delegation runtime', () => {
    // Inline composition is not bearer authority. A parent reached this way that
    // hits a DELEGATE turn must still be refused, and the absent capabilities
    // are what makes that refusal structural rather than a check someone added.
    const authority = mintInlineCompositionProgressionAuthority(RUN_ID);

    expect(authority.runId).toBe(RUN_ID);
    expect(Object.hasOwn(authority, 'claimKey')).toBe(false);
    expect(Object.hasOwn(authority, 'delegationRuntime')).toBe(false);
  });
});
