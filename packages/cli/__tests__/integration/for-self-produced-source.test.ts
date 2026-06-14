import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestWorkspace, runCliInProcess, type TestWorkspace } from '../helpers/test-utils.js';
// Mirror the sibling integration tests' harness: createTestWorkspace +
// runCliInProcess(args, workspace), with beforeEach/afterEach for setup/cleanup.

describe('FOR over a self-produced source (#435 C1)', () => {
  let workspace: TestWorkspace;
  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });
  afterEach(async () => {
    await workspace.cleanup();
  });

  it('launches without a seed and iterates the produced array', async () => {
    const rb = [
      '# Self Produced',
      '## 1. Capture items',
      '- OUTPUTS',
      '  - Items',
      '- PASS CONTINUE',
      '- FAIL STOP',
      '```sh',
      `printf '["left","right"]' > "$RD_OUTPUTS_Items"`,
      '```',
      '',
      '## 2. Iterate',
      '- FOR item IN {{ Items }}',
      '- PASS ALL COMPLETE',
      '- FAIL ANY STOP',
      '',
      '### 2.1 Check',
      '- PASS CONTINUE',
      '- FAIL STOP',
      '```sh',
      'rd echo "{{ Index }}:{{ item }}"',
      '```',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'self-produced.runbook.md'), rb);
    // run WITHOUT any --input seed:
    const res = await runCliInProcess(
      ['run', '--allow-all', 'self-produced.runbook.md'],
      workspace,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('1:left');
    expect(res.stdout).toContain('2:right');
  });
});
