/**
 * Property tests for structural graph invariants of compiled machines.
 *
 * Tests structural properties across topology shapes (base, substeps, for).
 * Five properties at 300 runs each (1,500 total).
 */

import fc from 'fast-check';
import type { AnyStateMachine } from 'xstate';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import {
  inferSteps,
  makeTransitions,
  DEFER_TRANSITIONS,
  type StepInput,
} from './compiler-property-helpers.js';
import type { Substep } from '../../src/runbook/types.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

interface StepShape {
  kind: 'base' | 'substeps' | 'for';
  numSubsteps: number;
  iterations: number;
}

const stepShapeArb: fc.Arbitrary<StepShape> = fc.record({
  kind: fc.constantFrom<'base' | 'substeps' | 'for'>('base', 'substeps', 'for'),
  numSubsteps: fc.integer({ min: 1, max: 3 }),
  iterations: fc.integer({ min: 1, max: 4 }),
});

function buildStepsFromShapes(shapes: StepShape[]): StepInput[] {
  return shapes.map((shape, idx) => {
    const name = String(idx + 1);
    const isLast = idx === shapes.length - 1;
    const passAction = isLast ? 'COMPLETE' : 'CONTINUE';

    if (shape.kind === 'base') {
      return {
        name,
        description: `Step ${name}`,
        transitions: makeTransitions('ALL', passAction, 'STOP'),
      };
    }

    const substeps: Substep[] = Array.from({ length: shape.numSubsteps }, (_, i) => ({
      id: String(i + 1),
      description: `Substep ${String(i + 1)}`,
      transitions: DEFER_TRANSITIONS,
    }));

    if (shape.kind === 'for') {
      return {
        name,
        description: `FOR step ${name}`,
        forClause: {
          start: 1,
          end: shape.iterations,
          transitions: makeTransitions('ALL', 'DEFER', 'DEFER'),
        },
        transitions: makeTransitions('ALL', passAction, 'STOP'),
        substeps,
      };
    }

    // substeps kind
    return {
      name,
      description: `Step ${name} with substeps`,
      transitions: makeTransitions('ALL', passAction, 'STOP'),
      substeps,
    };
  });
}

// Helper: extract state configs from a compiled machine
function getStates(machine: AnyStateMachine): Record<string, unknown> {
  return (machine.config.states ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('Graph invariant properties', () => {
  const shapesArb = fc.array(stepShapeArb, { minLength: 1, maxLength: 4 });

  // Property 1: Compilation succeeds for any valid config
  it('any valid config compiles without throwing', () => {
    fc.assert(
      fc.property(shapesArb, (shapes) => {
        const steps = inferSteps(buildStepsFromShapes(shapes));
        expect(() => compileRunbookToMachine(steps)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  // Property 2: Terminal states exist
  it('compiled machine always has COMPLETE and STOPPED final states', () => {
    fc.assert(
      fc.property(shapesArb, (shapes) => {
        const steps = inferSteps(buildStepsFromShapes(shapes));
        const machine = compileRunbookToMachine(steps);
        const states = getStates(machine);
        expect(states).toHaveProperty('COMPLETE');
        expect(states).toHaveProperty('STOPPED');
      }),
      { numRuns: 300 },
    );
  });

  // Property 3: Initial state is first step
  it('initial state matches first step state ID', () => {
    fc.assert(
      fc.property(shapesArb, (shapes) => {
        const steps = inferSteps(buildStepsFromShapes(shapes));
        const machine = compileRunbookToMachine(steps);
        const initial = machine.config.initial;
        const firstStep = steps[0];

        if (firstStep.kind === 'substeps' || firstStep.kind === 'for') {
          expect(initial).toBe(`step::${firstStep.name}::${firstStep.substeps[0].id}`);
        } else {
          expect(initial).toBe(`step::${firstStep.name}`);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Property 4: Every non-terminal, non-parent state has PASS and FAIL handlers
  it('leaf states have PASS and FAIL event handlers', () => {
    fc.assert(
      fc.property(shapesArb, (shapes) => {
        const steps = inferSteps(buildStepsFromShapes(shapes));
        const machine = compileRunbookToMachine(steps);
        const states = getStates(machine);

        for (const [id, config] of Object.entries(states)) {
          if (id === 'COMPLETE' || id === 'STOPPED') continue;
          const cfg = config as Record<string, unknown>;
          // Parent aggregation states use `always`, not `on`
          if (cfg.always) continue;
          // Retry states also use `always`
          if (id.includes('::pass-retry') || id.includes('::fail-retry')) continue;
          const on = cfg.on as Record<string, unknown> | undefined;
          expect(on).toBeDefined();
          expect(on).toHaveProperty('PASS');
          expect(on).toHaveProperty('FAIL');
        }
      }),
      { numRuns: 300 },
    );
  });

  // Property 5: All transition targets exist in state map or are terminal
  it('all transition targets reference existing states', () => {
    fc.assert(
      fc.property(shapesArb, (shapes) => {
        const steps = inferSteps(buildStepsFromShapes(shapes));
        const machine = compileRunbookToMachine(steps);
        const states = getStates(machine);
        const allIds = new Set(Object.keys(states));

        const extractTargets = (obj: unknown): string[] => {
          const targets: string[] = [];
          if (!obj || typeof obj !== 'object') return targets;
          if ('target' in obj) {
            const t = (obj as { target?: string }).target;
            if (typeof t === 'string') targets.push(t);
          }
          if (Array.isArray(obj)) {
            for (const item of obj) targets.push(...extractTargets(item));
          }
          for (const val of Object.values(obj as Record<string, unknown>)) {
            if (val && typeof val === 'object') targets.push(...extractTargets(val));
          }
          return targets;
        };

        for (const [_id, config] of Object.entries(states)) {
          if (_id === 'COMPLETE' || _id === 'STOPPED') continue;
          const cfg = config as Record<string, unknown>;
          const targets = [...extractTargets(cfg.on), ...extractTargets(cfg.always)];
          for (const target of targets) {
            expect(allIds.has(target)).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
