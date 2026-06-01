import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  findActionOutput,
  getActiveState,
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

  async function writeParentWithPlanArtifact(): Promise<void> {
    const parent = [
      '# Parent',
      '',
      '## 1. Produce artifact',
      '- ARTIFACTS',
      '  - Plan "plan.json"',
      '- PASS CONTINUE',
      '- FAIL STOP',
      '',
      '```sh',
      'printf \'{"ok":true}\' > "{{ path Plan }}"',
      '```',
      '',
      '## 2. Parent step',
      '- PASS ALL COMPLETE',
      '- FAIL ANY STOP',
      '',
      '### 2.1 Delegated child',
      '- DELEGATE',
      '',
      'Review child work.',
      '',
      '- artifact-child.runbook.md',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'artifact-parent.runbook.md'), parent);
  }

  async function writeDelegatedChild(body: string): Promise<void> {
    const child = [
      '---',
      'inputs:',
      '  - Plan',
      '---',
      '# Child',
      '',
      '## 1. Child step',
      '- PASS COMPLETE',
      '',
      body,
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'artifact-child.runbook.md'), child);
  }

  it('claims child variables from persisted delegation contextSnapshot without injected flags', async () => {
    const parent = [
      '---',
      'inputs:',
      '  - StringValue',
      '  - NumberValue',
      '  - ArrayValue',
      '  - ObjectValue',
      '---',
      '# Parent',
      '',
      '## 1. Parent step',
      '- PASS CONTINUE',
      '',
      '### 1.1 Delegated child',
      '- DELEGATE',
      '',
      'Review child work.',
      '',
      '- child.runbook.md',
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
      '---',
      '# Child',
      '',
      '## 1. Child step',
      '- PASS COMPLETE',
      '',
      'String {{StringValue}} number {{NumberValue}} array {{ArrayValue}} object {{ObjectValue}}.',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), parent);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), child);

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
      ],
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const parentState = await getActiveState(workspace);
    const token = parentState?.substepStates?.[0]?.delegation?.token;
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));

    result = await runCliInProcess(['claim', token!], workspace);
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
    });
  });

  it('claims child artifact variables from persisted delegation contextSnapshot without injected flags', async () => {
    const parent = [
      '# Parent',
      '',
      '## 1. Produce artifact',
      '- ARTIFACTS',
      '  - PlanPath "plan.json"',
      '- PASS CONTINUE',
      '- FAIL STOP',
      '',
      '```sh',
      'printf \'{"ok":true}\' > "{{ path PlanPath }}"',
      '```',
      '',
      '## 2. Parent step',
      '- PASS ALL COMPLETE',
      '- FAIL ANY STOP',
      '',
      '### 2.1 Delegated child',
      '- DELEGATE',
      '',
      'Review child work.',
      '',
      '- artifact-child.runbook.md',
      '',
    ].join('\n');
    const child = [
      '---',
      'inputs:',
      '  - PlanPath',
      '---',
      '# Child',
      '',
      '## 1. Child step',
      '- PASS COMPLETE',
      '',
      'Plan {{ PlanPath.uri }}.',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'artifact-parent.runbook.md'), parent);
    await writeFile(join(workspace.cwd, 'artifact-child.runbook.md'), child);

    let result = await runCliInProcess(
      ['run', 'artifact-parent.runbook.md', '--allow-all'],
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const parentState = await getActiveState(workspace);
    const token = parentState?.substepStates?.[0]?.delegation?.token;
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));

    result = await runCliInProcess(['claim', token!], workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('--input');
    expect(result.stdout).not.toContain('--input-json');
    expect(result.stdout).not.toContain('--input-file');

    const claimOutput = findActionOutput<{ run_id: string }>(result.stdout);
    expect(claimOutput).not.toBeNull();
    const childState = await readRunbookState(workspace, claimOutput!.run_id);
    expect(childState!.variables.PlanPath).toMatchObject({
      kind: 'artifact-record',
      key: 'plan.json',
      uri: expect.stringMatching(/^rd:\/\/artifacts\/[^/]+\/rd_[a-f0-9]{32}\/plan\.json$/),
    });
  });

  it('passes parent artifact variables to delegated child runtime variables', async () => {
    await writeParentWithPlanArtifact();
    await writeDelegatedChild('URI={{ Plan }}\nPATH={{ path Plan }}');

    let result = await runCliInProcess(
      ['run', 'artifact-parent.runbook.md', '--allow-all'],
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const parentState = await getActiveState(workspace);
    const token = parentState?.substepStates?.[0]?.delegation?.token;
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
    if (typeof token !== 'string') throw new Error('Expected delegation token');

    result = await runCliInProcess(['claim', token], workspace);
    expect(result.exitCode).toBe(0);
    const claimOutput = findActionOutput<{ run_id: string }>(result.stdout);
    expect(claimOutput).not.toBeNull();
    const childState = await readRunbookState(workspace, claimOutput!.run_id);

    expect(childState).not.toBeNull();
    expect(childState!.templateVars).not.toHaveProperty('Plan');
    expect(childState!.variables.Plan).toMatchObject({
      kind: 'artifact-record',
      key: 'plan.json',
    });
  });

  it('lets explicit child input override an inherited artifact with the same key', async () => {
    await writeParentWithPlanArtifact();
    await writeDelegatedChild('{{ Plan }}');

    let result = await runCliInProcess(
      ['run', 'artifact-parent.runbook.md', '--allow-all'],
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const parentState = await getActiveState(workspace);
    const token = parentState?.substepStates?.[0]?.delegation?.token;
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
    if (typeof token !== 'string') throw new Error('Expected delegation token');

    result = await runCliInProcess(['claim', token, '--input', 'Plan=literal'], workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('literal');
    const claimOutput = findActionOutput<{ run_id: string }>(result.stdout);
    expect(claimOutput).not.toBeNull();
    const childState = await readRunbookState(workspace, claimOutput!.run_id);

    expect(childState).not.toBeNull();
    expect(childState!.templateVars?.Plan).toBe('literal');
    expect(childState!.variables).not.toHaveProperty('Plan');
  });
});
