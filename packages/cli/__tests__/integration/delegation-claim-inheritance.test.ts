import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  findActionOutput,
  readRunbookState,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

describe('delegation claim inheritance integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('claims child variables from persisted delegation contextSnapshot without injected flags', async () => {
    const parent = [
      '---',
      'inputs:',
      '  - StringValue',
      '  - NumberValue',
      '  - ArrayValue',
      '  - ObjectValue',
      '  - ArtifactValue',
      '---',
      '# Parent',
      '',
      '## 1. Parent step',
      '- PASS CONTINUE',
      '',
      '### 1.1 Delegated child',
      'Review child work.',
      '',
      '## 2. Done',
      '- PASS COMPLETE',
      '',
      'Finished.',
      '',
    ].join('\n');
    const child = [
      '---',
      'inputs:',
      '  - StringValue',
      '  - NumberValue',
      '  - ArrayValue',
      '  - ObjectValue',
      '  - ArtifactValue',
      '---',
      '# Child',
      '',
      '## 1. Child step',
      '- PASS COMPLETE',
      '',
      'String {{StringValue}} number {{NumberValue}} array {{ArrayValue}} object {{ObjectValue}} artifact {{ArtifactValue}}.',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), parent);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), child);

    const artifactValue = {
      kind: 'artifact-record',
      uri: 'rd://artifacts/ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
      path: '.rundown/work/ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
    };

    let result = await runCliInProcess(
      [
        'run',
        '--prompted',
        'parent.runbook.md',
        '--input',
        'StringValue=from-parent',
        '--input-json',
        'NumberValue=42',
        '--input-json',
        'ArrayValue=["alpha","beta"]',
        '--input-json',
        'ObjectValue={"nested":true,"count":2}',
        '--input-json',
        `ArtifactValue=${JSON.stringify(artifactValue)}`,
      ],
      workspace,
    );
    expect(result.exitCode).toBe(0);

    result = await runCliInProcess(['delegate', 'child.runbook.md', '--step', '1.1'], workspace);
    expect(result.exitCode).toBe(0);
    const delegateOutput = JSON.parse(result.stdout) as { token?: string };
    expect(delegateOutput.token).toBeDefined();

    result = await runCliInProcess(['claim', delegateOutput.token!], workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('--input');
    expect(result.stdout).not.toContain('--input-json');
    expect(result.stdout).not.toContain('--input-file');

    const claimOutput = findActionOutput<{ run_id: string }>(result.stdout);
    expect(claimOutput).not.toBeNull();
    const childState = await readRunbookState(workspace, claimOutput!.run_id);
    expect(childState).not.toBeNull();
    expect(childState!.templateVars).toMatchObject({
      StringValue: 'from-parent',
      NumberValue: 42,
      ArrayValue: ['alpha', 'beta'],
      ObjectValue: { nested: true, count: 2 },
      ArtifactValue: artifactValue,
    });
  });
});
