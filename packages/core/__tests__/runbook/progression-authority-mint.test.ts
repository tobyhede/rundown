import { describe, expect, it } from '@jest/globals';
import { mintRunProgressionAuthority } from '../../src/runbook/run-progression-authority.js';
import { brandRunIdForTest } from '../../src/testing/effective-vars.js';

// After ADR 0005 the authority carries exactly one fact: the run it may drive.
// The claim key and delegation capabilities it used to bind went with the
// multi-writer model, so the mint must not grow optional halves back by
// accident — a frontend reading `authority.claimKey` would get `undefined`
// either way, and only the own-key check distinguishes "absent" from "stamped".

const RUN_ID = brandRunIdForTest('rd_cccccccccccccccccccccccccccccccc');

describe('mintRunProgressionAuthority', () => {
  it('binds the verified run id', () => {
    const authority = mintRunProgressionAuthority({ runId: RUN_ID });

    expect(authority.runId).toBe(RUN_ID);
  });

  it('carries nothing but the run id and its brand', () => {
    const authority = mintRunProgressionAuthority({ runId: RUN_ID });

    expect(Object.keys(authority)).toEqual(['runId']);
    expect(Object.hasOwn(authority, 'claimKey')).toBe(false);
    expect(Object.hasOwn(authority, 'delegationRuntime')).toBe(false);
    // The brand is a symbol-keyed own property, so it is invisible to
    // `Object.keys` and present to `Reflect.ownKeys`.
    expect(Reflect.ownKeys(authority).filter((key) => typeof key === 'symbol')).toHaveLength(1);
  });
});
