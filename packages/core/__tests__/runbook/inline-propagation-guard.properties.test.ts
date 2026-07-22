/**
 * Property tests for the #602 upward-propagation guard.
 *
 * The example tests pin named shapes (self-loop, 2-cycle, one long chain). These
 * pin the invariants over ARBITRARY linkage graphs — including the issue's actual
 * acceptance criterion, "no repeated side effects", which is a claim about every
 * graph and cannot be stated by any single example.
 *
 * The model: N nodes, each with an arbitrary parent pointer (or none) and its own
 * linkage kind. This generates self-loops, 2-cycles, k-cycles, lassos (a chain
 * into a cycle), long acyclic chains, and linkage-free roots — the whole space the
 * guard must survive, including shapes the real system cannot build (which is the
 * point: the guard exists for corrupt persisted state).
 *
 * Mixed inline/delegation graphs are built DELIBERATELY rather than sampled: the
 * guard trips at a node only when that node's parent is already visited, so a
 * randomly-placed delegation linkage almost always lands somewhere the walk
 * short-circuits before the guard can decide, and the property proves nothing.
 * The one graph that tests "the guard precedes the kind dispatch" has the
 * delegation linkage on the node that CLOSES the cycle.
 *
 * "No repeated side effects" is asserted over all THREE of the seam's side effects
 * — advance, release, and record — not just the advance callable: they ride one
 * recursion, so a guard that failed to bound the walk would repeat each alike.
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
  /** Every `runbookId` passed to releaseRunbook, in call order. */
  readonly released: readonly RunId[];
  /** Every `childState.id` passed to recordChildCompletion, in call order. */
  readonly recorded: readonly RunId[];
  /** Number of times the `onLinkageCycle` sink fired during the walk. */
  readonly sinkCalls: number;
}

/**
 * Resolve node `i`'s linkage kind.
 *
 * `kinds` is per-NODE, not per-walk: a single shared kind can only build a
 * uniformly-inline or uniformly-delegation graph, and the interesting graph is
 * the MIXED one — an inline chain whose back-edge or cap lands on a delegation
 * node. That is precisely where "the guard precedes the kind dispatch" is load
 * bearing, and a shared kind can never construct it.
 */
const kindAt = (kinds: LinkageKinds, i: number): 'inline' | 'delegation' =>
  typeof kinds === 'string' ? kinds : (kinds[i] ?? 'inline');

/** Either one kind for every node, or an explicit per-node assignment. */
type LinkageKinds = 'inline' | 'delegation' | readonly ('inline' | 'delegation')[];

/**
 * Walk `graph` from node 0.
 *
 * @param graph - Parent-pointer graph to walk.
 * @param status - Status every parent advance reports (default `'done'`, the
 *   only status that recurses; `'active'` short-circuits, `'stopped'` exercises
 *   the severity collapse).
 * @param kinds - One kind for every node, or a per-node array (default
 *   `'inline'`; `'delegation'` takes the report-only arm, which the guard still
 *   precedes). Per-node arrays build mixed graphs.
 * @returns The walk's result plus every id advanced, released, and recorded, in
 *   call order.
 */
