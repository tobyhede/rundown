/**
 * Property tests for the #602 upward-propagation guard.
 *
 * The example tests pin named shapes (self-loop, 2-cycle, one long chain). These
 * pin the invariants over ARBITRARY linkage graphs — including the issue's actual
 * acceptance criterion, "no repeated side effects", which is a claim about every
 * graph and cannot be stated by any single example.
 *
 * The model: N nodes, each with an arbitrary parent pointer (or none). This
 * generates self-loops, 2-cycles, k-cycles, lassos (a chain into a cycle), long
 * acyclic chains, and linkage-free roots — the whole space the guard must survive,
 * including shapes the real system cannot build (which is the point: the guard
 * exists for corrupt persisted state).
 *
 * Four properties at 200 runs each.
 */

import { describe, it, expect } from '@jest/globals';
import fc from 'fast-check';
import {
  propagateTerminalChildUpward,
  MAX_INLINE_PROPAGATION_CHAIN,
  type PropagateTerminalChildUpwardDeps,
  type TerminalUpwardPropagationResult,
} from '../../src/runbook/inline-parent-advance.js';
import {
  assertDelegationTokenHash,
  assertRunId,
  type RunbookState,
  type RunId,
} from '../../src/runbook/index.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import { brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';

// ---------------------------------------------------------------------------
// Graph model + arbitraries
// ---------------------------------------------------------------------------

/** `parents[i]` is node i's parent index, or null for a linkage-free root. */
type LinkageGraph = readonly (number | null)[];

const nodeRunId = (n: number): RunId => assertRunId(`rd_${n.toString(16).padStart(32, '0')}`);

/** Dense small graphs: self-loops, 2-cycles, k-cycles, lassos, forests. */
const pointerGraphArb: fc.Arbitrary<LinkageGraph> = fc.integer({ min: 1, max: 12 }).chain((n) =>
  fc.array(fc.option(fc.integer({ min: 0, max: n - 1 }), { nil: null }), {
    minLength: n,
    maxLength: n,
  }),
);

/** Long acyclic chains, spanning both sides of the depth cap. */
const longChainArb: fc.Arbitrary<LinkageGraph> = fc
  .integer({ min: 1, max: 200 })
  .map((n) => Array.from({ length: n }, (_, i) => (i === n - 1 ? null : i + 1)));

const graphArb: fc.Arbitrary<LinkageGraph> = fc.oneof(pointerGraphArb, longChainArb);

/** Acyclic chains that stay strictly INSIDE the bound — the no-false-positive space. */
const withinBoundChainArb: fc.Arbitrary<LinkageGraph> = fc
  .integer({ min: 1, max: MAX_INLINE_PROPAGATION_CHAIN - 1 })
  .map((n) => Array.from({ length: n }, (_, i) => (i === n - 1 ? null : i + 1)));

/**
 * Advance statuses the composing parent may reach.
 *
 * Varying this is load-bearing: with `'done'` hardcoded, the severity-precedence
 * collapse (`linkage-cycle > blocked > stopped > handled`) is never reached by
 * any property, and `'active'` never short-circuits the recursion.
 */
const advanceStatusArb: fc.Arbitrary<'stopped' | 'done' | 'active'> = fc.constantFrom(
  'stopped',
  'done',
  'active',
);

/**
 * Linkage kind per node.
 *
 * Varying this is load-bearing: the guard sits BEFORE the kind dispatch — a
 * stated design point — so a delegation linkage must be refused as firmly as an
 * inline one. With `'inline'` hardcoded, no property ever exercised that claim.
 */
const linkageKindArb: fc.Arbitrary<'inline' | 'delegation'> = fc.constantFrom(
  'inline',
  'delegation',
);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeState(
  id: RunId,
  parent: number | null,
  kind: 'inline' | 'delegation' = 'inline',
): RunbookState {
  const common = {
    parentRunId: parent === null ? nodeRunId(0) : nodeRunId(parent),
    parentStepId: '1',
    parentStep: '1',
    parentFrameKey: buildFrameKey('1'),
    parentEntry: 1,
  };
  return {
    id,
    runbook: { source: 'project', path: 'test.md' },
    runbookPath: '/tmp/test.md',
    step: '1',
    stepName: 'Step',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [{ id: '1', status: 'running' }],
    lifecycle: 'completed',
    startedAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    schemaVersion: 1,
    frontmatterOutputs: [],
    ...(parent === null
      ? {}
      : {
          parentLinkage:
            kind === 'inline'
              ? { kind: 'inline' as const, ...common }
              : {
                  kind: 'delegation' as const,
                  ...common,
                  tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
                },
        }),
  };
}

interface Run {
  readonly result: TerminalUpwardPropagationResult;
  /** Every `parentRunId` passed to advanceInlineParent, in call order. */
  readonly advanced: readonly RunId[];
}

