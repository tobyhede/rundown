import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RunbookActorService, InvalidRunbookStateError } from '@rundown-org/core';
import {
  createTestWorkspace,
  runCliInProcess,
  getActiveState,
  readSession,
  readRunbookState,
  findActionOutput,
  parseConcatenatedJson,
  type TestWorkspace,
} from '../helpers/test-utils.js';

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
    expect(stateAfter!.lastAction).toEqual({ type: 'COMPLETE', origin: 'direct' });
    expect(stateAfter!.finalVars).toEqual({ Result: 'complete-final' });
    expect(JSON.stringify(stateAfter!.snapshot)).toContain('Enough evidence collected');

    const session = await readSession(workspace);
    expect(session.active).toBeNull();
  });

  it('completes a delegated child by claim id and reports pass to the delegating run (uncollected)', async () => {
    const parentRunbook = `# Parent Claim Complete

## 1. Parent delegates child
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child work
- DELEGATE

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
    const token = parentBefore?.substepStates?.[0]?.delegation?.token;
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
    const claim = await runCliInProcess(['claim', token!], workspace);
    const claimId = findActionOutput<ClaimOutput>(claim.stdout)?.claim_id;
    expect(typeof claimId).toBe('string');

    const result = await runCliInProcess(
      ['complete', '--claim-id', String(claimId), 'child has enough evidence', '--text'],
      workspace,
    );

    expect(result.exitCode).toBe(0);
    // Plan 5 (report-only): the child close records its PASS outcome on the
    // delegating run, which is left collection pending — NOT auto-advanced. The
    // delegating run only completes once its orchestrator runs `rd collect`.
    const parentState = await readRunbookState(workspace, parentBefore!.id);
    const rows = Object.values(parentState!.resolvedCompletions ?? {}).filter(
      (c) => c.agentId === 'delegation',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('pass');
    expect(parentState!.lifecycle).toBe('running');
    expect(parentState!.step).toBe('1');
    expect(parentState!.lastAction).not.toEqual({ type: 'COMPLETE', origin: 'aggregation' });
  });

  it('dispatches FORCE_COMPLETE but reports a race (exit 1) when the root sendAndSync returns null', async () => {
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

    // The resolved root raced to null, so it was never forced. `complete` must
    // NOT report a clean completion (that would propagate a still-running root as
    // a pass); it surfaces the race and exits non-zero so the user can retry.
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('Runbook state changed');
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
- DELEGATE

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
    const token = parentBefore?.substepStates?.[0]?.delegation?.token;
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
    const claim = await runCliInProcess(['claim', token!], workspace);
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

    // The claimed child raced to null (its state vanished between resolve and
    // dispatch): there is nothing to force or record. A claim-path race is a
    // benign no-op close (the child is already gone), so it stays command-success
    // (exit 0) and never propagates to the parent — distinct from a bare-path race
    // (the operator's own run), which exits non-zero for a retry.
    expect(result.exitCode).toBe(0);

    // FORCE_COMPLETE was dispatched against the child.
    const forceCompleteCall = sendSpy.mock.calls.find(
      (call) => (call[2] as { type: string }).type === 'FORCE_COMPLETE',
    );
    expect(forceCompleteCall?.[2]).toEqual({
      type: 'FORCE_COMPLETE',
      message: 'race',
    });

    // Parent state is untouched: still in-flight, no terminal lastAction propagated
    // (the seam recorded nothing to the delegating run for a child it never forced).
    const parentState = await readRunbookState(workspace, parentBefore!.id);
    expect(parentState!.lifecycle).toBe(parentBefore!.lifecycle);
    expect(parentState!.lastAction).not.toEqual({ type: 'COMPLETE', origin: 'direct' });
    expect(parentState!.lastAction).not.toEqual({ type: 'STOP', origin: 'direct' });
  });

  it('reports no active runbook', async () => {
    const result = await runCliInProcess('complete --text', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No active runbook');
  });

  describe('invalid snapshot recovery', () => {
    it('cleans up when sendAndSync rejects with InvalidRunbookStateError', async () => {
      const runbook = `# Invalid Snapshot

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
        .mockRejectedValueOnce(new InvalidRunbookStateError('snapshot incompatible'));

      const result = await runCliInProcess('complete --text', workspace);
      expect(result.exitCode).toBe(0);

      const session = await readSession(workspace);
      expect(session.active).toBeNull();
      expect(session.defaultStack).toHaveLength(0);
      expect(await readRunbookState(workspace, stateId)).toBeNull();
    });

    it('propagates non-invalid sendAndSync errors instead of cleaning up', async () => {
      const runbook = `# Non-stale Error

## 1. Work
- PASS COMPLETE
- FAIL STOP
`;
      await writeFile(join(workspace.cwd, 'non-invalid.runbook.md'), runbook);
      await runCliInProcess('run --prompted non-invalid.runbook.md --text', workspace);
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

    it('reports CLAIMED_RUNBOOK_UNAVAILABLE on invalid snapshot for a claimed child', async () => {
      const parentRunbook = `## 1. Review
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child
- DELEGATE

Do child.

- child-claim.runbook.md
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

      const token = parentState?.substepStates?.[0]?.delegation?.token;
      expect(token).toEqual(expect.stringMatching(/^rdtk_/));
      const claim = await runCliInProcess(['claim', token!], workspace);
      const claimId = findActionOutput<ClaimOutput>(claim.stdout)?.claim_id;
      expect(typeof claimId).toBe('string');

      jest
        .spyOn(RunbookActorService.prototype, 'sendAndSync')
        .mockRejectedValueOnce(new InvalidRunbookStateError('snapshot incompatible'));

      const result = await runCliInProcess(
        ['complete', '--claim-id', String(claimId), '--text'],
        workspace,
      );
      expect(result.exitCode).toBe(1);
      // Parent stack untouched — claim-id path does not invoke cleanup.
      const session = await readSession(workspace);
      expect(session.defaultStack).toContain(parentId);
    });

    it('releases a terminal claimed child as an idempotent no-op', async () => {
      const parentRunbook = `## 1. Review
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Child
- DELEGATE

Do child.

- child-terminal-complete.runbook.md
`;
      const childRunbook = `## 1. Child
- PASS COMPLETE

Do work.
`;
      await writeFile(join(workspace.cwd, 'parent-terminal-complete.runbook.md'), parentRunbook);
      await writeFile(join(workspace.cwd, 'child-terminal-complete.runbook.md'), childRunbook);

      let result = await runCliInProcess(
        'run --prompted parent-terminal-complete.runbook.md --text',
        workspace,
      );
      expect(result.exitCode).toBe(0);
      const parentState = await getActiveState(workspace);
      const token = parentState?.substepStates?.[0]?.delegation?.token;
      expect(token).toEqual(expect.stringMatching(/^rdtk_/));
      if (typeof token !== 'string') throw new Error('Expected delegation token');
      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      const claimOutput = findActionOutput(result.stdout);
      const childRunId = String(claimOutput?.run_id);
      const claimId = String(claimOutput?.claim_id);

      const childState = await readRunbookState(workspace, childRunId);
      expect(childState).not.toBeNull();
      await writeFile(
        join(workspace.statePath(), `${childRunId}.json`),
        JSON.stringify({ ...childState, lifecycle: 'completed' }, null, 2),
      );

      result = await runCliInProcess(['complete', '--claim-id', claimId], workspace);

      expect(result.exitCode).toBe(0);
      const session = await readSession(workspace);
      // Item 4: the terminal claim is RETAINED as a tombstone (release with
      // retainClaimsAsTerminal) so a later --claim-id can confirm/conflict again.
      expect(Object.values(session.claims)).toContainEqual(expect.objectContaining({ childRunId }));
      expect(session.defaultStack).toContain(parentState!.id);
    });

    it('rd complete --claim-id on a stopped child conflicts (DELEGATION_RESULT_CONFLICT)', async () => {
      const parentRunbook = `## 1. Review
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Child
- DELEGATE

Do child.

- child-conflict-complete.runbook.md
`;
      const childRunbook = `## 1. Child
- PASS COMPLETE

Do work.
`;
      await writeFile(join(workspace.cwd, 'parent-conflict-complete.runbook.md'), parentRunbook);
      await writeFile(join(workspace.cwd, 'child-conflict-complete.runbook.md'), childRunbook);

      let result = await runCliInProcess(
        'run --prompted parent-conflict-complete.runbook.md --text',
        workspace,
      );
      expect(result.exitCode).toBe(0);
      const parentState = await getActiveState(workspace);
      const token = parentState?.substepStates?.[0]?.delegation?.token;
      expect(token).toEqual(expect.stringMatching(/^rdtk_/));
      if (typeof token !== 'string') throw new Error('Expected delegation token');
      result = await runCliInProcess(`claim ${token}`, workspace);
      const claimOutput = findActionOutput(result.stdout);
      const childRunId = String(claimOutput?.run_id);
      const claimId = String(claimOutput?.claim_id);

      // Drive the claimed child to STOPPED, then attempt `complete` on it: the
      // requested command (complete → expects completed) conflicts with the
      // child's `stopped` lifecycle, so the seam refuses with a typed conflict.
      const childState = await readRunbookState(workspace, childRunId);
      if (!childState) throw new Error('Expected claimed child state to exist');
      await writeFile(
        join(workspace.statePath(), `${childRunId}.json`),
        JSON.stringify({ ...childState, lifecycle: 'stopped' }, null, 2),
      );

      result = await runCliInProcess(['complete', '--claim-id', claimId], workspace);

      // The seam streams JSON; scan the concatenated objects for the refusal code.
      const codes = parseConcatenatedJson(result.stdout).map((o) => (o as { code?: string }).code);
      expect(codes).toContain('DELEGATION_RESULT_CONFLICT');
      expect(result.exitCode).not.toBe(0);
      // Still retained as a tombstone (conflict path releases with retain too).
      const session = await readSession(workspace);
      expect(Object.values(session.claims)).toContainEqual(expect.objectContaining({ childRunId }));
    });
  });

  it('does not propagate to parent or send FORCE_COMPLETE when state is already terminal', async () => {
    // Issue 3 regression: rd complete must NOT propagate to the parent
    // when the runbook is already terminal. FORCE_COMPLETE is a no-op at an
    // already-terminal machine, but the CLI was still calling
    // propagateChildTerminal(state, 'pass', ...), mis-propagating to the parent.
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

  it('bare complete from an inline child completes the outermost contiguous-inline ancestor', async () => {
    await writeFile(
      join(workspace.cwd, 'parent-force-complete.runbook.md'),
      `# Parent Force Complete

## 1. Compose
- PASS CONTINUE
- FAIL STOP

### 1.1 Inline child
Launch child here.

## 2. Later
- PASS COMPLETE
- FAIL STOP
`,
    );
    await writeFile(
      join(workspace.cwd, 'child-force-complete.runbook.md'),
      `# Child Force Complete

## 1. Waiting
- PASS COMPLETE
- FAIL STOP

Waiting.
`,
    );

    await runCliInProcess('run --prompted parent-force-complete.runbook.md', workspace);
    const parent = await getActiveState(workspace);
    expect(parent).not.toBeNull();

    await runCliInProcess('run child-force-complete.runbook.md --step 1.1', workspace);
    const child = await getActiveState(workspace);
    expect(child?.parentLinkage?.kind).toBe('inline');

    const result = await runCliInProcess(['complete', 'workflow done'], workspace);

    expect(result.exitCode).toBe(0);
    const parentAfter = await readRunbookState(workspace, parent!.id);
    const childAfter = await readRunbookState(workspace, child!.id);
    expect(parentAfter!.lifecycle).toBe('completed');
    expect(childAfter!.lifecycle).toBe('completed');
    const session = await readSession(workspace);
    expect(session.defaultStack).not.toContain(parent!.id);
    expect(session.defaultStack).not.toContain(child!.id);
  });
});
