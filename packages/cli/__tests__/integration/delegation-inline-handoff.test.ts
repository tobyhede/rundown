import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  findActionOutput,
  getActiveState,
  getAllStates,
  readRunbookState,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import type { RunbookState } from '@rundown-org/core';

// Stage 1 is DELEGATE'd to a worker; stages 2 and 3 are INLINE-composed gate
// children. The bug: when `rd collect` applies the delegated stage and advances
// the parent INTO the inline stage-2 gate, the gate child is never launched and
// never made default-active — so a bare `rd pass` rubber-stamps the gate.
const PIPELINE = `# Pipeline

## 1. Plan

- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Write plan

- DELEGATE
- worker.runbook.md

## 2. Review

- PASS ALL CONTINUE
- FAIL ANY STOP
- gate.runbook.md

## 3. Execute

- PASS ALL COMPLETE
- FAIL ANY STOP
- gate.runbook.md
`;

const WORKER = `# Worker

## 1. Do work

- PASS COMPLETE
- FAIL STOP

Do the delegated work.
`;

const GATE = `# Gate

## 1. Check

- PASS COMPLETE
- FAIL STOP

Check the gate.
`;

const COLLECTING_GATE = `# Collecting Gate

## 1. Delegate check

- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Check

- DELEGATE
- worker.runbook.md
`;

/** Find a launched inline child run whose parent is the given run. */
function findInlineChild(states: RunbookState[], parentRunId: string): RunbookState | undefined {
  return states.find((s) => {
    const link = s.parentLinkage;
    return link?.kind === 'inline' && link.parentRunId === parentRunId;
  });
}

