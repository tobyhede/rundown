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
      ['run', 'review.runbook.md', '--prompted', '--artifacts', `Plan=${row.uri}`],
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const state = await getActiveState(workspace);
    expect(state).not.toBeNull();
    expect(state!.templateVars).not.toHaveProperty('Plan');
    expect(state!.variables.Plan).toMatchObject({ kind: 'artifact-record', uri: row.uri });
  });

  it('maps artifact-shaped --artifacts-json by URI and ignores forged fields', async () => {
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
      [
        'run',
        'review.runbook.md',
        '--prompted',
        '--artifacts-json',
        `Plan=${JSON.stringify(forged)}`,
      ],
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

  it('rejects forged file artifact records from --artifacts-json without persisting them', async () => {
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
      [
        'run',
        'review.runbook.md',
        '--prompted',
        '--artifacts-json',
        `Plan=${JSON.stringify(forged)}`,
      ],
      workspace,
    );

    expect(result.exitCode).not.toBe(0);
    // Clean break: a non-rd:// value on the artifact channel is a hard error at
    // boundary ingress (must-resolve), not the partition-level forgery check.
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: expect.stringContaining('Artifact input "Plan"'),
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
      ['run', 'review.runbook.md', '--prompted', '--artifacts', `Plan=${row.uri}`],
      workspace,
    );
    expect(result.exitCode).toBe(0);

    const state = await getActiveState(workspace);
    expect(state).not.toBeNull();
    expect(state!.variables.Plan).toMatchObject({ contextId: 'producer-context' });
    expect(state!.templateVars?.ContextId).not.toBe('producer-context');
  });

  it('clean break: a missing rd:// URI via --input stays a plain template string', async () => {
    // --input no longer rehydrates rd:// values (the artifact channel does that,
    // and would hard-fail a missing row). On the variable channel it is a string.
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
        '--artifacts-json',
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
    // Path-first: a bare artifact alias renders its resolved local path, which
    // the projection recomputes from the manifest under the run's work dir.
    const expectedPathSuffix = join('.rundown/work', `.rd-${row.contextId}`, row.runId, row.key);
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
      ['run', 'reload.runbook.md', '--prompted', '--artifacts', `Plan=${row.uri}`],
      workspace,
    );
    expect(run.exitCode).toBe(0);

    const status = await runCliInProcess(['status'], workspace);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      active: true,
      step: expect.objectContaining({ name: '1' }),
      vars: expect.objectContaining({ Plan: expect.stringContaining(expectedPathSuffix) }),
    });

    const textStatus = await runCliInProcess(['status', '--text'], workspace);
    expect(textStatus.exitCode).toBe(0);
    expect(textStatus.stdout).toContain('Plan');
    expect(textStatus.stdout).toContain(expectedPathSuffix);

    const pass = await runCliInProcess(['pass', '--text'], workspace);
    expect(pass.exitCode).toBe(0);
    expect(pass.stdout).toContain(expectedPathSuffix);
    expect(pass.stdout).toContain('Second');
  });

  it('status renders an ARTIFACTS-produced variable as a local path, never an rd:// URI', async () => {
    // Migrated from the `status-shows-artifact-vars` scenario in
    // runbooks/artifacts/artifact-status-vars.runbook.md, which asserted this by
    // spawning `rd status` inside a `node -e` one-liner — a hidden CLI
    // invocation that docs/internal/scenarios.md forbids and that the scenario
    // authoring lint now rejects. Payload assertions belong here.
    //
    // Unlike the reload test above, the artifact is *produced* by the run's own
    // ARTIFACTS clause rather than injected via --artifacts, so this covers the
    // producer side of the projection.
    await writeFile(
      join(workspace.cwd, 'produce.runbook.md'),
      `# Produce Artifact

## 1. Produce an artifact variable

- ARTIFACTS
  - PlanPath "plan.json"
- PASS CONTINUE

\`\`\`bash
printf '{"plan":"ok"}' > "{{ path PlanPath }}"
\`\`\`

## 2. Pause with the artifact variable in scope

- ARTIFACTS
  - PlanPath
- PASS COMPLETE
- FAIL STOP
`,
    );

    const run = await runCliInProcess(['run', 'produce.runbook.md', '--allow-all'], workspace);
    expect(run.exitCode).toBe(0);

    const status = await runCliInProcess(['status'], workspace);
    expect(status.exitCode).toBe(0);
    const vars = (JSON.parse(status.stdout) as { vars?: Record<string, string> }).vars;
    const planPath = vars?.PlanPath;

    expect(typeof planPath).toBe('string');
    // Path-first: the variable projects to a real local path under the run's
    // work dir, not the rd:// URI that identifies the artifact in the manifest.
    expect(planPath).not.toMatch(/^rd:\/\//);
    expect(planPath).toContain('/.rundown/work/');
    expect(planPath).toMatch(/\/plan\.json$/);
  });
});
