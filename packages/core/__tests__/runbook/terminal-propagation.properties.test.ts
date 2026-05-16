/**
 * Property tests for STOP/COMPLETE propagation across all topology shapes.
 *
 * Tests that terminal actions propagate correctly and validates the
 * aggregated flag and no-mapping design principle.
 * Five properties at 200 runs each (1,000 total).
 */

import fc from 'fast-check';
import {
  inferSteps,
  makeTransitions,
  runMachine,
  eventArb,
  DEFER_TRANSITIONS,
  type StepInput,
} from './compiler-property-helpers.js';
import type { Substep } from '../../src/runbook/types.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

type Topology = 'base' | 'substep' | 'for-substep';
type TerminalAction = 'STOP' | 'COMPLETE';

const topologyArb: fc.Arbitrary<Topology> = fc.constantFrom('base', 'substep', 'for-substep');
const terminalActionArb: fc.Arbitrary<TerminalAction> = fc.constantFrom('STOP', 'COMPLETE');

function buildTerminalSteps(
  topology: Topology,
  terminalAction: TerminalAction,
  triggerEvent: 'PASS' | 'FAIL',
): StepInput[] {
  const passAction = triggerEvent === 'PASS' ? terminalAction : 'CONTINUE';
  const failAction = triggerEvent === 'FAIL' ? terminalAction : 'CONTINUE';

  if (topology === 'base') {
    return [
      {
        name: '1',
        description: 'Base step',
        transitions: makeTransitions(passAction, failAction),
      },
    ];
  }

  const substepTransitions = makeTransitions(passAction, failAction);
  const substeps: Substep[] = [{ id: '1', description: 'Sub 1', transitions: substepTransitions }];
  // Step-level transitions mirror parser DEFAULT_TRANSITIONS. Substep terminal
  // actions (STOP/COMPLETE) exit directly and never consult parent transitions,
  // but the compiler still builds a parent state config that reads them.
  const stepTransitions = makeTransitions('CONTINUE', 'STOP');

  if (topology === 'substep') {
    return [
      {
        name: '1',
        description: 'Step with substep',
        transitions: stepTransitions,
        substeps,
      },
    ];
  }

  // for-substep
  return [
    {
      name: '1',
      description: 'FOR step',
      transitions: stepTransitions,
      forClause: { start: 1, end: 2 },
      substeps,
    },
  ];
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('Terminal propagation properties', () => {
  // Property 1: STOP always produces STOPPED
  it('STOP always produces STOPPED across all topologies', () => {
    fc.assert(
      fc.property(topologyArb, eventArb, (topology, event) => {
        const steps = inferSteps(buildTerminalSteps(topology, 'STOP', event));
        const result = runMachine(steps, [event]);
        expect(result.terminalState).toBe('STOPPED');
      }),
      { numRuns: 200 },
    );
  });

  // Property 2: COMPLETE always produces COMPLETE
  it('COMPLETE always produces COMPLETE across all topologies', () => {
    fc.assert(
      fc.property(topologyArb, eventArb, (topology, event) => {
        const steps = inferSteps(buildTerminalSteps(topology, 'COMPLETE', event));
        const result = runMachine(steps, [event]);
        expect(result.terminalState).toBe('COMPLETE');
      }),
      { numRuns: 200 },
    );
  });

  // Property 3: Direct terminal — no aggregated flag
  it('direct STOP/COMPLETE from substep has no aggregated flag', () => {
    fc.assert(
      fc.property(terminalActionArb, eventArb, (action, event) => {
        const substepTransitions = makeTransitions(action, action);
        const steps = inferSteps([
          {
            name: '1',
            description: 'Step with substep',
            transitions: makeTransitions('CONTINUE', 'STOP'),
            substeps: [{ id: '1', description: 'Sub 1', transitions: substepTransitions }],
          },
        ]);
        const result = runMachine(steps, [event]);
        expect(result.terminalState).toBe(action === 'STOP' ? 'STOPPED' : 'COMPLETE');
        // Direct terminal from substep — no aggregated flag
        expect(result.lastAction?.origin).toBe('direct');
      }),
      { numRuns: 200 },
    );
  });

  // Property 4: Aggregated terminal — aggregated flag set
  it('terminal action from parent aggregation has aggregated flag', () => {
    fc.assert(
      fc.property(terminalActionArb, eventArb, (action, event) => {
        // Substeps use DEFER to feed aggregation; parent resolves to terminal
        const steps = inferSteps([
          {
            name: '1',
            description: 'Step with substep',
            transitions: makeTransitions(action, action),
            aggregation: { strategy: 'ALL' },
            substeps: [{ id: '1', description: 'Sub 1', transitions: DEFER_TRANSITIONS }],
          },
        ]);
        const result = runMachine(steps, [event]);
        const expectedTerminal = action === 'STOP' ? 'STOPPED' : 'COMPLETE';
        expect(result.terminalState).toBe(expectedTerminal);
        // Aggregated terminal — flag must be set
        expect(result.lastAction?.origin).toBe('aggregation');
      }),
      { numRuns: 200 },
    );
  });

  // Property 5: No action mapping — lastAction.type is never CONTINUE at terminal
  // when a terminal action (STOP/COMPLETE) was configured
  it('terminal lastAction.type is never CONTINUE when STOP/COMPLETE configured', () => {
    fc.assert(
      fc.property(terminalActionArb, topologyArb, eventArb, (action, topology, event) => {
        const steps = inferSteps(buildTerminalSteps(topology, action, event));
        const result = runMachine(steps, [event]);
        // After terminal action fires, lastAction.type should match the configured action
        expect(result.lastAction?.type).toBe(action);
      }),
      { numRuns: 200 },
    );
  });

  it('forced terminal events override base, substep, and FOR/substep active states without aggregation metadata', () => {
    fc.assert(
      fc.property(
        topologyArb,
        terminalActionArb,
        fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }),
        (topology, action, message) => {
          const steps = inferSteps(buildTerminalSteps(topology, action, 'PASS'));
          const forceEvent =
            action === 'STOP'
              ? ({ type: 'FORCE_STOP', message } as const)
              : ({ type: 'FORCE_COMPLETE', message } as const);
          const result = runMachine(steps, [forceEvent]);

          expect(result.terminalState).toBe(action === 'STOP' ? 'STOPPED' : 'COMPLETE');
          expect(result.lifecycle).toBe(action === 'STOP' ? 'stopped' : 'completed');
          expect(result.lastAction?.type).toBe(action);
          expect(result.lastAction?.origin).toBe('direct');
          expect(result.lastMessage).toBe(message);
        },
      ),
      { numRuns: 200 },
    );
  });
});
