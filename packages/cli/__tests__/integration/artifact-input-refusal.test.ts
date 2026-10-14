import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { appendArtifactManifestRecordSync, assertRunId } from '@rundown-org/core';
import {
  createTestWorkspace,
  listRunbookStates,
  parseConcatenatedJson,
  parseJsonEvents,
  requireOwnerToken,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

/**
 * A runbook that asserts an input as an artifact (a naked `ARTIFACTS`
 * declaration, language spec §10.1.2) is given a plain string through
 * `--input`. The supported way to supply an artifact at launch is
 * `--artifacts <name>=<rd:// URI>`; anything else is refused with the typed
 * `ARTIFACT_INPUT_REQUIRED` code, as early as it can be known.
 */

// The shape of the plugin's convert-skill runbook: `SkillPath` is declared in
// `inputs:`, asserted naked at step 2, and projected through `path` there.
const CONVERT_SKILL = `---
inputs:
  - SkillPath
required:
  - SkillPath
---
# Convert Skill

## 1. Invoke the skill
- PASS CONTINUE
- FAIL STOP

Invoke the skill.

## 2. Read the source skill
- ARTIFACTS
  - SkillPath
- PASS COMPLETE
- FAIL STOP

Read the source skill at {{ path SkillPath }}.
`;

describe('artifact-asserted input refusal (integration)', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'convert-skill.runbook.md'), CONVERT_SKILL);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /** Append a manifest row and create its file, returning the row's URI. */
  async function seedArtifact(contextId: string, key: string): Promise<string> {
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
    const file = join(workspace.cwd, '.rundown/work', `.rd-${contextId}`, runId, key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '# skill\n');
    return uri;
  }

  it('rundown run --input SkillPath=<path> is refused ARTIFACT_INPUT_REQUIRED and writes no run', async () => {
    const { stdout, exitCode } = await runCliInProcess(
      ['run', 'convert-skill.runbook.md', '--input', 'SkillPath=some/file.md'],
      workspace,
    );

    expect(exitCode).toBe(1);
    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      kind: 'error',
      command: 'run',
      code: 'ARTIFACT_INPUT_REQUIRED',
      details: { variable: 'SkillPath', step: '2' },
    });
    expect(envelope.error).toContain('--artifacts SkillPath=<rd:// URI>');
    expect(await listRunbookStates(workspace)).toEqual([]);
  });

  it('rundown run --artifacts SkillPath=<rd:// URI> still runs and asserts the artifact at step 2', async () => {
    const uri = await seedArtifact('ctx-src', 'skill.md');

    const started = await runCliInProcess(
      ['run', 'convert-skill.runbook.md', '--artifacts', `SkillPath=${uri}`],
      workspace,
    );
    expect(started.exitCode).toBe(0);
    const token = requireOwnerToken(started.stdout);

    const passed = await runCliInProcess(['pass', '--token', token, '--step', '1'], workspace);
    expect(passed.exitCode).toBe(0);
    const entered = parseConcatenatedJson(passed.stdout).find(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' &&
        value !== null &&
        (value as { type?: unknown }).type === 'step_entered',
    );
    expect(entered).toMatchObject({
      stepName: '2',
      artifacts: { SkillPath: { kind: 'artifact-record', uri } },
    });
    expect(entered?.prompt).toContain('.rundown/work/.rd-ctx-src/');
  });

  it('rundown resolve --input SkillPath=<path> reports the refusal, not an untyped error', async () => {
    const { stdout, exitCode } = await runCliInProcess(
      ['resolve', 'convert-skill.runbook.md', '--input', 'SkillPath=some/file.md'],
      workspace,
    );

    expect(exitCode).toBe(1);
    const report = JSON.parse(stdout) as { valid: boolean; errors: Array<{ message: string }> };
    expect(report.valid).toBe(false);
    expect(report.errors[0]?.message).toContain('--artifacts SkillPath=<rd:// URI>');
  });

  it('a value an earlier step binds is refused at step entry with the same code', async () => {
    await writeFile(
      join(workspace.cwd, 'produced.runbook.md'),
      [
        '# Produced',
        '## 1. Produce a plain path',
        '- OUTPUTS',
        '  - Plan',
        '- PASS CONTINUE',
        '- FAIL STOP',
        '```sh',
        `printf 'plan.json' > "$RD_OUTPUTS_Plan"`,
        '```',
        '',
        '## 2. Assert the plan',
        '- ARTIFACTS',
        '  - Plan',
        '- PASS COMPLETE',
        '- FAIL STOP',
        '',
        'Review the plan.',
        '',
      ].join('\n'),
    );

    const { stdout, exitCode } = await runCliInProcess(
      ['run', '--allow-all', 'produced.runbook.md'],
      workspace,
    );

    expect(exitCode).toBe(1);
    const events = parseJsonEvents(stdout);
    const error = events.find((event) => event.type === 'error_occurred');
    expect(error).toMatchObject({ code: 'ARTIFACT_INPUT_REQUIRED' });
    expect(String(error?.message)).toContain('--artifacts Plan=<rd:// URI>');
    expect(events.find((event) => event.type === 'runbook_stopped')).toMatchObject({
      reason: 'artifact_resolution_failed',
    });
  });

  it('{{ path X }} over a value an earlier step binds is refused at step entry with the same code', async () => {
    await writeFile(
      join(workspace.cwd, 'helper.runbook.md'),
      [
        '# Helper',
        '## 1. Produce a plain path',
        '- OUTPUTS',
        '  - Doc',
        '- PASS CONTINUE',
        '- FAIL STOP',
        '```sh',
        `printf 'notes.md' > "$RD_OUTPUTS_Doc"`,
        '```',
        '',
        '## 2. Read it',
        '- PASS COMPLETE',
        '- FAIL STOP',
        '',
        'Read {{ path Doc }}.',
        '',
      ].join('\n'),
    );

    const { stdout, exitCode } = await runCliInProcess(
      ['run', '--allow-all', 'helper.runbook.md'],
      workspace,
    );

    expect(exitCode).toBe(1);
    const error = parseJsonEvents(stdout).find((event) => event.type === 'error_occurred');
    expect(error).toMatchObject({ code: 'ARTIFACT_INPUT_REQUIRED' });
    expect(String(error?.message)).toContain('--artifacts Doc=<rd:// URI>');
  });
});
