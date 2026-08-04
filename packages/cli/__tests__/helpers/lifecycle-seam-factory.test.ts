import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  RunbookStateManager,
  SessionService,
  RunbookLifecycleCommandService,
  DELEGATION_TOKEN_PREFIX,
  truncateDelegationToken,
} from '@rundown-org/core';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  createTestWorkspace,
  createRunbook,
  runCliInProcess,
  getActiveState,
  issueRunControlClaim,
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
    it('scans retry tokens without making the non-issuing seam mint a delegation', async () => {
      const { seam } = buildNonDelegatingLifecycleSeam(workspace.cwd);

      // Abort now shares this seam and needs the read-only token scanner. An
      // unknown retry token therefore returns the normal write-free lookup
      // outcome; the issuing resolver remains the seam's mutation guard.
      await expect(
        seam.issueDelegation({
          mode: 'retry',
          callerEvidence: { kind: 'direct_cli' },
          locator: { kind: 'token', token: `${DELEGATION_TOKEN_PREFIX}never_resolved` },
        }),
      ).resolves.toEqual({
        kind: 'token-not-found',
        // Redacted at the core boundary: the outcome cannot carry a raw bearer.
        tokenHint: truncateDelegationToken(`${DELEGATION_TOKEN_PREFIX}never_resolved`),
      });
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
        'run --prompted runbooks/delegate-parent.runbook.md',
        workspace,
      );
      expect(startResult.exitCode).toBe(0);

      const state = await getActiveState(workspace);
      const autoToken = /"token":"(rdtk_[^"]+)"/.exec(startResult.stdout)?.[1];
      expect(autoToken).toBeDefined();
      const parentClaimId = await issueRunControlClaim(workspace, state!.id);

      const abortResult = await runCliInProcess(
        ['abort', autoToken!, '--claim-id', parentClaimId],
        workspace,
      );
      expect(abortResult.exitCode).toBe(0);

      const { seam } = buildNonDelegatingLifecycleSeam(workspace.cwd);
      await expect(
        seam.issueDelegation({
          mode: 'fresh',
          // A bare direct-CLI caller supplies no bearer authority, so the seam
          // refuses before the resolver stub is ever reached. (A run id is only
          // target selection and never proves authority.)
          callerEvidence: { kind: 'direct_cli' },
          explicitTarget: { stepId: '1.1' },
        }),
      ).resolves.toEqual({
        kind: 'refused',
        policy: { kind: 'actor_context_required', intent: 'delegation-issuance' },
      });
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
