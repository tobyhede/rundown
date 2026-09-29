import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  findActionOutput,
  parseConcatenatedJson,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

// Issue #763. `--step` on `pass` / `fail` targets a SUBSTEP. A value outside
// that contract — a bare top-level step id, whether or not it names the
// current step — used to be resolved INSIDE the execution fence's `compute`,
// after the lease was acquired and the effect boundary marked. The resolver's
// throw was then indistinguishable from a failed external effect, so the
// executor latched `recoveryRequired` (`effect_boundary_crossed`) and every
// later `pass` refused `RECOVERY_REQUIRED`. Nothing external had run.
//
// The contract pinned here: the target is resolved against the captured state
// BEFORE any lease or effect marker is written, refused with the typed
// `INVALID_STEP` error, and the run is left exactly where it was.
describe('issue #763: an out-of-contract pass/fail --step is refused before the fence', () => {
  let workspace: TestWorkspace;

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
    const status = await runCliInProcess('status', workspace);
    expect(status.exitCode).toBe(0);
    const detail = parseConcatenatedJson(status.stdout).at(-1) as Record<string, unknown>;
    return (detail.position as Record<string, unknown> | undefined)?.current;
  }

  it.each([
    ['pass', '1', 'names the current step'],
    ['pass', '2', 'names a later step'],
    ['pass', '1.9', 'names a substep the step does not have'],
    ['fail', '1', 'names the current step'],
  ])(
    '%s --step %s (%s) is refused with INVALID_STEP and leaves the run usable',
    async (command, step) => {
      const refused = await runCliInProcess([command, '--step', step], workspace);

      expect(refused.exitCode).toBe(1);
      const envelope = errorEnvelope(refused.stdout);
      expect(envelope?.code).toBe('INVALID_STEP');
      expect(String(envelope?.error)).toContain(`--step ${step}`);
      expect(refused.stdout).not.toContain('RECOVERY_REQUIRED');

      // Nothing was latched: the run is still at step 1 and a plain pass advances it.
      expect(await currentStep()).toBe('1');
      const advanced = await runCliInProcess('pass', workspace);
      expect(advanced.exitCode).toBe(0);
      expect(findActionOutput(advanced.stdout)).toMatchObject({ from: '1', at: '2' });
      expect(await currentStep()).toBe('2');
    },
  );
});
