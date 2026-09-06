import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCliInProcess,
  getActiveState,
  readRunbookState,
  withRunTarget,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The shared halt rule, stated across the commands that can reach a terminal.
 *
 * `docs/reference/cli.md` § "Exit codes for `run`, `goto`, `pass` and `fail`"
 * and ADR 0004: the exit code answers ONE question — has the workflow this
 * process drives halted? It is not "did the run I named stop?".
 *
 * These cases hold the failure MECHANISM constant — an auto-executed command
 * exits non-zero under a `FAIL STOP` handler — and vary only which command is
 * in flight when the child reaches its terminal. Before the Run Progression
 * migration `run` and `goto` answered a different question from `pass`, so the
 * same run states produced two different exit codes depending on the verb.
 */

/**
 * The two parents differ ONLY in substep count, not in their handlers. That is
 * the whole point: absorption is not a softer handler, it is `FAIL ANY`
 * aggregation that has not fired yet because a sibling is still pending. A
 * failed 1.1 defers to 1.2 and the parent keeps running; the STOP arrives later,
 * when 1.2 resolves.
 */
const DEFERRING_PARENT = `# Parent

## 1. Review

- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Code review

Do code review.

### 1.2 Security review

Do security review.

## 2. Done

- PASS COMPLETE

Final step.
`;

/** The same handlers with ONE substep: the failed child aggregates immediately. */
const HALTING_PARENT = `# Parent

## 1. Review

- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Inline gate

Run the inline gate.

## 2. Done

- PASS COMPLETE

Final step.
`;

/** The child fails inside the launching `run`. */
const CHILD_FAILS_AT_STEP_1 = `# Child

## 1. Execute

- PASS COMPLETE
- FAIL STOP

\`\`\`bash
rd echo --result fail
\`\`\`
`;

/** The child waits at step 1, then fails at step 2 — reached by `pass` or `goto`. */
const CHILD_FAILS_AT_STEP_2 = `# Child

## 1. Start

- PASS CONTINUE

Waiting.

## 2. Execute

- PASS COMPLETE
- FAIL STOP

\`\`\`bash
rd echo --result fail
\`\`\`
`;

describe('exit-code contract: the exit code reports the resting run, not the named run', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function startParent(parent: string): Promise<string> {
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), parent);
    const started = await runCliInProcess('run --prompted parent.runbook.md', workspace);
    expect(started.exitCode).toBe(0);
    const state = await getActiveState(workspace);
    expect(state).not.toBeNull();
    return state!.id;
  }

  describe('the composing parent defers to a pending sibling and keeps running', () => {
    it('`run` exits 0 when the child stops inside the launch', async () => {
      const parentRunId = await startParent(DEFERRING_PARENT);
      await writeFile(join(workspace.cwd, 'child.runbook.md'), CHILD_FAILS_AT_STEP_1);

      const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);

      expect(result.exitCode).toBe(0);
      const parent = await readRunbookState(workspace, parentRunId);
      expect(parent!.lifecycle).toBe('running');
    });

    it('`pass` exits 0 when the same child stops during the transition', async () => {
      const parentRunId = await startParent(DEFERRING_PARENT);
      await writeFile(join(workspace.cwd, 'child.runbook.md'), CHILD_FAILS_AT_STEP_2);

      const launch = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(launch.exitCode).toBe(0);

      const result = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);

      expect(result.exitCode).toBe(0);
      const parent = await readRunbookState(workspace, parentRunId);
      expect(parent!.lifecycle).toBe('running');
    });

    it('`goto` exits 0 when the same child stops during the jump', async () => {
      const parentRunId = await startParent(DEFERRING_PARENT);
      await writeFile(join(workspace.cwd, 'child.runbook.md'), CHILD_FAILS_AT_STEP_2);

      const launch = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(launch.exitCode).toBe(0);

      const result = await runCliInProcess(
        await withRunTarget(['goto', '2'], workspace),
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const parent = await readRunbookState(workspace, parentRunId);
      expect(parent!.lifecycle).toBe('running');
    });

    it('keeps the absorbed child stop visible on the JSON stream at exit 0', async () => {
      await startParent(DEFERRING_PARENT);
      await writeFile(join(workspace.cwd, 'child.runbook.md'), CHILD_FAILS_AT_STEP_1);

      const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);

      // The exit code is the halt signal; the event stream is the failure
      // signal. An agent that reads only the exit code would miss this.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"type":"runbook_stopped"');
      expect(result.stdout).toContain('"reason":"fail_transition"');
    });
  });

  describe('the composing parent aggregates and halts', () => {
    it('`run` exits 1 when advancing the parent reaches its own STOP', async () => {
      const parentRunId = await startParent(HALTING_PARENT);
      await writeFile(join(workspace.cwd, 'child.runbook.md'), CHILD_FAILS_AT_STEP_1);

      const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);

      expect(result.exitCode).toBe(1);
      const parent = await readRunbookState(workspace, parentRunId);
      expect(parent!.lifecycle).toBe('stopped');
    });
  });

  describe('no composing parent', () => {
    it('`run` exits 1 when the run it started is itself where progression rests', async () => {
      await writeFile(join(workspace.cwd, 'solo.runbook.md'), CHILD_FAILS_AT_STEP_1);

      const result = await runCliInProcess('run solo.runbook.md', workspace);

      expect(result.exitCode).toBe(1);
    });
  });
});
