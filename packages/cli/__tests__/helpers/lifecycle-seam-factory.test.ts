import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  RunbookStateManager,
  SessionService,
  RunbookLifecycleCommandService,
  DELEGATION_TOKEN_PREFIX,
} from '@rundown-org/core';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  createTestWorkspace,
  createRunbook,
  runCliInProcess,
  getActiveState,
  type TestWorkspace,
} from './test-utils.js';

// Static import of the factory under test. The behavioural tests below drive the
// pass/complete/stop lifecycle through `runCliInProcess`, which reaches this
// helper via a *dynamic* `import('../cli.js')` — an edge Stryker's
// `enableFindRelatedTests` (Jest's static inverse-module graph) cannot see.
// Without a static import here, a per-mutant
// `jest --findRelatedTests src/helpers/lifecycle-seam-factory.ts` matches no
// test file, so Stryker runs zero tests per mutant and every mutant falsely
// survives (0.00% score — issue #541). This static edge links the file into the
// graph so the covering tests actually run against each mutant, and the direct
// `issueDelegation` assertions below pin the delegation-refusal contract those
// runtime paths never exercise.
import { buildNonDelegatingLifecycleSeam } from '../../src/helpers/lifecycle-seam-factory.js';

const REFUSAL = 'non-delegating lifecycle seam does not issue delegations';

describe('buildNonDelegatingLifecycleSeam', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('construction', () => {
    it('binds a manager, session service, and lifecycle seam to the cwd', () => {
      const { manager, sessionService, seam } = buildNonDelegatingLifecycleSeam(workspace.cwd);

      expect(manager).toBeInstanceOf(RunbookStateManager);
      expect(sessionService).toBeInstanceOf(SessionService);
      expect(seam).toBeInstanceOf(RunbookLifecycleCommandService);
    });
  });

  describe('delegation-refusal contract', () => {
    it('refuses a retry-by-token issuance (findDelegationByToken stub throws)', async () => {
      const { seam } = buildNonDelegatingLifecycleSeam(workspace.cwd);

      // A token-locator retry hits `findDelegationByToken` first thing, before any
      // active-run / policy gate — so the stub throws with no setup. This is the
      // whole point of the non-delegating seam: pass/fail/complete/stop front ends
      // must never mint or mutate a delegation.
      await expect(
        seam.issueDelegation({
          mode: 'retry',
          callerEvidence: { kind: 'direct_cli' },
          locator: { kind: 'token', token: `${DELEGATION_TOKEN_PREFIX}never_resolved` },
        }),
      ).rejects.toThrow(REFUSAL);
    });

    it('refuses a fresh issuance against a delegatable substep (resolveChildRunbook stub throws)', async () => {
      // Author a parent whose first substep is delegatable, run it (which
      // auto-issues the frontier delegation), then abort that token so the substep
      // is freshly *issuable* again. A fresh `issueDelegation` now falls through to
      // `resolveChildRunbook`, whose stub throws.
      const childContent = createRunbook({
        steps: [{ title: 'Child step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);

      const parentContent = createRunbook({
        title: 'Parent',
        steps: [
          {
            title: 'Main step',
            pass: 'CONTINUE',
            substeps: [
              { title: 'Substep A', delegate: true, runbooks: ['runbooks/child.runbook.md'] },
              { title: 'Substep B', content: 'Second substep.' },
            ],
          },
          { title: 'Complete', pass: 'COMPLETE', command: 'rd echo --result pass' },
        ],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'delegate-parent.runbook.md'), parentContent);

      const startResult = await runCliInProcess(
        'run --prompted runbooks/delegate-parent.runbook.md --text',
        workspace,
      );
      expect(startResult.exitCode).toBe(0);

      const state = await getActiveState(workspace);
      const autoToken = state?.substepStates?.find((substep) => substep.id === '1')?.delegation
        ?.token;
      expect(autoToken).toBeDefined();

      const abortResult = await runCliInProcess(['abort', autoToken!], workspace);
      expect(abortResult.exitCode).toBe(0);

      const { seam } = buildNonDelegatingLifecycleSeam(workspace.cwd);
      await expect(
        seam.issueDelegation({
          mode: 'fresh',
          // Named orchestrator authority (post-R1, direct_cli is refused on a
          // delegating run before the resolver stub is ever reached).
          callerEvidence: { kind: 'run_controller', runId: state!.id },
          explicitStep: '1.1',
        }),
      ).rejects.toThrow(REFUSAL);
    });
  });

  describe('lifecycle transitions run through the seam', () => {
    it('passes a step through the transition seam (runTransition exercises loadSteps)', async () => {
      // Manual (command-less) steps so `run` halts awaiting a `pass` rather than
      // auto-executing the command and running the whole runbook to completion.
      const runbook = createRunbook({
        steps: [
          { title: 'First', pass: 'CONTINUE', content: 'Manual step one.' },
          { title: 'Second', pass: 'COMPLETE', content: 'Manual step two.' },
        ],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'seam.runbook.md'), runbook);

      const start = await runCliInProcess('run runbooks/seam.runbook.md', workspace);
      expect(start.exitCode).toBe(0);

      const pass = await runCliInProcess(['pass'], workspace);
      expect(pass.exitCode).toBe(0);

      const advanced = await getActiveState(workspace);
      expect(advanced?.step).toBe('2');
    });

    it('completes a run through the terminal seam (runTerminal exercises loadSteps)', async () => {
      const runbook = createRunbook({
        steps: [
          { title: 'First', pass: 'CONTINUE', content: 'Manual step one.' },
          { title: 'Second', pass: 'COMPLETE', content: 'Manual step two.' },
        ],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'terminal.runbook.md'), runbook);

      const start = await runCliInProcess('run runbooks/terminal.runbook.md', workspace);
      expect(start.exitCode).toBe(0);

      const complete = await runCliInProcess(['complete'], workspace);
      expect(complete.exitCode).toBe(0);

      // The terminal seam released session targeting: no active run remains.
      const afterComplete = await getActiveState(workspace);
      expect(afterComplete).toBeNull();
    });
  });
});
