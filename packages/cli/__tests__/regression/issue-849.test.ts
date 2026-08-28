import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RunbookStateManager, merge } from '@rundown-org/core';
// `RunbookStore` is not part of `@rundown-org/core`'s public barrel, but
// `RunbookStore.prototype.captureRunAuthorityState` is the exact
// capture-before-lease-acquisition boundary this test needs to hook — see the
// long comment at the spy below for why no public seam reaches it. The
// dedicated testing entry resolves (via this package's jest moduleNameMapper)
// to the SAME source file `@rundown-org/core` itself imports (Jest caches
// modules by resolved path, not import specifier), so the spy reaches the one
// store instance `runCliInProcess` actually uses. Core's own
// `effectful-actor-mutation-runner.test.ts` spies on the identical method the
// identical way from inside the package.
import { RunbookStore } from '@rundown-org/core/testing/runbook-store';
import {
  createTestWorkspace,
  findActionOutput,
  parseConcatenatedJson,
  requireFrontierToken,
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

// Issue #849. `docs/spec/cli-output.md:1947` and `docs/reference/cli.md:949-951`
// both state that when a `rundown collect` aggregation advances the delegating
// run into execution-loop work, and that loop's own command fence then loses
// its compare-and-swap, the refusal streams as an `error_occurred` observation
// and "emits no `runbook_stopped`: the refused follow-on transition committed
// no terminal state." `collect.ts:612` calls `runExecutionLoop` WITHOUT
// `returnRefusals`, so `execution.ts:1785-1792` takes the `!returnRefusals` arm
// and DOES emit `RUNBOOK_STOPPED` with message
// 'Runbook command execution was not committed' — the exact divergence #849
// reports (`returnRefusals` has exactly one production caller,
// `buildAdvanceInlineParent`, which `collect.ts` is not).
//
// This test provokes a genuine lost fence rather than mocking the refusal: a
// parent with a DELEGATE substep resolved and ready to collect, followed by a
// command step. Collect's aggregation advances the parent into that command
// step, and a real concurrent writer invalidates the fence's captured
// authority before it can acquire the execution lease.
describe('issue #849: collect fence refusal does not emit runbook_stopped', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await workspace.cleanup();
  });

  it('reports the follow-on fence refusal as error_occurred without a runbook_stopped', async () => {
    const parent = [
      '# Parent',
      '',
      '## 1. Fan-out',
      '',
      '- PASS ALL CONTINUE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 Child',
      '',
      '- DELEGATE',
      '',
      '- child.runbook.md',
      '',
      '## 2. Command step',
      '',
      '- PASS COMPLETE',
      '- FAIL STOP',
      '',
      '```bash',
      'echo issue-849',
      '```',
      '',
    ].join('\n');
    const child = ['# Child', '', '## 1. Done', '', '- PASS COMPLETE', '', 'Done.', ''].join('\n');

    await writeFile(join(workspace.runbooksDir(), 'parent.runbook.md'), parent);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), child);

    const start = await runCliInProcess('run parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const startEvents = flattenEvents(parseConcatenatedJson(start.stdout));
    const started = startEvents.find((event) => event.type === 'runbook_started');
    const parentRunId = String(started?.runbookId);
    const parentClaimId = String(started?.claim_id);
    expect(parentRunId).toMatch(/^rd_/);
    expect(parentClaimId).toMatch(/^rdclm_/);

    const token = requireFrontierToken(start.stdout, '1.1');

    const claim = await runCliInProcess(`claim ${token}`, workspace);
    expect(claim.exitCode).toBe(0);
    const childClaimId = findActionOutput<{ claim_id: string }>(claim.stdout)?.claim_id;
    expect(childClaimId).toBeDefined();

    // Report-then-collect: passing the child records its outcome but does not
    // drain/aggregate it, so the parent stays on the DELEGATE step until
    // `rundown collect` applies it below.
    const passed = await runCliInProcess(['pass', '--claim-id', String(childClaimId)], workspace);
    expect(passed.exitCode).toBe(0);

    // Land a genuine concurrent writer inside the ONE window this fence can
    // lose. `ProjectEffectfulActorMutationRunner.run`
    // (packages/core/src/runbook/effectful-actor-mutation-runner.ts:342-360)
    // captures authority via `store.captureRunAuthorityState` BEFORE
    // constructing the execution lease, and `CoreEffectfulMutationExecutor.run`
    // (packages/core/src/runbook/effectful-mutation-executor.ts:191-194)'s
    // FIRST await is `this.lease.acquire(input.captured, ...)`, which
    // re-checks the captured `state_version` against the row
    // (`acquireInTx` -> `classifyCommitRow`:
    // packages/core/src/runbook/storage/execution-lease.ts:869-901,
    // packages/core/src/runbook/storage/runbook-store.ts:549-555). Once the
    // lease is acquired the run is execution-owned (`exec_token` set) and any
    // further unguarded write is refused `execution_in_progress` rather than
    // landing (packages/core/src/runbook/storage/runbook-store.ts:1470-1490's
    // 'owned' outcome) — so the ONLY point at which an ordinary concurrent
    // writer can bump `state_version` out from under this fence is between
    // capture and acquisition. Hooking `captureRunAuthorityState` itself is
    // therefore the only way to land a real writer inside that window; core's
    // own `effectful-actor-mutation-runner.test.ts` uses the identical
    // `RunbookStore.prototype.captureRunAuthorityState` spy technique to
    // reproduce a superseded capture.
    let injected = false;
    const realCapture = RunbookStore.prototype.captureRunAuthorityState;
    jest
      .spyOn(RunbookStore.prototype, 'captureRunAuthorityState')
      .mockImplementation(async function (this: RunbookStore, runId: string) {
        const result = await realCapture.call(this, runId as never);
        // Target ONLY the follow-on loop's capture of the parent at step 2 —
        // the initial `run`, `claim`, `pass`, and collect's own aggregation all
        // capture the parent (or the child) at other steps and must pass
        // through untouched, or this would corrupt unrelated writes.
        if (
          !injected &&
          result.kind === 'captured' &&
          result.state.id === parentRunId &&
          result.state.step === '2'
        ) {
          injected = true;
          const racer = new RunbookStateManager(workspace.cwd);
          await racer.update(parentRunId as never, {
            variables: merge({ __issue849ConcurrentWrite: 'concurrent-writer' }),
          });
        }
        return result;
      });

    const collected = await runCliInProcess(
      ['collect', '--claim-id', parentClaimId, '--allow-all'],
      workspace,
    );

    const events = flattenEvents(parseConcatenatedJson(collected.stdout));

    // Sanity gate BEFORE the pinning assertion: the fence refusal actually
    // fired. Without this, a broken setup (no race provoked) would pass the
    // assertion below vacuously.
    const fenceRefusal = events.find(
      (event) => event.type === 'error_occurred' && event.code === 'CONCURRENT_MODIFICATION',
    );
    expect(fenceRefusal).toBeDefined();
    expect(fenceRefusal?.message).toEqual(expect.stringContaining(parentRunId));
    expect(injected).toBe(true);

    // THE PINNING ASSERTION. Both docs say this refusal "emits no
    // runbook_stopped: the refused follow-on transition committed no terminal
    // state." Correct behavior per the shipped spec is that no such event
    // appears; execution.ts:1785-1792 emits one because collect.ts:612 does not
    // pass `returnRefusals`.
    const spuriousStop = events.find(
      (event) =>
        event.type === 'runbook_stopped' &&
        event.message === 'Runbook command execution was not committed',
    );
    expect(spuriousStop).toBeUndefined();
  }, 20_000);
});
