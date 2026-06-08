import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  RunbookStateManager,
  SessionService,
  appendArtifactManifestRecord,
  assertRunId,
  merge,
} from '@rundown-org/core';
import { parseRunbookDocument } from '@rundown-org/parser';
import {
  brandTrustedArtifactArrayForTest,
  brandTrustedArtifactRecordForTest,
} from '../helpers/brand-helpers.js';
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

  /** Seed an active runbook whose `Reviews` alias holds an array of two records. */
  async function seedActiveArrayArtifact(): Promise<readonly string[]> {
    const markdown = ['# Workflow', '', '## 1. Review', '- PASS COMPLETE', '- FAIL STOP', ''].join(
      '\n',
    );
    const { runbook } = parseRunbookDocument(markdown, 'workflow.runbook.md');
    const manager = new RunbookStateManager(workspace.cwd);
    const session = new SessionService(manager);
    const state = await manager.create(
      { source: 'project', path: 'workflow.runbook.md' },
      runbook,
      {
        runbookPath: 'workflow.runbook.md',
        runId: RUN_ID,
        templateVars: { WorkPath: '.rundown/work', ContextId: CONTEXT_ID, RunId: RUN_ID },
        frontmatterOutputs: [],
      },
    );
    await session.pushRunbook(state.id);
    const uris = [
      `rd://artifacts/${CONTEXT_ID}/${RUN_ID}/review-1.json`,
      `rd://artifacts/${CONTEXT_ID}/${RUN_ID}/review-2.json`,
    ];
    await manager.update(state.id, {
      variables: merge({
        Reviews: brandTrustedArtifactArrayForTest(
          uris.map((uri) => ({
            kind: 'artifact-record',
            uri,
            runId: RUN_ID,
            contextId: CONTEXT_ID,
            runbook: { source: 'project', path: 'workflow.runbook.md' },
            key: uri.slice(uri.lastIndexOf('/') + 1),
            timestamp: '2026-06-05T00:00:00.000Z',
          })),
        ),
      }),
    });
    return uris;
  }

  // stale_claim is intentionally not covered here: `resolveCommandTarget` only
  // returns it when a claimId is supplied, and the artifact command never passes
  // one (it calls `resolveCommandTarget(session, { allowStashed: true })`), so the
  // stale_claim branch is unreachable through the CLI.
  describe.each(['ls', 'path', 'uri', 'inspect'])('with no active runbook (%s)', (sub) => {
    it('emits the no-active-runbook warning and exits 0', async () => {
      const args = sub === 'ls' ? ['artifact', 'ls'] : ['artifact', sub, 'PlanPath'];
      const result = await runCliInProcess(args, workspace);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as { kind: string; code: string };
      expect(output).toEqual(
        expect.objectContaining({ kind: 'warning', code: 'NO_ACTIVE_RUNBOOK' }),
      );
    });
  });

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

  describe.each(['path', 'uri', 'inspect'])('unknown alias (%s)', (sub) => {
    it('fails with an alias-not-found error envelope', async () => {
      await seedActiveArtifact();
      const result = await runCliInProcess(['artifact', sub, 'Missing'], workspace);

      expect(result.exitCode).not.toBe(0);
      const error = JSON.parse(result.stderr.trim() || result.stdout.trim()) as {
        kind: string;
        error: string;
      };
      expect(error.kind).toBe('error');
      expect(error.error).toMatch(/Artifact alias not found/i);
    });
  });

  describe.each(['path', 'inspect'])('unknown manifest-backed uri (%s)', (sub) => {
    it('fails with a uri-not-found error envelope', async () => {
      await seedActiveArtifact();
      const result = await runCliInProcess(
        ['artifact', sub, `rd://artifacts/${CONTEXT_ID}/${RUN_ID}/missing.json`],
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      const error = JSON.parse(result.stderr.trim() || result.stdout.trim()) as {
        kind: string;
        error: string;
      };
      expect(error.kind).toBe('error');
      expect(error.error).toMatch(/Artifact URI not found in manifest/i);
    });
  });

  it('lists an array-bound alias with item counts', async () => {
    await seedActiveArrayArtifact();
    const json = await runCliInProcess(['artifact', 'ls'], workspace);
    expect(json.exitCode).toBe(0);
    const rows = JSON.parse(json.stdout) as Array<{ alias: string; items?: unknown[] }>;
    const reviews = rows.find((row) => row.alias === 'Reviews');
    expect(reviews?.items).toHaveLength(2);

    const text = await runCliInProcess(['artifact', 'ls', '--text'], workspace);
    expect(text.stdout).toContain('artifact-array');
    expect(text.stdout).toContain('2 artifacts');
    expect(text.stdout).toContain('2 paths');
  });

  it('ls JSON output carries kind: artifact-array for array-bound aliases', async () => {
    await seedActiveArrayArtifact();
    const result = await runCliInProcess(['artifact', 'ls'], workspace);
    expect(result.exitCode).toBe(0);
    const rows = JSON.parse(result.stdout) as Array<{ alias: string; kind: string }>;
    const reviews = rows.find((row) => row.alias === 'Reviews');
    expect(reviews).toBeDefined();
    expect(reviews?.kind).toBe('artifact-array');
  });

  it('ls JSON output carries kind: artifact-record for scalar aliases', async () => {
    await seedActiveArtifact();
    const result = await runCliInProcess(['artifact', 'ls'], workspace);
    expect(result.exitCode).toBe(0);
    const rows = JSON.parse(result.stdout) as Array<{ alias: string; kind: string }>;
    const planEntry = rows.find((row) => row.alias === 'PlanPath');
    expect(planEntry).toBeDefined();
    expect(planEntry?.kind).toBe('artifact-record');
  });

  it('ls --text KIND column shows artifact-array for array aliases', async () => {
    await seedActiveArrayArtifact();
    const result = await runCliInProcess(['artifact', 'ls', '--text'], workspace);
    expect(result.exitCode).toBe(0);
    // The KIND column should contain 'artifact-array' for the Reviews alias
    expect(result.stdout).toContain('artifact-array');
  });

  it('ls --text KIND column shows artifact-record for scalar aliases', async () => {
    await seedActiveArtifact();
    const result = await runCliInProcess(['artifact', 'ls', '--text'], workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('artifact-record');
  });

  it('path JSON output carries kind: artifact-array for array-bound aliases', async () => {
    await seedActiveArrayArtifact();
    const result = await runCliInProcess(['artifact', 'path', 'Reviews'], workspace);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout) as { kind: string; items?: unknown[] };
    expect(data.kind).toBe('artifact-array');
    expect(data.items).toHaveLength(2);
  });

  it('uri JSON output carries kind: artifact-array for array-bound aliases', async () => {
    await seedActiveArrayArtifact();
    const result = await runCliInProcess(['artifact', 'uri', 'Reviews'], workspace);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout) as { kind: string; items?: unknown[] };
    expect(data.kind).toBe('artifact-array');
  });

  it('inspect JSON output carries kind: artifact-array for array-bound aliases', async () => {
    await seedActiveArrayArtifact();
    const result = await runCliInProcess(['artifact', 'inspect', 'Reviews'], workspace);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout) as { kind: string; items?: unknown[] };
    expect(data.kind).toBe('artifact-array');
  });

  it('projects an array-bound alias to newline-joined paths and uris in text mode', async () => {
    const uris = await seedActiveArrayArtifact();
    const paths = await runCliInProcess(['artifact', 'path', 'Reviews', '--text'], workspace);
    const urisOut = await runCliInProcess(['artifact', 'uri', 'Reviews', '--text'], workspace);

    const pathLines = paths.stdout.trim().split('\n');
    expect(pathLines).toHaveLength(2);
    expect(pathLines[0]).toContain('review-1.json');
    expect(pathLines[1]).toContain('review-2.json');

    const uriLines = urisOut.stdout.trim().split('\n');
    expect(uriLines).toEqual(uris);
  });

  it('lists and inspects in text mode', async () => {
    const uri = await seedActiveArtifact();
    const lsText = await runCliInProcess(['artifact', 'ls', '--text'], workspace);
    expect(lsText.exitCode).toBe(0);
    expect(lsText.stdout).toContain('ALIAS');
    expect(lsText.stdout).toContain('PlanPath');
    expect(lsText.stdout).not.toMatch(/^\s*[[{]/);

    const inspectText = await runCliInProcess(
      ['artifact', 'inspect', 'PlanPath', '--text'],
      workspace,
    );
    expect(inspectText.exitCode).toBe(0);
    expect(inspectText.stdout).toContain('PlanPath');
    expect(inspectText.stdout).toContain(uri);
  });
});