describe('delegation -> collect -> inline handoff', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('launches and activates the inline child when collect advances into an inline stage', async () => {
    await writeFile(join(workspace.runbooksDir(), 'pipeline.runbook.md'), PIPELINE);
    await writeFile(join(workspace.runbooksDir(), 'worker.runbook.md'), WORKER);
    await writeFile(join(workspace.runbooksDir(), 'gate.runbook.md'), GATE);

    const start = await runCliInProcess('run --prompted pipeline.runbook.md', workspace);
    expect(start.exitCode).toBe(0);

    const parent = await getActiveState(workspace);
    expect(parent).not.toBeNull();
    const parentRunId = parent!.id;
    const token = parent!.substepStates!.find((s) => s.delegation?.token)!.delegation!.token!;

    // Claim + explicitly close the delegated worker -> REPORTS the outcome (report-only).
    const claim = await runCliInProcess(`claim ${token}`, workspace);
    expect(claim.exitCode).toBe(0);
    const claimId = String(findActionOutput(claim.stdout)!.claim_id);
    const closed = await runCliInProcess(['complete', '--claim-id', claimId], workspace);
    expect(closed.exitCode).toBe(0);

    // Collect applies the reported outcome -> stage 1 PASS ALL -> CONTINUE -> stage 2.
    const collected = await runCliInProcess('collect', workspace);
    expect(collected.exitCode).toBe(0);

    // The parent advanced into stage 2 (the inline gate stage), still running.
    const parentAfter = await readRunbookState(workspace, parentRunId);
    expect(parentAfter!.step).toBe('2');
    expect(parentAfter!.lifecycle).toBe('running');

    // The inline gate CHILD was launched (THE BUG: currently it is not).
    const states = await getAllStates(workspace);
    const inlineChild = findInlineChild(states, parentRunId);
    expect(inlineChild).toBeDefined();

    // The inline child is DEFAULT-ACTIVE, not the parent (THE BUG: currently the parent is).
    const active = await getActiveState(workspace);
    expect(active!.id).toBe(inlineChild!.id);

    // So a bare `rd pass` resolves the inline child's step, not the parent's
    // stage-2 composite substep (no rubber-stamp).
    const pass = await runCliInProcess('pass', workspace);
    expect(pass.exitCode).toBe(0);
  }, 30_000);

  it('propagates an inline child that reaches terminal through collect', async () => {
    await writeFile(join(workspace.runbooksDir(), 'pipeline.runbook.md'), PIPELINE);
    await writeFile(join(workspace.runbooksDir(), 'worker.runbook.md'), WORKER);
    await writeFile(join(workspace.runbooksDir(), 'gate.runbook.md'), COLLECTING_GATE);

    const start = await runCliInProcess('run --prompted pipeline.runbook.md', workspace);
    expect(start.exitCode).toBe(0);

    const parent = await getActiveState(workspace);
    expect(parent).not.toBeNull();
    const parentRunId = parent!.id;
    const token = parent!.substepStates!.find((s) => s.delegation?.token)!.delegation!.token!;

    const claim = await runCliInProcess(`claim ${token}`, workspace);
    expect(claim.exitCode).toBe(0);
    const claimId = String(findActionOutput(claim.stdout)!.claim_id);
    const closed = await runCliInProcess(['complete', '--claim-id', claimId], workspace);
    expect(closed.exitCode).toBe(0);

    const collected = await runCliInProcess('collect', workspace);
    expect(collected.exitCode).toBe(0);

    const inlineChild = findInlineChild(await getAllStates(workspace), parentRunId);
    expect(inlineChild).toBeDefined();
    expect((await getActiveState(workspace))!.id).toBe(inlineChild!.id);

    const childToken = inlineChild!.substepStates!.find((s) => s.delegation?.token)!.delegation!
      .token!;
    const childClaim = await runCliInProcess(`claim ${childToken}`, workspace);
    expect(childClaim.exitCode).toBe(0);
    const childClaimId = String(findActionOutput(childClaim.stdout)!.claim_id);
    const childClosed = await runCliInProcess(['complete', '--claim-id', childClaimId], workspace);
    expect(childClosed.exitCode).toBe(0);

    const childCollected = await runCliInProcess('collect', workspace);
    expect(childCollected.exitCode).toBe(0);

    const parentAfter = await readRunbookState(workspace, parentRunId);
    expect(parentAfter!.step).toBe('3');
    expect(parentAfter!.lifecycle).toBe('running');
    expect((await getActiveState(workspace))!.id).not.toBe(inlineChild!.id);
  }, 30_000);

  it('bare complete from the collected inline gate does not cross the prior delegation boundary', async () => {
    await writeFile(join(workspace.runbooksDir(), 'pipeline.runbook.md'), PIPELINE);
    await writeFile(join(workspace.runbooksDir(), 'worker.runbook.md'), WORKER);
    await writeFile(join(workspace.runbooksDir(), 'gate.runbook.md'), GATE);

    const start = await runCliInProcess('run --prompted pipeline.runbook.md', workspace);
    expect(start.exitCode).toBe(0);

    const parent = await getActiveState(workspace);
    expect(parent).not.toBeNull();
    const parentRunId = parent!.id;
    const token = parent!.substepStates!.find((s) => s.delegation?.token)!.delegation!.token!;

    const claim = await runCliInProcess(`claim ${token}`, workspace);
    expect(claim.exitCode).toBe(0);
    const claimId = String(findActionOutput(claim.stdout)!.claim_id);
    const closed = await runCliInProcess(['complete', '--claim-id', claimId], workspace);
    expect(closed.exitCode).toBe(0);

    const collected = await runCliInProcess('collect', workspace);
    expect(collected.exitCode).toBe(0);

    const inlineChild = findInlineChild(await getAllStates(workspace), parentRunId);
    expect(inlineChild).toBeDefined();
    expect((await getActiveState(workspace))!.id).toBe(inlineChild!.id);

    const close = await runCliInProcess(['complete', 'inline gate done'], workspace);
    expect(close.exitCode).toBe(0);

    const inlineAfter = await readRunbookState(workspace, inlineChild!.id);
    const parentAfter = await readRunbookState(workspace, parentRunId);

    expect(inlineAfter!.lifecycle).toBe('completed');
    expect(parentAfter!.lifecycle).toBe('completed');
    expect(parentAfter!.step).toBe('2');
  }, 30_000);
});
