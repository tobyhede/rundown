import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { RunbookStateManager, RunbookLifecycleCommandService } from '@rundown-org/core';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  createTestWorkspace,
  createRunbook,
  readRunbookState,
  requireOwnerToken,
  requireRunId,
  runCliInProcess,
  type TestWorkspace,
} from './test-utils.js';

// Static import of the factory under test. The behavioural tests below drive the
// pass/complete lifecycle through `runCliInProcess`, which reaches this helper
// via a *dynamic* `import('../cli.js')` — an edge Stryker's
// `enableFindRelatedTests` (Jest's static inverse-module graph) cannot see.
// Without a static import here, a per-mutant
// `jest --findRelatedTests src/helpers/lifecycle-seam-factory.ts` matches no
// test file, so Stryker runs zero tests per mutant and every mutant falsely
// survives (0.00% score — issue #541). This static edge links the file into the
// graph so the covering tests actually run against each mutant.
import { buildLifecycleSeam } from '../../src/helpers/lifecycle-seam-factory.js';

describe('buildLifecycleSeam', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('construction', () => {
    it('binds a manager and a lifecycle seam to the cwd', () => {
      const { manager, seam } = buildLifecycleSeam(workspace.cwd);
      expect(manager).toBeInstanceOf(RunbookStateManager);
      // The manager canonicalizes its project root (macOS /var → /private/var).
      expect(manager.cwd).toBe(realpathSync(workspace.cwd));
      expect(seam).toBeInstanceOf(RunbookLifecycleCommandService);
    });

    it('builds a fresh manager and seam per call (no shared singleton)', () => {
      const first = buildLifecycleSeam(workspace.cwd);
      const second = buildLifecycleSeam(workspace.cwd);
      expect(first.manager).not.toBe(second.manager);
      expect(first.seam).not.toBe(second.seam);
    });
  });

  describe('lifecycle transitions run through the seam', () => {
    const runbook = createRunbook({
      steps: [
        { title: 'First', pass: 'CONTINUE', content: 'Manual step one.' },
        { title: 'Second', pass: 'COMPLETE', content: 'Manual step two.' },
      ],
    });

    it('passes a step through the transition seam (runTransition exercises loadSteps)', async () => {
      // Manual (command-less) steps so `run` halts awaiting a `pass` rather than
      // auto-executing the command and running the whole runbook to completion.
      await writeFile(join(workspace.cwd, 'runbooks', 'seam.runbook.md'), runbook);

      const start = await runCliInProcess('run runbooks/seam.runbook.md', workspace);
      expect(start.exitCode).toBe(0);
      const token = requireOwnerToken(start.stdout);
      const runId = requireRunId(start.stdout);

      const pass = await runCliInProcess(['pass', '--token', token, '--step', '1'], workspace);
      expect(pass.exitCode).toBe(0);

      const advanced = await readRunbookState(workspace, runId);
      expect(advanced?.step).toBe('2');
      expect(advanced?.lifecycle).toBe('running');
    });

    it('completes a run through the terminal seam (runTerminal exercises loadSteps)', async () => {
      await writeFile(join(workspace.cwd, 'runbooks', 'terminal.runbook.md'), runbook);

      const start = await runCliInProcess('run runbooks/terminal.runbook.md', workspace);
      expect(start.exitCode).toBe(0);
      const token = requireOwnerToken(start.stdout);
      const runId = requireRunId(start.stdout);

      const complete = await runCliInProcess(['complete', '--token', token], workspace);
      expect(complete.exitCode).toBe(0);

      const afterComplete = await readRunbookState(workspace, runId);
      expect(afterComplete?.lifecycle).toBe('completed');
    });

    it('navigates a run through the navigation seam (resolveRunNavigation + runNavigationMutation)', async () => {
      await writeFile(join(workspace.cwd, 'runbooks', 'nav.runbook.md'), runbook);

      const start = await runCliInProcess('run runbooks/nav.runbook.md', workspace);
      expect(start.exitCode).toBe(0);
      const token = requireOwnerToken(start.stdout);
      const runId = requireRunId(start.stdout);

      const goto = await runCliInProcess(['goto', '2', '--token', token], workspace);
      expect(goto.exitCode).toBe(0);

      const moved = await readRunbookState(workspace, runId);
      expect(moved?.step).toBe('2');
    });
  });
});