/**
 * Walk `graph` from node 0.
 *
 * @param graph - Parent-pointer graph to walk.
 * @param status - Status every parent advance reports (default `'done'`, the
 *   only status that recurses; `'active'` short-circuits, `'stopped'` exercises
 *   the severity collapse).
 * @param kind - Linkage kind every node carries (default `'inline'`;
 *   `'delegation'` takes the report-only arm, which the guard still precedes).
 * @returns The walk's result plus every parent id advanced, in call order.
 */
async function walk(
  graph: LinkageGraph,
  status: 'stopped' | 'done' | 'active' = 'done',
  kind: 'inline' | 'delegation' = 'inline',
): Promise<Run> {
  const advanced: RunId[] = [];
  const index = new Map<string, number>(graph.map((_, i) => [nodeRunId(i), i]));
  const deps: PropagateTerminalChildUpwardDeps = {
    manager: {
      load: async (id: string) => {
        const i = index.get(id);
        return i === undefined ? null : makeState(nodeRunId(i), graph[i] ?? null, kind);
      },
    },
    sessionService: { releaseRunbook: async () => ({}) as never },
    completionService: { recordChildCompletion: async () => 'recorded' },
    advanceInlineParent: async ({ parentRunId }) => {
      advanced.push(parentRunId);
      return { status };
    },
    onLinkageCycle: () => {},
  };
  const result = await propagateTerminalChildUpward(
    deps,
    makeState(nodeRunId(0), graph[0] ?? null, kind),
    'pass',
  );
  return { result, advanced };
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('inline propagation guard — properties (#602)', () => {
  it('the walk terminates for any graph, status, and linkage kind', async () => {
    await fc.assert(
      fc.asyncProperty(graphArb, advanceStatusArb, linkageKindArb, async (graph, status, kind) => {
        // Reaching the assertion at all IS the termination proof: an unguarded
        // walk on a cyclic graph never returns (or throws RangeError). The union
        // membership is guaranteed statically by the return type, so the content
        // here is termination across the whole input space — including the
        // 'stopped'/'active' statuses and the delegation arm the original
        // harness pinned to constants and never reached.
        const { result } = await walk(graph, status, kind);
        expect([
          'handled',
          'stopped',
          'blocked',
          'reported',
          'duplicate',
          'linkage-cycle',
          'not-applicable',
        ]).toContain(result);
      }),
      { numRuns: 200 },
    );
  });

  it('a cyclic graph is refused, never silently reported as success', async () => {
    // The severity claim, over arbitrary statuses: a walk whose graph forces a
    // repeat must surface 'linkage-cycle' and must NOT be downgraded to
    // 'handled'/'stopped' by a shallower level's result. Only 'done' recurses,
    // so this is the property the 'done'-only harness could never state.
    const cyclicArb = fc
      .integer({ min: 1, max: 8 })
      .map((n) => Array.from({ length: n }, (_, i) => (i + 1) % n));
    await fc.assert(
      fc.asyncProperty(cyclicArb, async (graph) => {
        const { result } = await walk(graph, 'done');
        expect(result).toBe('linkage-cycle');
      }),
      { numRuns: 200 },
    );
  });

  it('advanceInlineParent is invoked at most MAX - 1 times for any graph', async () => {
    await fc.assert(
      fc.asyncProperty(graphArb, advanceStatusArb, async (graph, status) => {
        const { advanced } = await walk(graph, status);
        expect(advanced.length).toBeLessThanOrEqual(MAX_INLINE_PROPAGATION_CHAIN - 1);
      }),
      { numRuns: 200 },
    );
  });

  it('no run id is ever advanced twice (the issue AC: no repeated side effects)', async () => {
    await fc.assert(
      fc.asyncProperty(graphArb, advanceStatusArb, async (graph, status) => {
        const { advanced } = await walk(graph, status);
        expect(new Set(advanced).size).toBe(advanced.length);
      }),
      { numRuns: 200 },
    );
  });

  it('a delegation linkage never advances an inline parent, cyclic or not', async () => {
    // The guard precedes the kind dispatch — a stated design point that no
    // property covered while the harness hardcoded kind: 'inline'. Delegation is
    // report-only: it must never drive the inline-advance callable, and a cyclic
    // delegation graph must still terminate.
    await fc.assert(
      fc.asyncProperty(graphArb, async (graph) => {
        const { advanced, result } = await walk(graph, 'done', 'delegation');
        expect(advanced).toEqual([]);
        expect(result).not.toBe('handled');
      }),
      { numRuns: 200 },
    );
  });

  it('never trips on an acyclic chain within the bound (no false positives)', async () => {
    await fc.assert(
      fc.asyncProperty(withinBoundChainArb, async (graph) => {
        const { result, advanced } = await walk(graph);
        expect(result).not.toBe('linkage-cycle');
        // Every link in the chain advanced exactly once; the root has no linkage.
        expect(advanced.length).toBe(graph.length - 1);
      }),
      { numRuns: 200 },
    );
  });
});
