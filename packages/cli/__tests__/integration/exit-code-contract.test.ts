import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCliInProcess,
  flattenEvents,
  parseConcatenatedJson,
  readRunbookState,
  requireOwnerToken,
  requireRunId,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The shared halt rule, stated across the commands that can reach a terminal.
 *
 * `docs/reference/cli.md` § "Exit codes for `run`, `goto`, `pass` and `fail`"
 * and ADR 0004: the exit code answers ONE question — has the workflow this
 * process drives halted? Under one writer per run (#901) a process drives
 * exactly one run, so the question is whether THAT run rests on a terminal:
 * a STOP exits 1, a CONTINUE / waiting step exits 0, a COMPLETE exits 0.
 */

const FAILS_AT_STEP_1 = `# Solo

## 1. Execute

- PASS COMPLETE
- FAIL STOP

\`\`\`bash
rd echo --result fail
\`\`\`
`;

const FAILS_AT_STEP_2 = `# Solo

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

const WAITS_THEN_WAITS = `# Solo

## 1. Start

- PASS CONTINUE
- FAIL STOP

Waiting.

## 2. Middle

- PASS CONTINUE
- FAIL STOP

Still waiting.

## 3. Done

- PASS COMPLETE
- FAIL STOP

Final step.
`;

describe('exit-code contract: the exit code reports where the run rests', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function start(
    markdown: string,
    flags = '',
  ): Promise<{ token: string; runId: string; stdout: string; exitCode: number }> {
    await writeFile(join(workspace.cwd, 'solo.runbook.md'), markdown);
    const started = await runCliInProcess(`run solo.runbook.md${flags}`, workspace);
    return {
      token: requireOwnerToken(started.stdout),
      runId: requireRunId(started.stdout),
      stdout: started.stdout,
      exitCode: started.exitCode,
    };
  }

  describe('the run halts on STOP', () => {
    it('`run` exits 1 when the run it started rests on its own STOP', async () => {
      const started = await start(FAILS_AT_STEP_1);

      expect(started.exitCode).toBe(1);
      const state = await readRunbookState(workspace, started.runId);
      expect(state!.lifecycle).toBe('stopped');
    });

    it('`pass` exits 1 when the transition drives the run onto a STOP', async () => {
      const { token, runId, exitCode } = await start(FAILS_AT_STEP_2);
      expect(exitCode).toBe(0);

      // Leaving the manual gate executes step 2, whose command fails into STOP.
      const result = await runCliInProcess(`pass --token ${token} --step 1`, workspace);

      expect(result.exitCode).toBe(1);
      const events = flattenEvents(parseConcatenatedJson(result.stdout));
      expect(events.some((event) => event.type === 'runbook_stopped')).toBe(true);
      const state = await readRunbookState(workspace, runId);
      expect(state!.lifecycle).toBe('stopped');
    });

    it("`fail` exits 1 when the step's FAIL handler is STOP", async () => {
      const { token, runId } = await start(WAITS_THEN_WAITS);

      const result = await runCliInProcess(`fail --token ${token} --step 1`, workspace);

      expect(result.exitCode).toBe(1);
      expect(parseConcatenatedJson(result.stdout)).toContainEqual(
        expect.objectContaining({ kind: 'action', action: 'stop', stopped: true }),
      );
      const state = await readRunbookState(workspace, runId);
      expect(state!.lifecycle).toBe('stopped');
    });
  });

  describe('the run keeps running', () => {
    it('`pass` exits 0 when the run rests on the next waiting step', async () => {
      const { token, runId } = await start(WAITS_THEN_WAITS);

      const result = await runCliInProcess(`pass --token ${token} --step 1`, workspace);

      expect(result.exitCode).toBe(0);
      const state = await readRunbookState(workspace, runId);
      expect(state!.lifecycle).toBe('running');
      expect(state!.step).toBe('2');
    });

    it('`goto` exits 0 when the jump lands on a waiting step', async () => {
      const { token, runId } = await start(WAITS_THEN_WAITS);

      const result = await runCliInProcess(`goto 3 --token ${token}`, workspace);

      expect(result.exitCode).toBe(0);
      const state = await readRunbookState(workspace, runId);
      expect(state!.lifecycle).toBe('running');
      expect(state!.step).toBe('3');
    });

    it('`pass` exits 0 when the transition completes the run', async () => {
      const { token, runId } = await start(WAITS_THEN_WAITS);
      await runCliInProcess(`goto 3 --token ${token}`, workspace);

      const result = await runCliInProcess(`pass --token ${token} --step 3`, workspace);

      expect(result.exitCode).toBe(0);
      const state = await readRunbookState(workspace, runId);
      expect(state!.lifecycle).toBe('completed');
    });
  });

  describe('refusals exit 1 without moving the run', () => {
    it('a stale `--step` is INVALID_STEP and the run stays where it was', async () => {
      const { token, runId } = await start(WAITS_THEN_WAITS);
      await runCliInProcess(`pass --token ${token} --step 1`, workspace);

      const result = await runCliInProcess(`pass --token ${token} --step 1`, workspace);

      expect(result.exitCode).toBe(1);
      expect(parseConcatenatedJson(result.stdout)).toContainEqual(
        expect.objectContaining({ kind: 'error', code: 'INVALID_STEP' }),
      );
      const state = await readRunbookState(workspace, runId);
      expect(state!.step).toBe('2');
      expect(state!.lifecycle).toBe('running');
    });
  });
});
