import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RunbookActorService, StaleRunbookStateError } from '@rundown-org/core';
import {
  createTestWorkspace,
  runCliInProcess,
  getActiveState,
  readSession,
  readRunbookState,
  findActionOutput,
  type TestWorkspace,
} from '../helpers/test-utils.js';

interface DelegatePayload {
  token: string;
}

interface ClaimOutput extends Record<string, unknown> {
  claim_id: string;
}

describe('complete command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await workspace.cleanup();
  });

  it('completes through the machine and persists frontmatter finalVars', async () => {
    const runbook = `---
outputs:
  - Result
---
# Forced Complete Outputs

## 1. Work
- PASS CONTINUE
- FAIL STOP

The result is {{ Result }}.

## 2. Later
- PASS COMPLETE
- FAIL STOP

This step should not become the persisted cursor.
`;
    await writeFile(join(workspace.cwd, 'forced-complete-output.runbook.md'), runbook);
    await runCliInProcess(
      'run --prompted forced-complete-output.runbook.md --input Result=complete-final --text',
      workspace,
    );
    const stateBefore = await getActiveState(workspace);
    expect(stateBefore).not.toBeNull();
    expect(stateBefore!.step).toBe('1');

    const result = await runCliInProcess(
      ['complete', 'Enough evidence collected', '--text'],
      workspace,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('COMPLETE');

    const stateAfter = await readRunbookState(workspace, stateBefore!.id);
    expect(stateAfter!.step).toBe('1');
    expect(stateAfter!.lifecycle).toBe('completed');
    expect(stateAfter!.lastAction).toEqual({ type: 'COMPLETE' });
    expect(stateAfter!.finalVars).toEqual({ Result: 'complete-final' });
    expect(JSON.stringify(stateAfter!.snapshot)).toContain('Enough evidence collected');

    const session = await readSession(workspace);
    expect(session.active).toBeNull();
  });

  it('completes a delegated child by claim id and propagates pass to the parent', async () => {
    const parentRunbook = `# Parent Claim Complete

## 1. Parent delegates child
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child work
- child-prompted.runbook.md
`;
    const childRunbook = `# Child Prompted

## 1. Child waits
- PASS COMPLETE
- FAIL STOP
`;
    await writeFile(join(workspace.cwd, 'parent-claim-complete.runbook.md'), parentRunbook);
    await writeFile(join(workspace.cwd, 'child-prompted.runbook.md'), childRunbook);

    await runCliInProcess('run --prompted parent-claim-complete.runbook.md --text', workspace);
    const parentBefore = await getActiveState(workspace);
    expect(parentBefore).not.toBeNull();
    const delegate = await runCliInProcess(
      'delegate child-prompted.runbook.md --step 1.1',
      workspace,
    );
    const delegatePayload = JSON.parse(delegate.stdout) as DelegatePayload;
    const claim = await runCliInProcess(['claim', delegatePayload.token], workspace);
    const claimId = findActionOutput<ClaimOutput>(claim.stdout)?.claim_id;
    expect(typeof claimId).toBe('string');

    const result = await runCliInProcess(
      ['complete', '--claim-id', String(claimId), 'child has enough evidence', '--text'],
      workspace,
    );

    expect(result.exitCode).toBe(0);
    const session = await readSession(workspace);
    expect(session.active).toBeNull();
    const parentState = await readRunbookState(workspace, parentBefore!.id);
    expect(parentState!.lifecycle).toBe('completed');
    expect(parentState!.lastAction).toEqual({ type: 'COMPLETE' });
  });

  it('dispatches FORCE_COMPLETE and exits cleanly when sendAndSync returns null', async () => {
    const sendSpy = jest
      .spyOn(RunbookActorService.prototype, 'sendAndSync')
      .mockResolvedValueOnce(null);

    const runbook = `# Complete Null Sync

## 1. Work
- PASS COMPLETE
- FAIL STOP
`;
    await writeFile(join(workspace.cwd, 'complete-null-sync.runbook.md'), runbook);
    await runCliInProcess('run --prompted complete-null-sync.runbook.md --text', workspace);

    const result = await runCliInProcess(['complete', 'race', '--text'], workspace);

    expect(result.exitCode).toBe(0);
    const forceCompleteCall = sendSpy.mock.calls.find(
      (call) => (call[2] as { type: string }).type === 'FORCE_COMPLETE',
    );
    expect(forceCompleteCall?.[2]).toEqual({
      type: 'FORCE_COMPLETE',
      message: 'race',
    });
  });

  it('skips parent propagation in a real delegation when forced complete sync returns null', async () => {
    const parentRunbook = `# Parent Null Sync

## 1. Parent delegates child
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child work
- child-null-sync.runbook.md
`;
    const childRunbook = `# Child Null Sync

## 1. Child waits
- PASS COMPLETE
- FAIL STOP
`;
    await writeFile(join(workspace.cwd, 'parent-null-sync.runbook.md'), parentRunbook);
    await writeFile(join(workspace.cwd, 'child-null-sync.runbook.md'), childRunbook);

    await runCliInProcess('run --prompted parent-null-sync.runbook.md --text', workspace);
    const parentBefore = await getActiveState(workspace);
    expect(parentBefore).not.toBeNull();
    const delegate = await runCliInProcess(
      'delegate child-null-sync.runbook.md --step 1.1',
      workspace,
    );
    const delegatePayload = JSON.parse(delegate.stdout) as DelegatePayload;
    const claim = await runCliInProcess(['claim', delegatePayload.token], workspace);
    const claimId = findActionOutput<ClaimOutput>(claim.stdout)?.claim_id;
    expect(typeof claimId).toBe('string');

    // Install the spy AFTER delegate/claim so the FORCE_COMPLETE call is the
    // one consumed by mockResolvedValueOnce(null).
    const sendSpy = jest
      .spyOn(RunbookActorService.prototype, 'sendAndSync')
      .mockResolvedValueOnce(null);

    const result = await runCliInProcess(
      ['complete', '--claim-id', String(claimId), 'race', '--text'],
      workspace,
    );

    expect(result.exitCode).toBe(0);

    // FORCE_COMPLETE was dispatched against the child.
    const forceCompleteCall = sendSpy.mock.calls.find(
      (call) => (call[2] as { type: string }).type === 'FORCE_COMPLETE',
    );
    expect(forceCompleteCall?.[2]).toEqual({
      type: 'FORCE_COMPLETE',
      message: 'race',
    });

    // Parent state is untouched: still in-flight, no terminal lastAction propagated.
    const parentState = await readRunbookState(workspace, parentBefore!.id);
    expect(parentState!.lifecycle).toBe(parentBefore!.lifecycle);
    expect(parentState!.lastAction).not.toEqual({ type: 'COMPLETE' });
    expect(parentState!.lastAction).not.toEqual({ type: 'STOP' });
  });

  it('reports no active runbook', async () => {
    const result = await runCliInProcess('complete --text', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No active runbook');
  });

  describe('stale snapshot recovery', () => {
    it('cleans up when sendAndSync rejects with StaleRunbookStateError', async () => {
      const runbook = `# Stale Snapshot

## 1. Work
- PASS COMPLETE
- FAIL STOP
`;
      await writeFile(join(workspace.cwd, 'stale.runbook.md'), runbook);
      await runCliInProcess('run --prompted stale.runbook.md --text', workspace);
      const state = await getActiveState(workspace);
      const stateId = state!.id;

      jest
        .spyOn(RunbookActorService.prototype, 'sendAndSync')
        .mockRejectedValueOnce(new StaleRunbookStateError('snapshot incompatible'));

      const result = await runCliInProcess('complete --text', workspace);
      expect(result.exitCode).toBe(0);

      const session = await readSession(workspace);
      expect(session.active).toBeNull();
      expect(session.defaultStack).toHaveLength(0);
      expect(await readRunbookState(workspace, stateId)).toBeNull();
    });

    it('propagates non-stale sendAndSync errors instead of cleaning up', async () => {
      const runbook = `# Non-stale Error

## 1. Work
- PASS COMPLETE
- FAIL STOP
`;
      await writeFile(join(workspace.cwd, 'non-stale.runbook.md'), runbook);
      await runCliInProcess('run --prompted non-stale.runbook.md --text', workspace);
      const state = await getActiveState(workspace);
      const stateId = state!.id;

      jest
        .spyOn(RunbookActorService.prototype, 'sendAndSync')
        .mockRejectedValueOnce(new Error('boom'));

      const result = await runCliInProcess('complete --text', workspace);
      expect(result.exitCode).toBe(1);

      const session = await readSession(workspace);
      expect(session.defaultStack).toContain(stateId);
      expect(await readRunbookState(workspace, stateId)).not.toBeNull();
    });

    it('reports CLAIMED_RUNBOOK_UNAVAILABLE on stale snapshot for a claimed child', async () => {
      const parentRunbook = `## 1. Review
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child
Do child.
`;
      const childRunbook = `## 1. Child
- PASS COMPLETE
- FAIL STOP

Do work.
`;
      await writeFile(join(workspace.cwd, 'parent-claim.runbook.md'), parentRunbook);
      await writeFile(join(workspace.cwd, 'child-claim.runbook.md'), childRunbook);

      await runCliInProcess('run --prompted parent-claim.runbook.md --text', workspace);
      const parentState = await getActiveState(workspace);
      const parentId = parentState!.id;

      const delegate = await runCliInProcess(
        'delegate child-claim.runbook.md --step 1.1',
        workspace,
      );
      const { token } = JSON.parse(delegate.stdout) as DelegatePayload;
      const claim = await runCliInProcess(['claim', token], workspace);
      const claimId = findActionOutput<ClaimOutput>(claim.stdout)?.claim_id;
      expect(typeof claimId).toBe('string');

      jest
        .spyOn(RunbookActorService.prototype, 'sendAndSync')
        .mockRejectedValueOnce(new StaleRunbookStateError('snapshot incompatible'));

      const result = await runCliInProcess(
        ['complete', '--claim-id', String(claimId), '--text'],
        workspace,
      );
      expect(result.exitCode).toBe(1);
      // Parent stack untouched — claim-id path does not invoke cleanup.
      const session = await readSession(workspace);
      expect(session.defaultStack).toContain(parentId);
    });
  });

  it('does not propagate to parent or send FORCE_COMPLETE when state is already terminal', async () => {
    // Issue 3 regression: rd complete must NOT propagate to the parent
    // when the runbook is already terminal. FORCE_COMPLETE is a no-op at an
    // already-terminal machine, but the CLI was still calling
    // handleParentCompletion('pass', ...), mis-propagating to the parent.
    const runbook = `# Already Terminal Complete

## 1. Work
- PASS COMPLETE
- FAIL STOP
`;
    await writeFile(join(workspace.cwd, 'already-terminal-complete.runbook.md'), runbook);
    await runCliInProcess('run --prompted already-terminal-complete.runbook.md --text', workspace);
    const state = await getActiveState(workspace);
    expect(state).not.toBeNull();
    // Drive to terminal lifecycle: pass completes the runbook.
    await runCliInProcess('pass --text', workspace);

    // Resurrect the session entry so the next complete call finds the
    // terminal state (simulating the race the short-circuit guards).
    const fsp = await import('node:fs/promises');
    const sessionFile = join(workspace.statePath(), '..', 'session.json');
    const sessionRaw = await fsp.readFile(sessionFile, 'utf8');
    const session = JSON.parse(sessionRaw) as {
      active: string | null;
      defaultStack: readonly string[];
      claims: Record<string, unknown>;
    };
    await fsp.writeFile(
      sessionFile,
      JSON.stringify({ ...session, active: state!.id, defaultStack: [state!.id] }),
      'utf8',
    );

    const persistedState = await readRunbookState(workspace, state!.id);
    expect(persistedState?.lifecycle).toBe('completed');

    const sendSpy = jest.spyOn(RunbookActorService.prototype, 'sendAndSync');

    const result = await runCliInProcess('complete --text', workspace);

    expect(result.exitCode).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();

    const afterComplete = await readRunbookState(workspace, state!.id);
    expect(afterComplete?.lifecycle).toBe('completed');
  });
});
