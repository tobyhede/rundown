import fc from 'fast-check';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';
import { createActor, waitFor } from 'xstate';
import type { ArtifactDeclaration } from '@rundown-org/parser';
import { compileRunbookToMachine, PENDING_MACHINE_EFFECT_TAG } from '../../src/runbook/compiler.js';
import type { Substep, Transitions, ResolvedStep } from '../../src/runbook/types.js';
import {
  DEFER_TRANSITIONS,
  inferSteps,
  makeTransitions,
  type StepInput,
} from './compiler-property-helpers.js';
import { brandFlattenedTemplateVarsForTest } from '../../src/testing/effective-vars.js';

/**
 * Issue 12 — Persisted context hygiene.
 *
 * The architectural rule (CLAUDE.md "Actor dependencies") is that persisted
 * context contains ONLY data. Compile-time references — function refs, the
 * process-runtime `cwd`, service instance references — flow through the
 * per-state `invoke.input` closure constructed inside `compileRunbookToMachine`
 * and never make it into the snapshot envelope.
 *
 * This property test pins that invariant: across arbitrary runbook
 * topologies, `getPersistedSnapshot()` must serialise to JSON that contains
 * no function references and no values that look like process-runtime paths
 * (the `cwd` shape).
 */

interface TopologyShape {
  readonly stepCount: number;
  readonly parentSubsteps: number;
  readonly parentHasArtifacts: boolean;
  readonly childHasArtifacts: boolean;
}

const topologyArb: fc.Arbitrary<TopologyShape> = fc.record({
  stepCount: fc.integer({ min: 1, max: 4 }),
  parentSubsteps: fc.integer({ min: 0, max: 3 }),
  parentHasArtifacts: fc.boolean(),
  childHasArtifacts: fc.boolean(),
});

function artifact(name: string, rawToken: string): ArtifactDeclaration {
  return { name, rawToken };
}

function passContinueTransitions(): Transitions {
  return {
    pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
    fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
  };
}

function buildSteps(shape: TopologyShape): ResolvedStep[] {
  const steps: StepInput[] = [];
  for (let i = 1; i <= shape.stepCount; i++) {
    const stepIndex = String(i);
    if (i === shape.stepCount && shape.parentSubsteps > 0) {
      const substeps: Substep[] = Array.from({ length: shape.parentSubsteps }, (_, idx) => {
        const childIndex = String(idx + 1);
        return {
          id: childIndex,
          description: `Child ${childIndex}`,
          transitions: DEFER_TRANSITIONS,
          ...(shape.childHasArtifacts
            ? { artifacts: [artifact(`Child${childIndex}Path`, `child-${childIndex}.json`)] }
            : {}),
        };
      });
      steps.push({
        name: stepIndex,
        description: `Parent ${stepIndex}`,
        transitions: makeTransitions('COMPLETE', 'STOP'),
        aggregation: { strategy: 'ALL' as const },
        ...(shape.parentHasArtifacts ? { artifacts: [artifact('ParentPath', 'parent.json')] } : {}),
        substeps,
      });
    } else {
      steps.push({
        name: stepIndex,
        description: `Step ${stepIndex}`,
        transitions:
          i === shape.stepCount ? makeTransitions('COMPLETE', 'STOP') : passContinueTransitions(),
      });
    }
  }
  return inferSteps(steps);
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function tempCwd(): Promise<string> {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'persisted-context-hygiene-'));
  tempDirs.push(cwd);
  return cwd;
}

describe('persisted context hygiene properties', () => {
  it('getPersistedSnapshot().context never contains cwd or function references once settled', async () => {
    // The invariant only applies to SETTLED snapshots — XState DOES persist
    // in-flight invoke inputs in `children` while a `__resolve-artifacts`
    // actor is mid-run. The wire/disk contract is that we only persist
    // settled snapshots; runtime references like `cwd` therefore must never
    // appear in a settled `getPersistedSnapshot()` envelope.
    await fc.assert(
      fc.asyncProperty(topologyArb, async (shape) => {
        const cwd = await tempCwd();
        const steps = buildSteps(shape);
        const machine = compileRunbookToMachine(steps, {
          evaluationOptions: { cwd },
          templateVars: brandFlattenedTemplateVarsForTest({
            WorkPath: '.rundown/work',
            ContextId: 'ctx1',
            RunId: 'rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            RunbookRef: { source: 'project', path: 'fixture.runbook.md' },
          }),
        });
        const actor = createActor(machine);
        actor.start();
        let serialised: string;
        try {
          // Wait for any in-flight machine effects (artifact resolve / capture)
          // to settle so the snapshot reflects a persistable state.
          await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG));

          const persisted = actor.getPersistedSnapshot();
          serialised = JSON.stringify(persisted);
        } finally {
          actor.stop();
        }

        // Function references are unserialisable; JSON.stringify would
        // silently drop them. We sanity-check no inline Function bodies
        // leaked via a custom toJSON.
        expect(serialised).not.toMatch(/"\[object Function\]"/);
        expect(serialised).not.toMatch(/"function\s+\w+\s*\(/);
        expect(serialised).not.toMatch(/=>\s*\{/);

        // The compile-time evaluator cwd is the temp directory; it MUST
        // NOT appear inside the settled persisted snapshot — runtime paths
        // belong in invoke.input closures, not in context.
        expect(serialised).not.toContain(cwd);
        // Defensive: a settled persisted JSON must not embed an absolute
        // path that looks like a real process cwd. Any path starting with
        // `/Users/`, `/home/`, or `/private/var/folders/` would indicate
        // a leak (the temp dirs created by mkdtemp on macOS live there).
        expect(serialised).not.toMatch(/"\/(Users|home|private\/var\/folders)\/[^"]+"/);
      }),
      { numRuns: 20 },
    );
  });

  it('EXECUTE_COMMAND does not persist command service callables or lastResult in snapshot context', async () => {
    const cwd = await tempCwd();
    const steps = inferSteps([
      {
        name: '1',
        description: 'Command',
        transitions: makeTransitions('COMPLETE', 'STOP'),
        command: { code: 'true', lang: 'bash' },
      },
    ]);
    const machine = compileRunbookToMachine(steps, {
      evaluationOptions: { cwd },
      commandServices: {
        runExternalCommand: async () => ({ success: true, exitCode: 0 }),
      },
      templateVars: brandFlattenedTemplateVarsForTest({
        WorkPath: '.rundown/work',
        ContextId: 'ctx1',
        RunId: 'rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        RunbookRef: { source: 'project', path: 'fixture.runbook.md' },
      }),
    });
    const actor = createActor(machine);
    actor.start();
    try {
      actor.send({
        type: 'EXECUTE_COMMAND',
        command: 'true',
        displayCommand: 'true',
        outputScope: { stepId: '1' },
        nakedOutputs: [],
        rdInjected: { RD_RUN_ID: 'rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      });
      await waitFor(actor, (snap) => !snap.hasTag(PENDING_MACHINE_EFFECT_TAG));

      const snapshot = actor.getPersistedSnapshot() as { context?: unknown };
      const serializedSnapshotContext = JSON.stringify(snapshot.context);
      expect(serializedSnapshotContext).not.toMatch(
        /runExternalCommand|runInternalCommand|commandServices/,
      );
      expect(serializedSnapshotContext).not.toContain('lastResult');
    } finally {
      actor.stop();
    }
  });
});
