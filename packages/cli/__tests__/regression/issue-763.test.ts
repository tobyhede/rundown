import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  findActionOutput,
  parseConcatenatedJson,
  requireOwnerToken,
  requireRunId,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

// Issue #763. A `--step` outside the contract used to be resolved INSIDE the
// execution fence, after state had been written, so the refusal latched
// recovery and every later `pass` refused `RECOVERY_REQUIRED`. Nothing
// external had run.
//
// Under one writer per run (#901) `--step` is REQUIRED and must name the
// run's current position: a bare top-level id is accepted at a top-level
// step (the #763 reversal), and anything else is refused by core before
// anything is written, with the typed `INVALID_STEP` error naming the
// current position. The run is left exactly where it was.
describe('issue #763: an out-of-contract pass/fail --step is refused before anything is written', () => {
  let workspace: TestWorkspace;
  let token: string;
  let runId: string;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    const runbook = [
      '---',
      'name: two',
      '---',
      '# Two',
      '',
      '## 1. One',
      'Do one.',
      '',
      '## 2. Two',
      'Do two.',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'two.runbook.md'), runbook);
    const start = await runCliInProcess('run two.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    token = requireOwnerToken(start.stdout);
    runId = requireRunId(start.stdout);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  function errorEnvelope(stdout: string): Record<string, unknown> | undefined {
    return parseConcatenatedJson(stdout).find(
      (document): document is Record<string, unknown> =>
        typeof document === 'object' &&
        document !== null &&
        (document as Record<string, unknown>).kind === 'error',
    );
  }

  async function currentStep(): Promise<unknown> {
    const status = await runCliInProcess(['status', '--run', runId], workspace);
    expect(status.exitCode).toBe(0);
    const detail = parseConcatenatedJson(status.stdout).at(-1) as Record<string, unknown>;
    return (detail.position as Record<string, unknown> | undefined)?.current;
  }

  it.each([
    ['pass', '2', 'names a later step'],
    ['pass', '1.9', 'names a substep the step does not have'],
    ['fail', '2', 'names a later step'],
  ])(
    '%s --step %s (%s) is refused with INVALID_STEP and leaves the run usable',
    async (command, step) => {
      const refused = await runCliInProcess([command, '--token', token, '--step', step], workspace);

      expect(refused.exitCode).toBe(1);
      const envelope = errorEnvelope(refused.stdout);
      expect(envelope?.code).toBe('INVALID_STEP');
      expect(String(envelope?.error)).toContain(`--step ${step}`);
      expect(refused.stdout).not.toContain('RECOVERY_REQUIRED');

      // Nothing was written: the run is still at step 1 and a pass naming the
      // current step advances it.
      expect(await currentStep()).toBe('1');
      const advanced = await runCliInProcess(['pass', '--token', token, '--step', '1'], workspace);
      expect(advanced.exitCode).toBe(0);
      expect(findActionOutput(advanced.stdout)).toMatchObject({ from: '1', at: '2' });
      expect(await currentStep()).toBe('2');
    },
  );

  it.each(['pass', 'fail'])(
    '%s without --step is refused with INVALID_STEP naming the current position',
    async (command) => {
      const refused = await runCliInProcess([command, '--token', token], workspace);

      expect(refused.exitCode).toBe(1);
      const envelope = errorEnvelope(refused.stdout);
      expect(envelope?.code).toBe('INVALID_STEP');
      expect(String(envelope?.error)).toContain('--step is required');
      expect(String(envelope?.error)).toContain('the current position is 1');
      expect(await currentStep()).toBe('1');
    },
  );
});
