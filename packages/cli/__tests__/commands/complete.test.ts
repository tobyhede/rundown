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
  requireLatestFrontierToken,
  withRunTarget,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { patchPersistedRunState, seedSession } from '@rundown-org/core/testing/session-fixtures';
import { Command } from 'commander';
// Stryker static-import linkage (mutation testing): links this test file into
// Jest's static inverse-module graph so `--findRelatedTests src/commands/complete.ts`
// credits the behavioural tests below (which reach the command only via the
// dynamic `import('../cli.js')` seam in runCliInProcess). See collect.test.ts.
import { registerCompleteCommand } from '../../src/commands/complete.js';

interface ClaimOutput extends Record<string, unknown> {
  claim_id: string;
}

describe('complete command wiring', () => {
  it('registers the complete command with its documented flags and descriptions', () => {
    const program = new Command();
    registerCompleteCommand(program);

    const complete = program.commands.find((c) => c.name() === 'complete');
    expect(complete).toBeDefined();
    expect(complete?.description()).toBe(
      'Force early completion of current runbook (runbooks auto-complete on final step)',
    );

    const byLong = new Map(complete!.options.map((o) => [o.long, o]));
    expect([...byLong.keys()]).toEqual(expect.arrayContaining(['--claim-id', '--text']));
    expect(byLong.get('--claim-id')?.description).toBe('Target a claimed delegated child runbook');
    expect(byLong.get('--text')?.description).toBe('Output as human-readable text');
  });
});

