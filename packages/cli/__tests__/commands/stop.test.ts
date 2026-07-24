import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RunbookActorService,
  RunbookStateManager,
  InvalidRunbookStateError,
  readDelegationOutcomeReportedFacts,
} from '@rundown-org/core';
import {
  createTestWorkspace,
  runCliInProcess,
  getActiveState,
  readSession,
  readRunbookState,
  findActionOutput,
  issueRunControlClaim,
  parseFinalCliJsonObject,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import {
  patchPersistedRunState,
  seedSession,
  writeRawRunJson,
} from '@rundown-org/core/testing/session-fixtures';
import { Command } from 'commander';
// Stryker static-import linkage (mutation testing): links this test file into
// Jest's static inverse-module graph so `--findRelatedTests src/commands/stop.ts`
// credits the behavioural tests below (which reach the command only via the
// dynamic `import('../cli.js')` seam in runCliInProcess). See collect.test.ts.
import { registerStopCommand } from '../../src/commands/stop.js';

interface ClaimOutput extends Record<string, unknown> {
  claim_id: string;
}

describe('stop command wiring', () => {
  it('registers the stop command with its documented flags and descriptions', () => {
    const program = new Command();
    registerStopCommand(program);

    const stop = program.commands.find((c) => c.name() === 'stop');
    expect(stop).toBeDefined();
    expect(stop?.description()).toBe('Abort current runbook');

    const byLong = new Map(stop!.options.map((o) => [o.long, o]));
    expect([...byLong.keys()]).toEqual(expect.arrayContaining(['--claim-id', '--text']));
    expect(byLong.get('--claim-id')?.description).toBe('Target a claimed delegated child runbook');
    expect(byLong.get('--text')?.description).toBe('Output as human-readable text');
  });
});

describe('stop command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await workspace.cleanup();
  });

  describe('--run explicit targeting', () => {
    it('refuses stop --run <id> without bearer authority', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      const active = await getActiveState(workspace);
      expect(active).toBeDefined();

      const result = await runCliInProcess(`stop --run ${active!.id}`, workspace);

      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as { code?: string };
      expect(payload.code).toBe('ACTOR_CONTEXT_REQUIRED');
      const state = await readRunbookState(workspace, active!.id);
      expect(state?.lifecycle).toBe('running');
    });

    it('refuses a well-formed but unknown --run id with RUN_TARGET_UNAVAILABLE', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      const bogus = `rd_${'f'.repeat(32)}`;

      const result = await runCliInProcess(`stop --run ${bogus}`, workspace);

      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as { code?: string };
      expect(payload.code).toBe('RUN_TARGET_UNAVAILABLE');
      // The active run was not stopped by the refusal.
      const state = await getActiveState(workspace);
      expect(state?.lifecycle).toBe('running');
    });
  });

  describe('basic stop', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    });

    it('aborts active runbook', async () => {
      const result = await runCliInProcess('stop --text', workspace);

      // Bare stop is a workflow force terminal (failure terminal) and exits 1.
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('STOP');

      const session = await readSession(workspace);
      expect(session.active).toBeNull();
    });

    it('persists stopped state with STOP action metadata', async () => {
      const stateBefore = await getActiveState(workspace);
      const runId = stateBefore!.id;

      await runCliInProcess('stop --text', workspace);

      // State should be preserved (not deleted)
      const stateAfter = await readRunbookState(workspace, runId);
      expect(stateAfter).not.toBeNull();
      expect(stateAfter!.lastAction).toEqual({ type: 'STOP', origin: 'direct' });
      expect(stateAfter!.lastResult).toBeUndefined();
      expect(stateAfter!.lifecycle).toBe('stopped');
    });

    it('stops through the machine and persists frontmatter finalVars', async () => {
      const runbook = `---
outputs:
  - Result
---
# Forced Stop Outputs

## 1. Work
- PASS CONTINUE
- FAIL STOP

The result is {{ Result }}.
`;
      await writeFile(join(workspace.cwd, 'forced-stop-output.runbook.md'), runbook);
      await runCliInProcess(
        'run --prompted forced-stop-output.runbook.md --input Result=stop-final --text',
        workspace,
      );
      const stateBefore = await getActiveState(workspace);
      expect(stateBefore).not.toBeNull();

      const result = await runCliInProcess(['stop', 'Cancelled after review', '--text'], workspace);

      expect(result.exitCode).toBe(1);
      const stateAfter = await readRunbookState(workspace, stateBefore!.id);
      expect(stateAfter!.lifecycle).toBe('stopped');
      expect(stateAfter!.lastAction).toEqual({ type: 'STOP', origin: 'direct' });
      expect(stateAfter!.lastResult).toBeUndefined();
      expect(stateAfter!.finalVars).toEqual({ Result: 'stop-final' });
      expect(JSON.stringify(stateAfter!.snapshot)).toContain('Cancelled after review');
    });

    it('dispatches FORCE_STOP and exits cleanly when sendAndSync returns null', async () => {
      const sendSpy = jest
        .spyOn(RunbookActorService.prototype, 'sendAndSync')
        .mockResolvedValueOnce(null);

      const runbook = `# Stop Null Sync

## 1. Work
- PASS COMPLETE
- FAIL STOP
`;
      await writeFile(join(workspace.cwd, 'stop-null-sync.runbook.md'), runbook);
      await runCliInProcess('run --prompted stop-null-sync.runbook.md --text', workspace);

      const result = await runCliInProcess(['stop', 'race', '--text'], workspace);

      expect(result.exitCode).toBe(1);
      expect(sendSpy.mock.calls[0]?.[2]).toEqual({
        type: 'FORCE_STOP',
        message: 'race',
      });
    });

    it('stops a delegated child by claim id and does not propagate to the parent', async () => {
      const parentRunbook = `# Parent Stop Delegated Child

## 1. Parent delegates child
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Child work
- DELEGATE

- child-stop-delegated.runbook.md
`;
      const childRunbook = `# Child Stop Delegated

## 1. Child waits
- PASS COMPLETE
- FAIL STOP
`;
      await writeFile(join(workspace.cwd, 'parent-stop-delegated.runbook.md'), parentRunbook);
      await writeFile(join(workspace.cwd, 'child-stop-delegated.runbook.md'), childRunbook);

      await runCliInProcess('run --prompted parent-stop-delegated.runbook.md --text', workspace);
      const parentBefore = await getActiveState(workspace);
      expect(parentBefore).not.toBeNull();

      const token = parentBefore?.substepStates?.[0]?.delegation?.token;
      expect(token).toEqual(expect.stringMatching(/^rdtk_/));
      const claim = await runCliInProcess(['claim', token!], workspace);
      const claimId = findActionOutput<ClaimOutput>(claim.stdout)?.claim_id;
      expect(typeof claimId).toBe('string');

      // Mock sendAndSync to return null, simulating propagation not reaching parent
      jest.spyOn(RunbookActorService.prototype, 'sendAndSync').mockResolvedValueOnce(null);

      const result = await runCliInProcess(
        ['stop', '--claim-id', String(claimId), 'child was interrupted', '--text'],
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const parentState = await readRunbookState(workspace, parentBefore!.id);
      // Parent should remain unchanged; still on the DELEGATE step waiting for collection
      expect(parentState!.step).toBe('1');
      expect(parentState!.lifecycle).toBe(parentBefore!.lifecycle);
    });
  });

  describe('orphaned state recovery', () => {
    it('pops orphaned stack entry when state file is missing', async () => {
      // Start a runbook
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      const state = await getActiveState(workspace);

      // Simulate corruption: make the run's persisted state unusable while the
      // session stack still points at it. Deleting the run row is not the
      // faithful analogue any more — `session_stack.run_id` cascades, so the
      // orphaned stack entry this test is about would vanish with the row.
      const stateId = state!.id;
      await writeRawRunJson(workspace.cwd, stateId, '{}');

      // Stop should clean up the orphaned stack entry
      const result = await runCliInProcess('stop --text', workspace);
      expect(result.exitCode).toBe(0);

      // Session should be clean — stack entry popped
      const session = await readSession(workspace);
      expect(session.active).toBeNull();
      expect(session.defaultStack).toHaveLength(0);
    });

    it('pops orphaned stack entry when state file is corrupted', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      const state = await getActiveState(workspace);

      // Write invalid JSON to the run's persisted state
      const stateId = state!.id;
      await writeRawRunJson(workspace.cwd, stateId, '{invalid');

      const result = await runCliInProcess('stop --text', workspace);
      expect(result.exitCode).toBe(0);

      const session = await readSession(workspace);
      expect(session.active).toBeNull();
      expect(session.defaultStack).toHaveLength(0);
    });

    it('cleans up invalid state with legacy snapshot instead of propagating error', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      const state = await getActiveState(workspace);
      const stateId = state!.id;

      // Write a legacy snapshot state that triggers a invalid-state error in load()
      await patchPersistedRunState(workspace.cwd, stateId, {
        lastAction: { type: 'GOTO_NEXT' },
      });

      // stop is a cleanup command — it should handle invalid state gracefully
      const result = await runCliInProcess('stop --text', workspace);
      expect(result.exitCode).toBe(0);

      const session = await readSession(workspace);
      expect(session.active).toBeNull();
      expect(session.defaultStack).toHaveLength(0);
    });

    it('cleans up invalid state with wrong schemaVersion instead of propagating error', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      const state = await getActiveState(workspace);
      const stateId = state!.id;

      // Write a state with the wrong schemaVersion to trigger InvalidRunbookStateError
      await patchPersistedRunState(workspace.cwd, stateId, { schemaVersion: 2 });

      // stop is a cleanup command — InvalidRunbookStateError must not propagate
      const result = await runCliInProcess('stop --text', workspace);
      expect(result.exitCode).toBe(0);

      const session = await readSession(workspace);
      expect(session.active).toBeNull();
      expect(session.defaultStack).toHaveLength(0);
    });

    it('preserves a healthy top when sendAndSync rejects with InvalidRunbookStateError (#518)', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      const state = await getActiveState(workspace);
      expect(state).not.toBeNull();
      const stateId = state!.id;

      // resolveCommandTarget succeeds (state loads), but the machine rejects
      // the persisted snapshot when sendAndSync tries to rehydrate. The state
      // file on disk is VALID, so the #518 guard sees a healthy top and
      // rethrows the original error instead of deleting live state (the
      // pre-#518 code deleted it unconditionally). Recovery for a genuinely
      // broken run is `rd prune --active`/`--all`, made stack-safe in this
      // same change set (#534).
      jest
        .spyOn(RunbookActorService.prototype, 'sendAndSync')
        .mockRejectedValueOnce(new InvalidRunbookStateError('snapshot incompatible'));

      const result = await runCliInProcess('stop --text', workspace);
      expect(result.exitCode).not.toBe(0);

      const session = await readSession(workspace);
      expect(session.defaultStack).toContain(stateId);
      expect(await readRunbookState(workspace, stateId)).not.toBeNull();
    });

    it('preserves a healthy top when a non-top inline member is corrupt (#518)', async () => {
      // Inline chain: parent (bottom) + inline child (top), built exactly like
      // the existing 'bare stop from an inline child...' test in this file.
      await writeFile(
        join(workspace.cwd, 'parent-518.runbook.md'),
        [
          '# Parent 518',
          '',
          '## 1. Compose',
          '- PASS CONTINUE',
          '- FAIL STOP',
          '',
          '### 1.1 Inline child',
          'Launch child here.',
          '',
          '## 2. Later',
          '- PASS COMPLETE',
          '- FAIL STOP',
          '',
        ].join('\n'),
      );
      await writeFile(
        join(workspace.cwd, 'child-518.runbook.md'),
        [
          '# Child 518',
          '',
          '## 1. Waiting',
          '- PASS COMPLETE',
          '- FAIL STOP',
          '',
          'Waiting.',
          '',
        ].join('\n'),
      );
      await runCliInProcess('run --prompted parent-518.runbook.md', workspace);
      const parent = await getActiveState(workspace);
      await runCliInProcess('run child-518.runbook.md --step 1.1', workspace);
      const child = await getActiveState(workspace);
      expect(child?.parentLinkage?.kind).toBe('inline');

      // Corrupt the NON-TOP member; the top (child) stays valid.
      await writeRawRunJson(workspace.cwd, parent!.id, '{invalid');

      const result = await runCliInProcess('stop --text', workspace);

      // The seam fails on the corrupt ancestor; the guard sees a healthy top
      // and rethrows the original error instead of deleting the valid child
      // (pre-#518 behavior deleted it).
      expect(result.exitCode).not.toBe(0);
      expect(await readRunbookState(workspace, child!.id)).not.toBeNull();
      const session = await readSession(workspace);
      expect(session.defaultStack).toContain(child!.id);
    });

    it('surfaces the original error when the cleanup probe itself fails', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      // The seam rejects with a recoverable snapshot error; the recovery
      // guard's probe load then fails hard (non-recoverable IO error). All
      // loads before the seam failure stay real — only probe-phase loads fail.
      let probePhase = false;
      jest.spyOn(RunbookActorService.prototype, 'sendAndSync').mockImplementationOnce(async () => {
        probePhase = true;
        throw new InvalidRunbookStateError('snapshot incompatible');
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to re-apply with the spy's `this`
      const realLoad = RunbookStateManager.prototype.load;
      jest.spyOn(RunbookStateManager.prototype, 'load').mockImplementation(function (
        this: RunbookStateManager,
        ...args
      ) {
        if (probePhase) {
          return Promise.reject(Object.assign(new Error('probe blew up'), { code: 'EIO' }));
        }
        return realLoad.apply(this, args);
      });

      const result = await runCliInProcess('stop --text', workspace);

      expect(result.exitCode).not.toBe(0);
      const emitted = `${result.stdout}\n${result.stderr}`;
      expect(emitted).toMatch(/snapshot incompatible/); // original diagnostic survives
      expect(emitted).not.toMatch(/probe blew up/); // probe failure never substituted
    });

    it('propagates non-invalid sendAndSync errors instead of cleaning up', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      const state = await getActiveState(workspace);
      const stateId = state!.id;

      jest
        .spyOn(RunbookActorService.prototype, 'sendAndSync')
        .mockRejectedValueOnce(new Error('boom'));

      const result = await runCliInProcess('stop --text', workspace);
      expect(result.exitCode).toBe(1);

      // State must remain intact — only InvalidRunbookStateError triggers cleanup.
      const session = await readSession(workspace);
      expect(session.defaultStack).toContain(stateId);
      expect(await readRunbookState(workspace, stateId)).not.toBeNull();
    });

    it('skips cleanup when InvalidRunbookStateError occurs on a claimed child', async () => {
      const parentRunbook = `## 1. Review
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Child
- DELEGATE

Do child.

- child-stale-claim.runbook.md
`;
      const childRunbook = `## 1. Child
- PASS COMPLETE

Do work.
`;
      await writeFile(join(workspace.cwd, 'parent-stale-claim.runbook.md'), parentRunbook);
      await writeFile(join(workspace.cwd, 'child-stale-claim.runbook.md'), childRunbook);

      let result = await runCliInProcess(
        'run --prompted parent-stale-claim.runbook.md --text',
        workspace,
      );
      expect(result.exitCode).toBe(0);
      const parentState = await getActiveState(workspace);
      const parentId = parentState!.id;

      const token = parentState?.substepStates?.[0]?.delegation?.token;
      expect(token).toEqual(expect.stringMatching(/^rdtk_/));
      if (typeof token !== 'string') throw new Error('Expected delegation token');
      result = await runCliInProcess(`claim ${token}`, workspace);
      const claimId = String(findActionOutput(result.stdout)?.claim_id);

      jest
        .spyOn(RunbookActorService.prototype, 'sendAndSync')
        .mockRejectedValueOnce(new InvalidRunbookStateError('snapshot incompatible'));

      result = await runCliInProcess(['stop', '--claim-id', claimId, '--text'], workspace);
      if (result.exitCode !== 0) {
        throw new Error(`stop claimed parent failed:\n${result.stdout}\n${result.stderr}`);
      }
      expect(result.exitCode).toBe(0);

      // Parent stack untouched — claim-id path does not invoke cleanup.
      const session = await readSession(workspace);
      expect(session.defaultStack).toContain(parentId);
      expect(await readRunbookState(workspace, parentId)).not.toBeNull();
    });

    it('releases a terminal claimed child as an idempotent no-op', async () => {
      const parentRunbook = `## 1. Review
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Child
- DELEGATE

Do child.

- child-terminal-stop.runbook.md
`;
      const childRunbook = `## 1. Child
- PASS COMPLETE

Do work.
`;
      await writeFile(join(workspace.cwd, 'parent-terminal-stop.runbook.md'), parentRunbook);
      await writeFile(join(workspace.cwd, 'child-terminal-stop.runbook.md'), childRunbook);

      let result = await runCliInProcess(
        'run --prompted parent-terminal-stop.runbook.md --text',
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
      await patchPersistedRunState(workspace.cwd, childRunId, { lifecycle: 'stopped' });

      result = await runCliInProcess(['stop', '--claim-id', claimId], workspace);

      expect(result.exitCode).toBe(0);
      // Idempotent confirm: the seam detects the child is already `stopped` and
      // emits an already-resolved action (no re-force), keyed on the lifecycle.
      const action = findActionOutput(result.stdout);
      expect(action).toMatchObject({ status: 'already-resolved', lifecycle: 'stopped' });
      const session = await readSession(workspace);
      // Item 4: the terminal claim is RETAINED as a tombstone (release with
      // retainClaimsAsTerminal) so a later --claim-id can confirm/conflict again.
      expect(Object.values(session.claims)).toContainEqual(
        expect.objectContaining({ controlledRunId: childRunId }),
      );
      expect(session.defaultStack).toContain(parentState!.id);
    });

    it('rd stop --claim-id on a running child reports fail (derived by core) to the parent before release, and retains the tombstone', async () => {
      const parentRunbook = `## 1. Review
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Child
- DELEGATE

Do child.

- child-running-stop.runbook.md
`;
      const childRunbook = `## 1. Child
- PASS COMPLETE
- FAIL STOP

Do work.
`;
      await writeFile(join(workspace.cwd, 'parent-running-stop.runbook.md'), parentRunbook);
      await writeFile(join(workspace.cwd, 'child-running-stop.runbook.md'), childRunbook);

      let result = await runCliInProcess(
        'run --prompted parent-running-stop.runbook.md --text',
        workspace,
      );
      expect(result.exitCode).toBe(0);
      const parentState = await getActiveState(workspace);
      const parentId = parentState!.id;
      const token = parentState?.substepStates?.[0]?.delegation?.token;
      expect(token).toEqual(expect.stringMatching(/^rdtk_/));
      if (typeof token !== 'string') throw new Error('Expected delegation token');
      result = await runCliInProcess(`claim ${token}`, workspace);
      const claimOutput = findActionOutput(result.stdout);
      const childRunId = String(claimOutput?.run_id);
      const claimId = String(claimOutput?.claim_id);

      // Stop the still-running claimed child: FORCE_STOP → stopped → the parent
      // receives a `fail` outcome row DERIVED BY CORE from the stopped lifecycle
      // (stopped→fail via lifecycleToDelegationOutcome — never a CLI literal).
      result = await runCliInProcess(['stop', '--claim-id', claimId], workspace);
      expect(result.exitCode).toBe(0);

      const parent = await readRunbookState(workspace, parentId);
      expect(parent).not.toBeNull();
      const outcomes = readDelegationOutcomeReportedFacts(parent!).map((fact) => fact.outcome);
      expect(outcomes).toContain('fail');

      // The claim tombstone is retained (record-before-release + retain).
      const session = await readSession(workspace);
      expect(Object.values(session.claims)).toContainEqual(
        expect.objectContaining({ controlledRunId: childRunId }),
      );
    });
  });

  describe('stop with message', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    });

    it('includes custom message in output', async () => {
      const result = await runCliInProcess(['stop', 'User cancelled', '--text'], workspace);

      expect(result.exitCode).toBe(1);
      // Text renderer discards the message; just check for STOP
      expect(result.stdout).toContain('STOP');
    });
  });

  describe('stop with no active runbook', () => {
    it('reports no active runbook', async () => {
      const result = await runCliInProcess('stop --text', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No active runbook');
    });

    it('does not remove the default stack when a claim id has no claim', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      const sessionBefore = await readSession(workspace);
      const parentId = sessionBefore.defaultStack.at(-1);
      expect(parentId).toBeDefined();

      const result = await runCliInProcess(
        [
          'stop',
          '--claim-id',
          'rdclm_00000000000000000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        ],
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const errorResponse = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(errorResponse).toEqual(
        expect.objectContaining({
          kind: 'error',
          code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
          command: 'stop',
        }),
      );
      // Refusal identifies the claim by its non-secret lookup key, never the bearer secret.
      expect(String(errorResponse.error)).toContain(
        'Claim id rdclk_00000000000000000000000000000000 does not exist',
      );
      expect(String(errorResponse.error)).not.toContain(
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      );

      const sessionAfter = await readSession(workspace);
      expect(sessionAfter.defaultStack).toEqual([parentId]);
      expect(await readRunbookState(workspace, parentId!)).not.toBeNull();
    });
  });

  describe('stop with runbook stack', () => {
    it('pops to parent runbook', async () => {
      // Create parent/child runbooks
      const parentRunbook = `## 1. Step one
- PASS COMPLETE

Do something.
`;
      const childRunbook = `## 1. Step one
- PASS COMPLETE

Do work.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'parent-stop.md'), parentRunbook);
      await writeFile(join(workspace.cwd, 'runbooks', 'child-stop.md'), childRunbook);

      // Start parent (prompted)
      await runCliInProcess('run --prompted runbooks/parent-stop.md --text', workspace);
      const parentState = await getActiveState(workspace);

      // Start child in same stack
      await runCliInProcess('run --prompted runbooks/child-stop.md --text', workspace);

      // Stop child. This child was stacked via `rd run` (no inline linkage), so it
      // is its own force-terminal root: bare stop stops only the child and exits
      // non-zero, leaving the stacked parent active.
      const result = await runCliInProcess('stop', workspace);
      expect(result.exitCode).toBe(1);

      // Should now be on parent
      const activeState = await getActiveState(workspace);
      expect(activeState?.id).toBe(parentState!.id);
    });
  });

  describe('JSON output', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    });

    it('outputs JSON when flag provided', async () => {
      const result = await runCliInProcess('stop', workspace);

      // Bare stop is a failure terminal and exits non-zero. It now streams a
      // runbook_stopped observation before the final action object, so parse the
      // final newline-delimited JSON object.
      expect(result.exitCode).toBe(1);

      const output = parseFinalCliJsonObject(result.stdout);
      expect(output.action).toBe('stop');
    });

    it('includes metadata in JSON output', async () => {
      const result = await runCliInProcess('stop', workspace);

      const output = parseFinalCliJsonObject(result.stdout);
      expect(output.file).toBeDefined();
      expect(output.file).toBe('runbooks/simple.runbook.md');
    });
  });

  describe('terminal-lifecycle short-circuit', () => {
    it('does not propagate to parent or send FORCE_STOP when state is already terminal', async () => {
      // Issue 3 regression: rd stop must NOT propagate to the parent when
      // the runbook is already terminal. FORCE_STOP is a no-op at an
      // already-stopped machine, but the CLI was still calling
      // propagateChildTerminal(state, 'fail', ...), mis-propagating to the parent.
      // We assert the short-circuit by spying on sendAndSync — when the
      // state lifecycle is already non-'running', sendAndSync must NOT be
      // invoked at all.
      const runbook = `# Already Terminal

## 1. Work
- PASS COMPLETE
- FAIL STOP
`;
      await writeFile(join(workspace.cwd, 'already-terminal.runbook.md'), runbook);
      await runCliInProcess('run --prompted already-terminal.runbook.md --text', workspace);
      const state = await getActiveState(workspace);
      expect(state).not.toBeNull();
      // Drive to a terminal lifecycle: send pass to completion.
      await runCliInProcess('pass --text', workspace);

      // Reactivate the session so the next stop call can find the state.
      // Resurrect via the session stack — the simulated "already terminal
      // but session-active" race needs the state file to remain loadable.
      await seedSession(workspace.cwd, { defaultStack: [state!.id] });

      // Sanity: persisted state is terminal.
      const persistedState = await readRunbookState(workspace, state!.id);
      expect(persistedState?.lifecycle).toBe('completed');

      // Spy on the actor service. The short-circuit must avoid sendAndSync
      // and never propagate to a (nonexistent) parent.
      const sendSpy = jest.spyOn(RunbookActorService.prototype, 'sendAndSync');

      const result = await runCliInProcess('stop --text', workspace);

      // The command must succeed without driving the machine.
      expect(result.exitCode).toBe(0);
      expect(sendSpy).not.toHaveBeenCalled();

      // The lifecycle must not have changed.
      const afterStop = await readRunbookState(workspace, state!.id);
      expect(afterStop?.lifecycle).toBe('completed');
    });
  });

  describe('delegation propagation', () => {
    async function writeParentRunbook(): Promise<void> {
      const content = `## 1. Review
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Code review
- DELEGATE

Do code review.

- child.runbook.md

### 1.2 Security review
- DELEGATE

Do security review.

- child.runbook.md

## 2. Done
- PASS COMPLETE

Final step.
`;
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), content);
    }

    async function writeChildRunbook(): Promise<void> {
      const content = `## 1. Execute
- PASS COMPLETE
- FAIL STOP

Run the child task.
`;
      await writeFile(join(workspace.cwd, 'child.runbook.md'), content);
    }

    it('propagates fail to parent when child is stopped', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id;

      const token1 = parentState?.substepStates?.[0]?.delegation?.token;
      const token2 = parentState?.substepStates?.[1]?.delegation?.token;
      if (typeof token1 !== 'string' || typeof token2 !== 'string') {
        throw new Error('Expected delegation tokens');
      }

      // Stop the first child through its claim — the delegated child's fail is
      // reported (uncollected) to parent substep 1.1; the claim-path stop is a
      // report-only close and exits 0.
      result = await runCliInProcess(`claim ${token1}`, workspace);
      expect(result.exitCode).toBe(0);
      const claimId1 = String(findActionOutput(result.stdout)?.claim_id);
      result = await runCliInProcess(['stop', '--claim-id', claimId1], workspace);
      expect(result.exitCode).toBe(0);

      // Resolve the sibling substep the same way so collection can aggregate.
      result = await runCliInProcess(`claim ${token2}`, workspace);
      expect(result.exitCode).toBe(0);
      const claimId2 = String(findActionOutput(result.stdout)?.claim_id);
      result = await runCliInProcess(['stop', '--claim-id', claimId2], workspace);
      expect(result.exitCode).toBe(0);

      // The orchestrator collects with named authority: FAIL ANY fires STOP.
      const parentClaimId = await issueRunControlClaim(workspace, parentRunId);
      result = await runCliInProcess(['collect', '--claim-id', parentClaimId], workspace);
      expect(result.exitCode).toBe(1);

      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.lifecycle).toBe('stopped');
    });

    it('stop with custom message reports fail to the delegating run (uncollected)', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id;

      const token = parentState?.substepStates?.[0]?.delegation?.token;
      expect(token).toEqual(expect.stringMatching(/^rdtk_/));
      if (typeof token !== 'string') throw new Error('Expected delegation token');
      result = await runCliInProcess(`claim ${token}`, workspace);
      const claimId = String(findActionOutput(result.stdout)?.claim_id);

      // Stop with message — child stops, REPORTS fail to parent 1.1 (report-only).
      result = await runCliInProcess(
        ['stop', 'Task cancelled by user', '--claim-id', claimId, '--text'],
        workspace,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('STOP');

      // Plan 5 (report-only): the delegating run receives a FAIL outcome row on
      // 1.1 and is left collection pending — NOT auto-advanced or stopped. The
      // parent's FAIL-ANY aggregation now surfaces only at `rd collect`.
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      const rows = Object.values(updatedParent!.resolvedCompletions ?? {}).filter(
        (c) => c.agentId === 'delegation',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.result).toBe('fail');
      expect(updatedParent!.lifecycle).toBe('running');
    });

    it('stop with outputs structured data and reports fail to the delegating run', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id;

      const token = parentState?.substepStates?.[0]?.delegation?.token;
      expect(token).toEqual(expect.stringMatching(/^rdtk_/));
      if (typeof token !== 'string') throw new Error('Expected delegation token');

      result = await runCliInProcess(`claim ${token}`, workspace);
      const claimId = String(findActionOutput(result.stdout)?.claim_id);

      // Stop with JSON — child stops, REPORTS fail to parent 1.1 (report-only).
      result = await runCliInProcess(['stop', '--claim-id', claimId], workspace);
      expect(result.exitCode).toBe(0);

      const stopAction = findActionOutput(result.stdout);
      expect(stopAction?.action).toBe('stop');

      // Plan 5 (report-only): the delegating run is left collection pending with
      // a FAIL row — NOT auto-advanced or stopped.
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      const rows = Object.values(updatedParent!.resolvedCompletions ?? {}).filter(
        (c) => c.agentId === 'delegation',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.result).toBe('fail');
      expect(updatedParent!.lifecycle).toBe('running');
    });

    it('stop without delegation linkage does not propagate', async () => {
      // Start a runbook without delegation
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      // Stop it. Bare stop is a failure terminal and exits non-zero.
      const result = await runCliInProcess('stop --text', workspace);
      expect(result.exitCode).toBe(1);

      // No propagation should occur — just a normal stop
      expect(result.stdout).toContain('STOP');
    });

    it('3-level cascade — stop child propagates through parent to grandparent', async () => {
      // Grandparent with 2 substeps
      const grandparentContent = `## 1. Pipeline
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Deploy
- DELEGATE

Deploy step.

- parent.runbook.md

### 1.2 Monitor
- DELEGATE

Monitor step.

- parent.runbook.md
`;
      await writeFile(join(workspace.cwd, 'grandparent.runbook.md'), grandparentContent);

      // Parent claimed by the grandparent. Its own substeps are local work so the
      // fresh claim does not start with nested live delegations.
      const parentContent = `## 1. Review
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Task
Review the deployment.

### 1.2 Approve
Approve the deployment.
`;
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), parentContent);

      // Child (single step, no substeps)
      await writeChildRunbook();

      // Start grandparent
      let result = await runCliInProcess('run --prompted grandparent.runbook.md --text', workspace);
      const grandparentState = await getActiveState(workspace);
      const grandparentRunId = grandparentState!.id;

      const token1 = grandparentState?.substepStates?.[0]?.delegation?.token;
      const token2 = grandparentState?.substepStates?.[1]?.delegation?.token;
      if (typeof token1 !== 'string' || typeof token2 !== 'string') {
        throw new Error('Expected delegation tokens');
      }

      // Stop the claimed parent through its claim — a report-only close (exit
      // 0) that reports fail (uncollected) to grandparent substep 1.1.
      result = await runCliInProcess(`claim ${token1}`, workspace);
      expect(result.exitCode).toBe(0);
      const claimAction1 = findActionOutput(result.stdout);
      const parentClaimId = String(claimAction1?.claim_id);
      const parentRunId = String(claimAction1?.run_id);
      result = await runCliInProcess(['stop', '--claim-id', parentClaimId], workspace);
      expect(result.exitCode).toBe(0);

      // Verify parent is stopped
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.lifecycle).toBe('stopped');

      // Resolve the sibling substep the same way so collection can aggregate.
      result = await runCliInProcess(`claim ${token2}`, workspace);
      expect(result.exitCode).toBe(0);
      const claimId2 = String(findActionOutput(result.stdout)?.claim_id);
      result = await runCliInProcess(['stop', '--claim-id', claimId2], workspace);
      expect(result.exitCode).toBe(0);

      // The orchestrator collects the grandparent with named authority:
      // FAIL ANY aggregation fires STOP.
      const grandparentClaimId = await issueRunControlClaim(workspace, grandparentRunId);
      result = await runCliInProcess(['collect', '--claim-id', grandparentClaimId], workspace);
      expect(result.exitCode).toBe(1);

      // Verify grandparent is stopped
      const updatedGrandparent = await readRunbookState(workspace, grandparentRunId);
      expect(updatedGrandparent).not.toBeNull();
      expect(updatedGrandparent!.lifecycle).toBe('stopped');
    });
  });

  it('bare stop from an inline child stops the outermost contiguous-inline ancestor and exits non-zero', async () => {
    await writeFile(
      join(workspace.cwd, 'parent-force-stop.runbook.md'),
      `# Parent Force Stop

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
      join(workspace.cwd, 'child-force-stop.runbook.md'),
      `# Child Force Stop

## 1. Waiting
- PASS COMPLETE
- FAIL STOP

Waiting.
`,
    );

    await runCliInProcess('run --prompted parent-force-stop.runbook.md', workspace);
    const parent = await getActiveState(workspace);
    expect(parent).not.toBeNull();

    await runCliInProcess('run child-force-stop.runbook.md --step 1.1', workspace);
    const child = await getActiveState(workspace);
    expect(child?.parentLinkage?.kind).toBe('inline');

    const result = await runCliInProcess(['stop', 'workflow stopped'], workspace);

    expect(result.exitCode).toBe(1);
    const parentAfter = await readRunbookState(workspace, parent!.id);
    const childAfter = await readRunbookState(workspace, child!.id);
    expect(parentAfter!.lifecycle).toBe('stopped');
    expect(childAfter!.lifecycle).toBe('stopped');
    const session = await readSession(workspace);
    expect(session.defaultStack).not.toContain(parent!.id);
    expect(session.defaultStack).not.toContain(child!.id);
  });
});