async function walk(
  graph: LinkageGraph,
  status: 'stopped' | 'done' | 'active' = 'done',
  kinds: LinkageKinds = 'inline',
): Promise<Run> {
  const advanced: RunId[] = [];
  const released: RunId[] = [];
  const recorded: RunId[] = [];
  let sinkCalls = 0;
  const index = new Map<string, number>(graph.map((_, i) => [nodeRunId(i), i]));
  const deps: PropagateTerminalChildUpwardDeps = {
    manager: {
      load: async (id: string) => {
        const i = index.get(id);
        return i === undefined ? null : makeState(nodeRunId(i), graph[i] ?? null, kindAt(kinds, i));
      },
    },
    sessionService: {
      releaseRunbook: async (runbookId: RunId) => {
        released.push(runbookId);
        return {
          status: 'committed',
          value: {
            status: 'released',
            runbookId,
            removedFromDefaultStack: true,
            nextDefaultRunbookId: null,
          },
        };
      },
    },
    completionService: {
      recordChildCompletion: async ({ childState }: { childState: RunbookState }) => {
        recorded.push(childState.id);
        return 'recorded';
      },
    },
    advanceInlineParent: async ({ parentRunId }) => {
      advanced.push(parentRunId);
      return { status };
    },
    onLinkageCycle: () => {
      sinkCalls += 1;
    },
  };
  const result = await propagateTerminalChildUpward(
    deps,
    makeState(nodeRunId(0), graph[0] ?? null, kindAt(kinds, 0)),
    'pass',
  );
  return { result, advanced, released, recorded, sinkCalls };
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

  it('no run is released or recorded twice — the AC binds every side effect, not just advance', async () => {
    // 'no repeated side effects' was only ever proven for ONE of the seam's three
    // side effects. Release and record ride the same recursion: if the visited set
    // failed to bound the walk, a cyclic graph would re-release and re-record the
    // same run exactly as it would re-advance it. Asserting only `advanced` left
    // two thirds of the AC resting on a claim no property made.
    await fc.assert(
      fc.asyncProperty(graphArb, advanceStatusArb, async (graph, status) => {
        const { released, recorded } = await walk(graph, status);
        expect(new Set(released).size).toBe(released.length);
        expect(new Set(recorded).size).toBe(recorded.length);
      }),
      { numRuns: 200 },
    );
  });

  it('an inline chain whose back-edge is delegation-linked is still refused (guard precedes kind dispatch)', async () => {
    // The graph that actually tests the design point, built deliberately rather
    // than hoped for out of arbitrary pointers: a k-cycle 0 → 1 → … → n-1 → 0,
    // inline all the way round EXCEPT the node that closes the loop, which is
    // delegation-linked.
    //
    // The delegation node has to be the CLOSING one. The guard trips at a node
    // only when that node's parent is already visited, and in a k-cycle walked
    // from 0 the sole such node is n-1 (its parent is 0). Put the delegation
    // linkage anywhere earlier and its parent is still unvisited, so the walk
    // takes the report-only arm and returns 'reported' — no cycle reached, and
    // the property would prove nothing.
    //
    // Status is pinned to 'done' for the same reason: 'active' short-circuits at
    // level 1 and 'stopped' ends the walk before the back-edge, so neither ever
    // reaches the guard. An arbitrary status here would silently sample mostly
    // trivial cases.
    const inlineCycleClosedByDelegationArb = fc.integer({ min: 1, max: 12 }).map((n) => ({
      graph: Array.from({ length: n }, (_, i) => (i + 1) % n),
      kinds: Array.from({ length: n }, (_, i) =>
        i === n - 1 ? ('delegation' as const) : ('inline' as const),
      ),
    }));
    await fc.assert(
      fc.asyncProperty(inlineCycleClosedByDelegationArb, async ({ graph, kinds }) => {
        const { result, advanced, released, recorded } = await walk(graph, 'done', kinds);
        // If the kind dispatch ran FIRST, the closing node would record report-only
        // and return 'reported', which the severity collapse turns into 'handled' —
        // a corrupt graph reported as success. That is the regression this pins.
        expect(result).toBe('linkage-cycle');
        // The at-most-once claim must hold on the mixed graph exactly as it does
        // on the uniform one.
        expect(new Set(advanced).size).toBe(advanced.length);
        expect(new Set(released).size).toBe(released.length);
        expect(new Set(recorded).size).toBe(recorded.length);
      }),
      { numRuns: 300 },
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

  it('the onLinkageCycle sink fires exactly once iff the walk refuses a cycle, and never otherwise', async () => {
    // The sink is the seam's FOURTH side effect and a required dependency, yet the
    // other properties assert only advance/release/record — the sink was stubbed to
    // a no-op and never observed over arbitrary graphs. Its whole justification
    // (a fail-closed refusal must name the offending run, never a bare 'blocked')
    // rests on it firing precisely when, and only when, the walk returns
    // 'linkage-cycle'. This binds that iff over the full graph/status/kind space, so
    // a regression that dropped, double-fired, or misplaced the sink on some shape
    // the example tests don't enumerate cannot pass unseen.
    await fc.assert(
      fc.asyncProperty(graphArb, advanceStatusArb, linkageKindArb, async (graph, status, kind) => {
        const { result, sinkCalls } = await walk(graph, status, kind);
        expect(sinkCalls).toBe(result === 'linkage-cycle' ? 1 : 0);
      }),
      { numRuns: 300 },
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