describe('complete command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await workspace.cleanup();
  });

  describe('--run explicit targeting', () => {
    it('refuses complete --run <id> without bearer authority', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      const active = await getActiveState(workspace);
      expect(active).not.toBeNull();

      const result = await runCliInProcess(`complete --run ${active!.id}`, workspace);

      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as { code?: string };
      expect(payload.code).toBe('ACTOR_CONTEXT_REQUIRED');
      const state = await readRunbookState(workspace, active!.id);
      expect(state?.lifecycle).toBe('running');
    });

    it('refuses a well-formed but unknown --run id with RUN_TARGET_UNAVAILABLE', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      const bogus = `rd_${'f'.repeat(32)}`;

      const result = await runCliInProcess(`complete --run ${bogus}`, workspace);

      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as { code?: string };
      expect(payload.code).toBe('RUN_TARGET_UNAVAILABLE');
      // The active run was not forced terminal by the refusal.
      const state = await getActiveState(workspace);
      expect(state?.lifecycle).toBe('running');
    });
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

    await runCliInProcess('run --prompted parent-claim-complete.runbook.md', workspace);
    const parentBefore = await getActiveState(workspace);
    expect(parentBefore).not.toBeNull();
    const token = requireLatestFrontierToken(workspace, '1.1');
    const claim = await runCliInProcess(['claim', token], workspace);
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

  it('announces the claimed child terminal exactly once on the JSON stream', async () => {
    const parentRunbook = `# Parent Claim Announce

## 1. Parent delegates child
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child work
- DELEGATE

- child-announce.runbook.md
`;
    const childRunbook = `# Child Announce

## 1. Child waits
- PASS COMPLETE
- FAIL STOP
`;
    await writeFile(join(workspace.cwd, 'parent-claim-announce.runbook.md'), parentRunbook);
    await writeFile(join(workspace.cwd, 'child-announce.runbook.md'), childRunbook);

    await runCliInProcess('run --prompted parent-claim-announce.runbook.md', workspace);
    const token = requireLatestFrontierToken(workspace, '1.1');
    const claim = await runCliInProcess(['claim', token], workspace);
    const claimId = findActionOutput<ClaimOutput>(claim.stdout)?.claim_id;

    const result = await runCliInProcess(
      ['complete', '--claim-id', String(claimId), 'child has enough evidence'],
      workspace,
    );

    expect(result.exitCode).toBe(0);
    // The seam renders the child's terminal once. Re-entering Run Progression to
    // continue composition must not re-announce a terminal the caller already
    // observed: a duplicate `runbook_completed` (with a restarted `seq`) tells a
    // streaming orchestrator the child finished twice.
    const completions = parseConcatenatedJson(result.stdout).filter(
      (entry) => (entry as Record<string, unknown>).type === 'runbook_completed',
    );
    expect(completions).toHaveLength(1);
  });

  it('prepares FORCE_COMPLETE with the operator message through the fenced actor seam', async () => {
    const prepareSpy = jest.spyOn(RunbookActorService.prototype, 'prepareActorMutation');

    const runbook = `# Complete Null Sync

## 1. Work
- PASS COMPLETE
- FAIL STOP
`;
    await writeFile(join(workspace.cwd, 'complete-null-sync.runbook.md'), runbook);
    await runCliInProcess('run --prompted complete-null-sync.runbook.md --text', workspace);

    const result = await runCliInProcess(['complete', 'race', '--text'], workspace);

    expect(result.exitCode).toBe(0);
    const forceCompleteCall = prepareSpy.mock.calls.find(
      (call) => (call[3] as { type: string }).type === 'FORCE_COMPLETE',
    );
    expect(forceCompleteCall?.[3]).toEqual({
      type: 'FORCE_COMPLETE',
      message: 'race',
    });
  });

  it('prepares a claimed child FORCE_COMPLETE through the fenced actor seam', async () => {
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

    await runCliInProcess('run --prompted parent-null-sync.runbook.md', workspace);
    const parentBefore = await getActiveState(workspace);
    expect(parentBefore).not.toBeNull();
    const token = requireLatestFrontierToken(workspace, '1.1');
    const claim = await runCliInProcess(['claim', token], workspace);
    const claimId = findActionOutput<ClaimOutput>(claim.stdout)?.claim_id;
    expect(typeof claimId).toBe('string');

    const prepareSpy = jest.spyOn(RunbookActorService.prototype, 'prepareActorMutation');

    const result = await runCliInProcess(
      ['complete', '--claim-id', String(claimId), 'race', '--text'],
      workspace,
    );

    expect(result.exitCode).toBe(0);

    const forceCompleteCall = prepareSpy.mock.calls.find(
      (call) => (call[3] as { type: string }).type === 'FORCE_COMPLETE',
    );
    expect(forceCompleteCall?.[3]).toEqual({
      type: 'FORCE_COMPLETE',
      message: 'race',
    });

    // Parent state is untouched: still in-flight, no terminal lastAction propagated
    // (the seam recorded nothing to the delegating run for a child it never forced).
    const parentState = await readRunbookState(workspace, parentBefore!.id);
    expect(parentState!.lifecycle).toBe(parentBefore!.lifecycle);
    expect(Object.values(parentState!.resolvedCompletions ?? {})).toHaveLength(1);
  });

  it('reports no active runbook', async () => {
    const result = await runCliInProcess('complete --text', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No active runbook');
  });

  describe('invalid snapshot recovery', () => {
    it('preserves a healthy top when sendAndSync rejects with InvalidRunbookStateError (#518)', async () => {
      const runbook = `# Invalid Snapshot

## 1. Work
- PASS COMPLETE
- FAIL STOP
`;
      await writeFile(join(workspace.cwd, 'stale.runbook.md'), runbook);
      await runCliInProcess('run --prompted stale.runbook.md --text', workspace);
      const state = await getActiveState(workspace);
      const stateId = state!.id;

      // The state file on disk is VALID, so the #518 guard sees a healthy top
      // and rethrows the original error instead of deleting live state (the
      // pre-#518 code deleted it unconditionally). Recovery for a genuinely
      // broken run is `rd prune --active`/`--all`.
      jest
        .spyOn(RunbookActorService.prototype, 'prepareActorMutation')
        .mockRejectedValueOnce(new InvalidRunbookStateError('snapshot incompatible'));

      const result = await runCliInProcess('complete --text', workspace);
      expect(result.exitCode).not.toBe(0);
      const emitted = `${result.stdout}\n${result.stderr}`;
      expect(emitted).toContain('RECOVERY_REQUIRED');

      const session = await readSession(workspace);
      expect(session.defaultStack).toContain(stateId);
      expect(await readRunbookState(workspace, stateId)).not.toBeNull();
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
        .spyOn(RunbookActorService.prototype, 'prepareActorMutation')
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

      await runCliInProcess('run --prompted parent-claim.runbook.md', workspace);
      const parentState = await getActiveState(workspace);
      const parentId = parentState!.id;

      const token = requireLatestFrontierToken(workspace, '1.1');
      const claim = await runCliInProcess(['claim', token], workspace);
      const claimId = findActionOutput<ClaimOutput>(claim.stdout)?.claim_id;
      expect(typeof claimId).toBe('string');

      jest
        .spyOn(RunbookActorService.prototype, 'prepareActorMutation')
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
        'run --prompted parent-terminal-complete.runbook.md',
        workspace,
      );
      expect(result.exitCode).toBe(0);
      const parentState = await getActiveState(workspace);
      const token = requireLatestFrontierToken(workspace, '1.1');
      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      const claimOutput = findActionOutput(result.stdout);
      const childRunId = String(claimOutput?.run_id);
      const claimId = String(claimOutput?.claim_id);

      const childState = await readRunbookState(workspace, childRunId);
      expect(childState).not.toBeNull();
      await patchPersistedRunState(workspace.cwd, childRunId, { lifecycle: 'completed' });

      result = await runCliInProcess(['complete', '--claim-id', claimId], workspace);

      expect(result.exitCode).toBe(0);
      const session = await readSession(workspace);
      // Item 4: the terminal claim is RETAINED as a tombstone (released in the
      // `addressed` role) so a later --claim-id can confirm/conflict again.
      expect(Object.values(session.claims)).toContainEqual(
        expect.objectContaining({ controlledRunId: childRunId }),
      );
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
        'run --prompted parent-conflict-complete.runbook.md',
        workspace,
      );
      expect(result.exitCode).toBe(0);
      const token = requireLatestFrontierToken(workspace, '1.1');
      result = await runCliInProcess(`claim ${token}`, workspace);
      const claimOutput = findActionOutput(result.stdout);
      const childRunId = String(claimOutput?.run_id);
      const claimId = String(claimOutput?.claim_id);

      // Drive the claimed child to STOPPED, then attempt `complete` on it: the
      // requested command (complete → expects completed) conflicts with the
      // child's `stopped` lifecycle, so the seam refuses with a typed conflict.
      const childState = await readRunbookState(workspace, childRunId);
      if (!childState) throw new Error('Expected claimed child state to exist');
      await patchPersistedRunState(workspace.cwd, childRunId, { lifecycle: 'stopped' });

      result = await runCliInProcess(['complete', '--claim-id', claimId], workspace);

      // The seam streams JSON; scan the concatenated objects for the refusal code.
      const codes = parseConcatenatedJson(result.stdout).map((o) => (o as { code?: string }).code);
      expect(codes).toContain('DELEGATION_RESULT_CONFLICT');
      expect(result.exitCode).not.toBe(0);
      // Still retained as a tombstone (conflict path releases with retain too).
      const session = await readSession(workspace);
      expect(Object.values(session.claims)).toContainEqual(
        expect.objectContaining({ controlledRunId: childRunId }),
      );
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
    await seedSession(workspace.cwd, { defaultStack: [state!.id] });

    const persistedState = await readRunbookState(workspace, state!.id);
    expect(persistedState?.lifecycle).toBe('completed');

    const result = await runCliInProcess('complete --text', workspace);

    expect(result.exitCode).toBe(0);

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

  describe('corrupt inline linkage graph (#602)', () => {
    // The linkage graph is a tree by construction, so no command sequence can
    // author a back-edge — but corrupt persisted state is precisely what the
    // guard exists for, and this repo already fixtures exactly that (stop.test.ts
    // rewrites a run's JSON for #518; session-service.test.ts builds a 2-node
    // inline cycle via manager.save). This drives the WHOLE chain the unit tests
    // only cover in pieces: real persisted state -> seam guard -> adapter
    // collapse -> process exit code + the agent-facing JSON envelope.

    /** Seed a real parent + inline child, then point the child's linkage at itself. */
    async function seedSelfLinkedInlineChild(): Promise<string> {
      await writeFile(
        join(workspace.cwd, 'parent-602.runbook.md'),
        [
          '# Parent 602',
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
        join(workspace.cwd, 'child-602.runbook.md'),
        [
          '# Child 602',
          '',
          '## 1. Waiting',
          '- PASS COMPLETE',
          '- FAIL STOP',
          '',
          'Waiting.',
          '',
        ].join('\n'),
      );
      await runCliInProcess('run --prompted parent-602.runbook.md', workspace);
      await runCliInProcess('run child-602.runbook.md --step 1.1', workspace);
      const child = await getActiveState(workspace);
      expect(child?.parentLinkage?.kind).toBe('inline');

      // The back-edge: the child's inline parent is now ITSELF.
      await patchPersistedRunState(workspace.cwd, child!.id, (current) => ({
        ...current,
        parentLinkage: {
          ...(current.parentLinkage as Record<string, unknown>),
          parentRunId: child!.id,
        },
      }));
      return child!.id;
    }

    it('refuses a self-linked inline child: non-zero exit + INLINE_PARENT_CYCLE naming the run', async () => {
      const childId = await seedSelfLinkedInlineChild();

      const result = await runCliInProcess('complete', workspace);

      // Fail closed at the PROCESS boundary, not merely in the seam. The
      // equivalent healthy chain exits 0 (see the force-complete test above), so
      // this pins the refusal end-to-end rather than a mock's arguments.
      //
      // NOTE ON WHICH GUARD THIS COVERS: `complete` resolves its force-terminal
      // plan FIRST, so the pre-existing `resolveActiveInlineForceTerminalPlan`
      // cycle check refuses here before the propagation seam is ever reached.
      // That is correct behaviour and worth pinning — but it is NOT the #602
      // propagation guard, which `pass --claim-id` covers below. The two shared a
      // byte-identical message until this change routed both through
      // `inlineParentCycleMessage`, which is exactly why this test could assert
      // one path while exercising the other.
      expect(result.exitCode).not.toBe(0);
      const cycle = parseConcatenatedJson(result.stdout).find(
        (entry) => (entry as Record<string, unknown>).code === 'INLINE_PARENT_CYCLE',
      ) as Record<string, unknown> | undefined;
      // The operator must be told WHICH run to prune: an unnamed refusal is
      // indistinguishable from any other block and carries no recovery path.
      expect(cycle).toMatchObject({
        code: 'INLINE_PARENT_CYCLE',
        error: `Parent linkage cycle detected at ${childId}`,
      });
    });

    it('refuses via the #602 propagation guard on pass, naming the run and its cause', async () => {
      // This is the seam #602 added. `pass` on an inline child drives the
      // inline terminal flow-back, whose ancestry guard trips on the self-edge
      // BEFORE any record/advance/release and refuses fail-closed, driving a
      // non-zero exit. Unlike the unit tests, nothing here is mocked: real
      // persisted state, real seam, real exit code.
      //
      // ENVELOPE, post-#856. The refusal is now diagnosed inside core and
      // delivered through the gated observation sink, so it streams as the
      // `error_occurred` EXECUTION EVENT rather than the CLI's own `error`
      // envelope — which is the #853 contract every migrated refusal follows:
      // core diagnoses through the sink, and the closed outcome only decides
      // the exit code. The sibling test above still asserts `error`, because
      // `complete` resolves its force-terminal plan first and refuses through
      // `resolveActiveInlineForceTerminalPlan`, which is CLI-rendered and
      // unmigrated. What #603 actually protects is unchanged and is what this
      // pins: the operator is told WHICH run to prune, with the cause, at a
      // non-zero exit.
      const childId = await seedSelfLinkedInlineChild();

      const result = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);

      expect(result.exitCode).not.toBe(0);
      const cycle = parseConcatenatedJson(result.stdout).find(
        (entry) => (entry as Record<string, unknown>).code === 'INLINE_PARENT_CYCLE',
      ) as Record<string, unknown> | undefined;
      // Core now composes and streams this refusal itself, so it arrives as an
      // `error_occurred` observation carrying `message` rather than the CLI's
      // former `error` envelope. Both halves of the #603 contract survive that
      // move: the operator message and the run to prune.
      expect(cycle).toMatchObject({
        type: 'error_occurred',
        code: 'INLINE_PARENT_CYCLE',
        message: `Parent linkage cycle detected at ${childId}`,
        details: { cause: 'repeat', runId: childId },
      });
    });
  });
});
