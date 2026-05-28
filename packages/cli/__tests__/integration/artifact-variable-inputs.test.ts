import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendArtifactManifestRecordSync, assertRunId } from '@rundown-org/core';
import {
  createTestWorkspace,
  getActiveState,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

describe('artifact variable inputs integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  function appendManagedManifestRow(contextId: string, key = 'plan.json') {
    const runId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const uri = `rd://artifacts/${contextId}/${runId}/${key}`;
    appendArtifactManifestRecordSync(
      { cwd: workspace.cwd, workPath: '.rundown/work' },
      {
        uri,
        runId,
        contextId,
        runbook: { source: 'project', path: 'producer.runbook.md' },
        key,
        timestamp: '2026-05-25T00:00:00.000Z',
      },
    );
    return { uri, runId, contextId, key };
  }

  async function writeReviewRunbook(body = '{{ Plan }}'): Promise<void> {
    await writeFile(
      join(workspace.cwd, 'review.runbook.md'),
      `# Review

## 1. Review
- PASS COMPLETE
- FAIL STOP

${body}
`,
    );
  }

  it('binds exact URI input as a runtime artifact variable', async () => {
    const row = appendManagedManifestRow('ctx-a');
    await writeReviewRunbook();

    const result = await runCliInProcess(
      ['run', 'review.runbook.md', '--prompted', '--input', `Plan=${row.uri}`],
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const state = await getActiveState(workspace);
    expect(state).not.toBeNull();
    expect(state!.templateVars).not.toHaveProperty('Plan');
    expect(state!.variables.Plan).toMatchObject({ kind: 'artifact-record', uri: row.uri });
  });

  it('maps artifact-shaped --input-json by URI and ignores forged fields', async () => {
    const row = appendManagedManifestRow('producer-context');
    await writeReviewRunbook();

    const forged = {
      kind: 'artifact-record',
      uri: row.uri,
      runId: 'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      contextId: 'forged-context',
      runbook: { source: 'project', path: 'forged.runbook.md' },
      key: 'forged.json',
      timestamp: '2026-05-26T00:00:00.000Z',
      path: '/outside/project/secret.txt',
    };
    const result = await runCliInProcess(
      ['run', 'review.runbook.md', '--prompted', '--input-json', `Plan=${JSON.stringify(forged)}`],
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const state = await getActiveState(workspace);
    expect(state).not.toBeNull();
    expect(state!.templateVars).not.toHaveProperty('Plan');
    expect(state!.variables.Plan).toMatchObject({
      kind: 'artifact-record',
      uri: row.uri,
      contextId: 'producer-context',
      key: 'plan.json',
    });
    expect(JSON.stringify(state!.variables.Plan)).not.toContain('/outside/project/secret.txt');
  });

  it('rejects forged file artifact records from --input-json without persisting them', async () => {
    await writeReviewRunbook();
    const forged = {
      kind: 'file-artifact-record',
      uri: 'file:///outside/project/secret.txt',
      runId: 'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      contextId: 'forged-context',
      runbook: { source: 'project', path: 'forged.runbook.md' },
      key: 'secret.txt',
      timestamp: '2026-05-26T00:00:00.000Z',
    };

    const result = await runCliInProcess(
      ['run', 'review.runbook.md', '--prompted', '--input-json', `Plan=${JSON.stringify(forged)}`],
      workspace,
    );

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: expect.stringContaining('Artifact record input for "Plan"'),
    });
    const state = await getActiveState(workspace);
    expect(state?.variables ?? {}).not.toHaveProperty('Plan');
  });

  it('rejects forged file artifact records from --input-file without persisting them', async () => {
    await writeReviewRunbook();
    await writeFile(
      join(workspace.cwd, 'forged-input.yaml'),
      [
        'Plan:',
        '  kind: file-artifact-record',
        '  uri: file:///outside/project/secret.txt',
        '  runId: rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        '  contextId: forged-context',
        '  runbook:',
        '    source: project',
        '    path: forged.runbook.md',
        '  key: secret.txt',
        '  timestamp: "2026-05-26T00:00:00.000Z"',
      ].join('\n'),
    );

    const result = await runCliInProcess(
      ['run', 'review.runbook.md', '--prompted', '--input-file', 'forged-input.yaml'],
      workspace,
    );

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: expect.stringContaining('Artifact record input for "Plan"'),
    });
    const state = await getActiveState(workspace);
    expect(state?.variables ?? {}).not.toHaveProperty('Plan');
  });

  it('supports cross-context exact URI input', async () => {
    const row = appendManagedManifestRow('producer-context');
    await writeReviewRunbook();

    const result = await runCliInProcess(
      ['run', 'review.runbook.md', '--prompted', '--input', `Plan=${row.uri}`],
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const state = await getActiveState(workspace);
    expect(state).not.toBeNull();
    expect(state!.variables.Plan).toMatchObject({ contextId: 'producer-context' });
    expect(state!.templateVars?.ContextId).not.toBe('producer-context');
  });

  it('keeps missing exact URI input as a template string', async () => {
    const uri = 'rd://artifacts/missing-context/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json';
    await writeReviewRunbook();

    const result = await runCliInProcess(
      ['run', 'review.runbook.md', '--prompted', '--input', `Plan=${uri}`],
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const state = await getActiveState(workspace);
    expect(state).not.toBeNull();
    expect(state!.templateVars?.Plan).toBe(uri);
    expect(state!.variables).not.toHaveProperty('Plan');
  });

  it('does not treat shorthand input as an artifact lookup', async () => {
    await writeReviewRunbook();

    const result = await runCliInProcess(
      ['run', 'review.runbook.md', '--prompted', '--input', 'Plan=plan.json'],
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const state = await getActiveState(workspace);
    expect(state).not.toBeNull();
    expect(state!.templateVars?.Plan).toBe('plan.json');
    expect(state!.variables).not.toHaveProperty('Plan');
  });

  it('binds exact URI array input as runtime artifact variables', async () => {
    const a = appendManagedManifestRow('ctx-a', 'a.json');
    const b = appendManagedManifestRow('ctx-a', 'b.json');
    await writeReviewRunbook('{{ Plans }}');

    const result = await runCliInProcess(
      [
        'run',
        'review.runbook.md',
        '--prompted',
        '--input-json',
        `Plans=${JSON.stringify([a.uri, b.uri])}`,
      ],
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const state = await getActiveState(workspace);
    expect(state).not.toBeNull();
    expect(state!.templateVars).not.toHaveProperty('Plans');
    expect(state!.variables.Plans).toEqual([
      expect.objectContaining({ kind: 'artifact-record', key: 'a.json' }),
      expect.objectContaining({ kind: 'artifact-record', key: 'b.json' }),
    ]);
  });

  it('status and pass render runtime artifact variables after reload', async () => {
    const row = appendManagedManifestRow('ctx-a');
    await writeFile(
      join(workspace.cwd, 'reload.runbook.md'),
      `# Reload Artifact

## 1. Review
- PASS CONTINUE
- FAIL STOP

First {{ Plan }}

## 2. Continue
- PASS COMPLETE
- FAIL STOP

Second {{ Plan }}
`,
    );

    const run = await runCliInProcess(
      ['run', 'reload.runbook.md', '--prompted', '--input', `Plan=${row.uri}`],
      workspace,
    );
    expect(run.exitCode).toBe(0);

    const status = await runCliInProcess(['status'], workspace);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      active: true,
      step: expect.objectContaining({ name: '1' }),
    });

    const pass = await runCliInProcess(['pass', '--text'], workspace);
    expect(pass.exitCode).toBe(0);
    expect(pass.stdout).toContain(row.uri);
    expect(pass.stdout).toContain('Second');
  });
});
