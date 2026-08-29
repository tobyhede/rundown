import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RunbookStateManager, merge } from '@rundown-org/core';
// The dedicated testing entry resolves (via this package's jest
// moduleNameMapper) to the SAME source file `@rundown-org/core` itself
// imports, so the prototype spy below reaches the one store instance
// `runCliInProcess` actually uses — the identical technique the #849 collect
// witness uses for the identical capture window.
import { RunbookStore } from '@rundown-org/core/testing/runbook-store';
import {
  createTestWorkspace,
  parseConcatenatedJson,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

function flattenEvents(events: unknown[]): Record<string, unknown>[] {
  const flat: Record<string, unknown>[] = [];
  for (const event of events) {
    if (Array.isArray(event)) {
      flat.push(...flattenEvents(event));
      continue;
    }
    if (event && typeof event === 'object') {
      flat.push(event as Record<string, unknown>);
    }
  }
  return flat;
}

// #854 migration pin — the pass/fail analog of the #849 collect witness. When
// a `rundown pass` continuation advances the run into a command step and that
// step's fence loses its compare-and-swap to a genuine concurrent writer, the
// refusal must stream as `error_occurred` and the run must stay running and
// targeted; no `runbook_stopped` may be emitted, because the refused turn
// committed no terminal state. Pre-migration, the CLI execution loop's
// `!returnRefusals` arm emitted exactly that false stop.
describe('pass continuation fence refusal does not emit runbook_stopped (#854)', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await workspace.cleanup();
  });

  it('reports the continuation fence refusal as error_occurred with the run left running', async () => {
    const runbook = [
      '# Two Step',
      '',
      '## 1. Manual gate',
      '',
      '- PASS CONTINUE',
      '- FAIL STOP',
      '',
      'Confirm readiness.',
      '',
      '## 2. Command step',
      '',
      '- PASS COMPLETE',
      '- FAIL STOP',
      '',
      '```bash',
      'echo issue-854',
      '```',
      '',
    ].join('\n');
    await writeFile(join(workspace.runbooksDir(), 'two-step.runbook.md'), runbook);

    const start = await runCliInProcess('run two-step.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const startEvents = flattenEvents(parseConcatenatedJson(start.stdout));
    const started = startEvents.find((event) => event.type === 'runbook_started');
    const runId = String(started?.runbookId);
    expect(runId).toMatch(/^rd_/);

    // Land a genuine concurrent writer inside the one window the follow-on
    // fence can lose: between `captureRunAuthorityState` and the execution
    // lease acquisition, targeting only the continuation's capture of this run
    // at step 2 (the initial `run` and the transition's own fenced capture at
    // step 1 must pass through untouched).
    let injected = false;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured only to `.call(this, …)` inside the mock below; never invoked unbound
    const realCapture = RunbookStore.prototype.captureRunAuthorityState;
    jest
      .spyOn(RunbookStore.prototype, 'captureRunAuthorityState')
      .mockImplementation(async function (this: RunbookStore, target: string) {
        const result = await realCapture.call(this, target as never);
        if (
          !injected &&
          result.kind === 'captured' &&
          result.state.id === runId &&
          result.state.step === '2'
        ) {
          injected = true;
          const racer = new RunbookStateManager(workspace.cwd);
          await racer.update(runId, {
            variables: merge({ __issue854ConcurrentWrite: 'concurrent-writer' }),
          });
        }
        return result;
      });

    const passed = await runCliInProcess('pass', workspace);
    const events = flattenEvents(parseConcatenatedJson(passed.stdout));

    // Sanity gate: the race actually fired and was refused.
    const fenceRefusal = events.find(
      (event) => event.type === 'error_occurred' && event.code === 'CONCURRENT_MODIFICATION',
    );
    expect(injected).toBe(true);
    expect(fenceRefusal).toBeDefined();

    // The pin: no false terminal for a refusal that committed nothing.
    const spuriousStop = events.find((event) => event.type === 'runbook_stopped');
    expect(spuriousStop).toBeUndefined();

    // Ground truth: the run is still running, at the committed step-2 cursor.
    const manager = new RunbookStateManager(workspace.cwd);
    const after = await manager.load(runId);
    expect(after?.lifecycle).toBe('running');
    expect(after?.step).toBe('2');

    // Fail-closed exit: the continuation did not complete its work.
    expect(passed.exitCode).toBe(1);
  }, 20_000);
});
