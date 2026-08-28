import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  getActiveState,
  readRunbookState,
  readSession,
  requireEmittedRunClaim,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

// Issue #847. Traced line by line, never executed end to end — this is the
// witness the issue itself asks for.
//
// `releasesForInlineChain` (lifecycle-command-service.ts:1361-1367) marks
// every non-root chain member `collateral`, and `claimDisposition('collateral')`
// is `revoke` (session-release.ts:74-96), so `projectOne` deletes those claims
// and filters the run off `defaultStack`. The plan-time arm guards only the
// *resolved root's* lifecycle before releasing the whole chain — nothing
// checks a descendant's own lifecycle.
//
// Traced path:
//   1. `rundown stop --claim-id <root's run-control claim>` names the root as
//      the plan anchor. `resolveActiveInlineForceTerminalPlan` walks UP the
//      inline-parent chain only (session-service.ts), so a running inline
//      descendant *below* the anchor is excluded from `forceOrder` and never
//      forced. The root closes and releases (`addressed` -> retained claim);
//      the descendant stays `running` and stays on the stack.
//      (A bearer-less `stop --run <root>` cannot reach this arm at all:
//      `resolveCommandIntent` requires bearer authority for every
//      `targetSelector.kind === 'run'`, and `--run`+`--claim-id` together is
//      parse-time `INVALID_SYNTAX` — the root's own run-control claim,
//      exactly the form CLAUDE.md prescribes for orchestrators, is the only
//      invocation that reaches `#driveTerminalBare`'s root-anchor arm.)
//   2. A later ambient `rundown stop` (no --run, no --claim-id) resolves the
//      active run to that still-running descendant, walks up to the
//      already-terminal root, takes the already-terminal arm, and — because
//      `releasesForInlineChain` marks every non-root member `collateral` —
//      releases the RUNNING descendant as collateral: revoking its
//      run-control claim and removing it from `defaultStack`, while
//      reporting `already_terminal` at exit 0.
//
// Per ADR 0001 and `ReleaseRole`'s own doc (session-release.ts:19-21,
// "collateral — ... An inline descendant forced terminal under its root"), a
// release must not revoke the claim of a run to which no terminal transition
// was ever applied. The descendant here is never forced by either step, so
// its claim and stack membership must survive step 2.
describe('issue #847: already-terminal chain release spares a running descendant', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('does not revoke a still-running inline descendant when a later ambient stop finds its root already terminal', async () => {
    // Same inline-chain shape the existing force-stop regression tests use
    // (`bare stop from an inline child...`, the #518 tests in stop.test.ts):
    // a composing root whose substep 1.1 is inline-linked to a manually
    // started child that parks on a manual "Waiting" step.
    await writeFile(
      join(workspace.cwd, 'root-847.runbook.md'),
      [
        '# Root 847',
        '',
        '## 1. Compose',
        '- PASS CONTINUE',
        '- FAIL STOP',
        '',
        '### 1.1 Inline descendant',
        'Launch descendant here.',
        '',
        '## 2. Later',
        '- PASS COMPLETE',
        '- FAIL STOP',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(workspace.cwd, 'descendant-847.runbook.md'),
      [
        '# Descendant 847',
        '',
        '## 1. Waiting',
        '- PASS COMPLETE',
        '- FAIL STOP',
        '',
        'Waiting.',
        '',
      ].join('\n'),
    );

    const rootStart = await runCliInProcess('run --prompted root-847.runbook.md', workspace);
    expect(rootStart.exitCode).toBe(0);
    const root = await getActiveState(workspace);
    expect(root).not.toBeNull();
    if (!root) throw new Error('expected active root run');

    const descendantStart = await runCliInProcess(
      'run descendant-847.runbook.md --step 1.1',
      workspace,
    );
    expect(descendantStart.exitCode).toBe(0);
    const descendant = await getActiveState(workspace);
    expect(descendant).not.toBeNull();
    if (!descendant) throw new Error('expected active inline descendant run');
    expect(descendant.parentLinkage).toEqual(
      expect.objectContaining({ kind: 'inline', parentRunId: root.id }),
    );

    const rootClaimId = requireEmittedRunClaim(workspace, root.id);

    // --- Step 1: force ONLY the root terminal, by name, via its own
    // run-control claim (the sanctioned orchestrator invocation).
    const stepOne = await runCliInProcess(['stop', '--claim-id', rootClaimId], workspace);
    // A bare/claim-driven force-stop is a failure terminal: non-zero exit.
    expect(stepOne.exitCode).toBe(1);

    // Intermediate assertions (must hold BEFORE the pin means anything):
    // root closed and released off the stack; descendant untouched, still
    // running, and still the session's active target.
    const rootAfterStepOne = await readRunbookState(workspace, root.id);
    expect(rootAfterStepOne?.lifecycle).toBe('stopped');

    const sessionAfterStepOne = await readSession(workspace);
    expect(sessionAfterStepOne.defaultStack).not.toContain(root.id);
    expect(sessionAfterStepOne.defaultStack).toContain(descendant.id);
    expect(sessionAfterStepOne.active).toBe(descendant.id);

    const descendantAfterStepOne = await readRunbookState(workspace, descendant.id);
    expect(descendantAfterStepOne?.lifecycle).toBe('running');

    const descendantClaimEntryAfterStepOne = Object.entries(sessionAfterStepOne.claims).find(
      ([, record]) => record.controlledRunId === descendant.id,
    );
    expect(descendantClaimEntryAfterStepOne).toBeDefined();

    // --- Step 2: a later ambient stop (no --run, no --claim-id). Resolves
    // the active run (the descendant), walks up to the now-terminal root, and
    // takes the already-terminal arm.
    const stepTwo = await runCliInProcess('stop', workspace);
    // The already-terminal arm reports success regardless of who is asking.
    expect(stepTwo.exitCode).toBe(0);

    // THE PIN. No terminal transition was ever applied to the descendant —
    // it is still `running`, exactly as after step 1 — so its run-control
    // claim record must be the SAME one, unrevoked, and it must still be
    // reachable on the default stack. Under the traced defect,
    // `releasesForInlineChain` marks the descendant `collateral`, and
    // `collateral` revokes: the claim entry is deleted and the descendant is
    // filtered off `defaultStack`, even though it was never forced terminal.
    const sessionAfterStepTwo = await readSession(workspace);
    const descendantClaimEntryAfterStepTwo = Object.entries(sessionAfterStepTwo.claims).find(
      ([, record]) => record.controlledRunId === descendant.id,
    );
    expect(descendantClaimEntryAfterStepTwo).toEqual(descendantClaimEntryAfterStepOne);
    expect(sessionAfterStepTwo.defaultStack).toContain(descendant.id);

    // And its persisted state was never touched by either step: still
    // `running`, confirming any loss above is a session-projection defect,
    // not a state transition this test staged by accident.
    const descendantAfterStepTwo = await readRunbookState(workspace, descendant.id);
    expect(descendantAfterStepTwo?.lifecycle).toBe('running');
  });
});
