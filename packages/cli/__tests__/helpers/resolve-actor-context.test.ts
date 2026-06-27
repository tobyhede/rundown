import { describe, it, expect } from '@jest/globals';
import type {
  ActorContext,
  ClaimId,
  DelegationTokenHash,
  RunId,
  RunbookState,
} from '@rundown-org/core';
import {
  ACTOR_SOURCE_VALUES,
  InvalidActorSourceError,
  parseActorSource,
  resolveActorContext,
  type ActorIngress,
} from '../../src/helpers/resolve-actor-context.js';

// Minimal RunbookState stub: resolveActorContext only reads `.id`.
function stubState(id: string): RunbookState {
  return { id: id as RunId } as unknown as RunbookState;
}

const TARGET = stubState('run_target');
const CLAIM_ID = 'rdclm_target' as ClaimId;
const TOKEN_HASH = 'tokenHash_target' as DelegationTokenHash;
const CONTROLLED = 'run_controlled' as RunId;

describe('parseActorSource', () => {
  it('exposes exactly the three frozen source values', () => {
    expect([...ACTOR_SOURCE_VALUES]).toEqual(['direct-cli', 'plugin', 'mcp']);
  });

  it.each(['direct-cli', 'plugin', 'mcp'] as const)('accepts %s', (value) => {
    expect(parseActorSource(value)).toBe(value);
  });

  it('rejects an unknown value with a typed hard error (no silent default)', () => {
    expect.assertions(3);
    try {
      parseActorSource('remote');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidActorSourceError);
      expect((error as InvalidActorSourceError).code).toBe('INVALID_ACTOR_SOURCE');
      expect((error as InvalidActorSourceError).value).toBe('remote');
    }
  });

  it('rejects the empty string', () => {
    expect(() => parseActorSource('')).toThrow(InvalidActorSourceError);
  });

  // Matching is exact: no implicit case folding and no whitespace trimming.
  // These pin a future `.toLowerCase()` / `.trim()` normalization mutant.
  it.each(['Plugin', 'MCP', 'Direct-CLI'])('rejects case variants (%s)', (value) => {
    expect(() => parseActorSource(value)).toThrow(InvalidActorSourceError);
  });

  it.each([' plugin ', 'plugin\n', 'mcp\t'])('rejects untrimmed whitespace (%j)', (value) => {
    expect(() => parseActorSource(value)).toThrow(InvalidActorSourceError);
  });
});

describe('resolveActorContext — frozen trust-mapping table', () => {
  it('row 1: source unset, no claim => trusted_run_controller(direct-cli)', () => {
    const ingress: ActorIngress = {};
    expect(resolveActorContext(ingress, TARGET)).toEqual({
      kind: 'trusted_run_controller',
      runId: TARGET.id,
      source: 'direct-cli',
    });
  });

  it('row 1b: source direct-cli, no claim => trusted_run_controller(direct-cli)', () => {
    expect(resolveActorContext({ source: 'direct-cli' }, TARGET)).toEqual({
      kind: 'trusted_run_controller',
      runId: TARGET.id,
      source: 'direct-cli',
    });
  });

  it('row 2: source plugin, no claim => trusted_run_controller(plugin)', () => {
    expect(resolveActorContext({ source: 'plugin' }, TARGET)).toEqual({
      kind: 'trusted_run_controller',
      runId: TARGET.id,
      source: 'plugin',
    });
  });

  it('row 3: source mcp, no claim => trusted_run_controller(mcp)', () => {
    expect(resolveActorContext({ source: 'mcp' }, TARGET)).toEqual({
      kind: 'trusted_run_controller',
      runId: TARGET.id,
      source: 'mcp',
    });
  });

  it('row 4: any source + full claim evidence => claim_controller (source ignored)', () => {
    const expected: ActorContext = {
      kind: 'claim_controller',
      claimId: CLAIM_ID,
      tokenHash: TOKEN_HASH,
      controlledRunId: CONTROLLED,
    };
    for (const source of ACTOR_SOURCE_VALUES) {
      expect(
        resolveActorContext(
          { source, claimId: CLAIM_ID, tokenHash: TOKEN_HASH, controlledRunId: CONTROLLED },
          TARGET,
        ),
      ).toEqual(expected);
    }
  });

  // Resolver invariant: if valid claim evidence is present, claim_controller
  // wins over any source tag. This does not imply the plugin plan emits
  // source=plugin for agent-run Bash lifecycle commands; it only pins the
  // resolver table for callers that already have claim evidence.
  it('row 4: source=plugin + valid claim => claim_controller (claim wins)', () => {
    const result = resolveActorContext(
      { source: 'plugin', claimId: CLAIM_ID, tokenHash: TOKEN_HASH, controlledRunId: CONTROLLED },
      TARGET,
    );
    expect(result).toEqual({
      kind: 'claim_controller',
      claimId: CLAIM_ID,
      tokenHash: TOKEN_HASH,
      controlledRunId: CONTROLLED,
    });
    // Belt-and-braces: it is NOT downgraded to a trusted run controller and
    // carries no `source` field (claim_controller has no source).
    expect(result.kind).toBe('claim_controller');
    expect((result as { source?: unknown }).source).toBeUndefined();
  });

  it('row 4 (MCP pin): source=mcp + valid claim => claim_controller (claim wins)', () => {
    const result = resolveActorContext(
      { source: 'mcp', claimId: CLAIM_ID, tokenHash: TOKEN_HASH, controlledRunId: CONTROLLED },
      TARGET,
    );
    expect(result).toEqual({
      kind: 'claim_controller',
      claimId: CLAIM_ID,
      tokenHash: TOKEN_HASH,
      controlledRunId: CONTROLLED,
    });
    expect(result.kind).toBe('claim_controller');
    expect((result as { source?: unknown }).source).toBeUndefined();
  });

  it('claim evidence defaults controlledRunId to the resolved target id when omitted', () => {
    // The collect path resolves the claimed child as `state`, so a caller may
    // omit controlledRunId and rely on `state.id`.
    expect(resolveActorContext({ claimId: CLAIM_ID, tokenHash: TOKEN_HASH }, TARGET)).toEqual({
      kind: 'claim_controller',
      claimId: CLAIM_ID,
      tokenHash: TOKEN_HASH,
      controlledRunId: TARGET.id,
    });
  });

  it('row 5: partial claim evidence (claimId without tokenHash) => unknown', () => {
    // No resolvable controlled run AND no *complete* claim evidence: the
    // reserved inspect-only fallback. Type-reachable even though no default
    // local frontend path produces it.
    expect(resolveActorContext({ source: 'plugin', claimId: CLAIM_ID }, TARGET)).toEqual({
      kind: 'unknown',
    });
  });

  it('row 5b: tokenHash without claimId => unknown', () => {
    expect(resolveActorContext({ source: 'mcp', tokenHash: TOKEN_HASH }, TARGET)).toEqual({
      kind: 'unknown',
    });
  });
});
