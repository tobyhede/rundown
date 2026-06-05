import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  RunbookStateManager,
  SessionService,
  appendArtifactManifestRecord,
  assertRunId,
  merge,
} from '@rundown-org/core';
import { parseRunbookDocument } from '@rundown-org/parser';
import { brandTrustedArtifactRecordForTest } from '../helpers/brand-helpers.js';
import { createTestWorkspace, runCliInProcess, type TestWorkspace } from '../helpers/test-utils.js';

const RUN_ID = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const CONTEXT_ID = 'ctx1';

describe('artifact command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function seedActiveArtifact(): Promise<string> {
    const markdown = [
      '# Workflow',
      '',
      '## 1. Write plan',
      '- ARTIFACTS',
      '  - PlanPath "plan.json"',
      '- PASS COMPLETE',
      '- FAIL STOP',
      '',
      'Write {{ PlanPath }}',
      '',
    ].join('\n');
    const { runbook } = parseRunbookDocument(markdown, 'workflow.runbook.md');
    const manager = new RunbookStateManager(workspace.cwd);
    const session = new SessionService(manager);
    const state = await manager.create(
      { source: 'project', path: 'workflow.runbook.md' },
      runbook,
      {
        runbookPath: 'workflow.runbook.md',
        runId: RUN_ID,
        templateVars: {
          WorkPath: '.rundown/work',
          ContextId: CONTEXT_ID,
          RunId: RUN_ID,
        },
        frontmatterOutputs: [],
      },
    );
    await session.pushRunbook(state.id);
    const uri = `rd://artifacts/${CONTEXT_ID}/${RUN_ID}/plan.json`;
    await appendArtifactManifestRecord(
      { cwd: workspace.cwd, workPath: '.rundown/work' },
      {
        uri,
        runId: RUN_ID,
        contextId: CONTEXT_ID,
        runbook: { source: 'project', path: 'workflow.runbook.md' },
        key: 'plan.json',
        timestamp: '2026-06-05T00:00:00.000Z',
      },
    );
    await manager.update(state.id, {
      variables: merge({
        PlanPath: brandTrustedArtifactRecordForTest({
          kind: 'artifact-record',
          uri,
          runId: RUN_ID,
          contextId: CONTEXT_ID,
          runbook: { source: 'project', path: 'workflow.runbook.md' },
          key: 'plan.json',
          timestamp: '2026-06-05T00:00:00.000Z',
        }),
      }),
    });
    return uri;
  }

  it('lists active artifact aliases', async () => {
    const uri = await seedActiveArtifact();
    const result = await runCliInProcess(['artifact', 'ls'], workspace);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as Array<{
      alias: string;
      uri: string;
      path: string;
    }>;
    expect(output).toEqual([
      expect.objectContaining({
        alias: 'PlanPath',
        uri,
        path: expect.stringContaining(`.rundown/work/.rd-${CONTEXT_ID}/${RUN_ID}/plan.json`),
      }),
    ]);
  });

  it('inspects an artifact alias as a structured record', async () => {
    const uri = await seedActiveArtifact();
    const result = await runCliInProcess(['artifact', 'inspect', 'PlanPath'], workspace);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        alias: 'PlanPath',
        kind: 'artifact-record',
        uri,
        path: expect.stringContaining('plan.json'),
      }),
    );
  });

  it('projects an alias and uri to full records in JSON path mode', async () => {
    const uri = await seedActiveArtifact();
    const byAlias = await runCliInProcess(['artifact', 'path', 'PlanPath'], workspace);
    const byUri = await runCliInProcess(['artifact', 'path', uri], workspace);

    expect(JSON.parse(byAlias.stdout)).toEqual(
      expect.objectContaining({
        alias: 'PlanPath',
        kind: 'artifact-record',
        uri,
        path: expect.stringContaining('plan.json'),
      }),
    );
    expect(JSON.parse(byUri.stdout)).toEqual(
      expect.objectContaining({
        kind: 'artifact-record',
        uri,
        path: expect.stringContaining('plan.json'),
      }),
    );
  });

  it('projects an alias to a full record in JSON uri mode', async () => {
    const uri = await seedActiveArtifact();
    const result = await runCliInProcess(['artifact', 'uri', 'PlanPath'], workspace);

    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        alias: 'PlanPath',
        kind: 'artifact-record',
        uri,
        path: expect.stringContaining('plan.json'),
      }),
    );
  });

  it('prints only the requested projection in text mode for path and uri', async () => {
    const uri = await seedActiveArtifact();
    const pathResult = await runCliInProcess(['artifact', 'path', 'PlanPath', '--text'], workspace);
    const uriResult = await runCliInProcess(['artifact', 'uri', 'PlanPath', '--text'], workspace);

    expect(pathResult.stdout.trim()).toContain('plan.json');
    expect(pathResult.stdout.trim()).not.toContain('rd://artifacts');
    expect(uriResult.stdout.trim()).toBe(uri);
  });

  it('inspects alias or uri as enriched records', async () => {
    const uri = await seedActiveArtifact();
    const byAlias = await runCliInProcess(['artifact', 'inspect', 'PlanPath'], workspace);
    const byUri = await runCliInProcess(['artifact', 'inspect', uri], workspace);

    expect(JSON.parse(byAlias.stdout)).toEqual(expect.objectContaining({ alias: 'PlanPath', uri }));
    expect(JSON.parse(byUri.stdout)).toEqual(
      expect.objectContaining({ uri, path: expect.any(String) }),
    );
  });
});
