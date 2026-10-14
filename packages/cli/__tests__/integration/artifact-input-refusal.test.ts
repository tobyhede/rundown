import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { appendArtifactManifestRecordSync, assertRunId } from '@rundown-org/core';
import { patchPersistedRunState } from '@rundown-org/core/testing/run-fixtures';
import {
  createTestWorkspace,
  getAllRunbookStates,
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

// A value supplied through env inheritance may be a secret.
const SECRET = 'sk-live-0123456789abcdefSECRET';

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
        `printf '${SECRET}' > "$RD_OUTPUTS_Plan"`,
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
    // A step-entry refusal names the owner's recovery, not a launch flag.
    expect(String(error?.message)).not.toContain('--artifacts');
    expect(String(error?.message)).toContain('The run stops');
    expect(events.find((event) => event.type === 'runbook_stopped')).toMatchObject({
      reason: 'artifact_resolution_failed',
    });
    // The bound value may be a secret: neither the event nor the persisted
    // lastAction echoes it. (The runbook's own command text holds it here,
    // which the runbook author wrote; only the refusal is under test.)
    expect(String(error?.message)).not.toContain(SECRET);
    const states = await getAllRunbookStates(workspace);
    expect(states).toHaveLength(1);
    const lastAction = states[0]?.lastAction;
    expect(lastAction).toMatchObject({ code: 'ARTIFACT_INPUT_REQUIRED' });
    expect(JSON.stringify(lastAction)).not.toContain(SECRET);
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
    // The run keeps its position: recovery is the owner's goto or stop.
    expect(String(error?.message)).not.toContain('--artifacts');
    expect(String(error?.message)).toContain('rundown goto');
    expect(String(error?.message)).toContain('rundown stop');
  });

  it('{{ path X }} inside an ARTIFACTS token stops the run, and its guidance says so (E2)', async () => {
    // A token is rendered while the unit's ARTIFACTS resolve, and a refusal
    // there takes the resolver's stop path. Its guidance must describe that
    // outcome, not the position-keeping one of a prompt render.
    await writeFile(
      join(workspace.cwd, 'token.runbook.md'),
      [
        '# Token',
        '## 1. Produce a plain path',
        '- OUTPUTS',
        '  - Doc',
        '- PASS CONTINUE',
        '- FAIL STOP',
        '```sh',
        `printf 'notes.md' > "$RD_OUTPUTS_Doc"`,
        '```',
        '',
        '## 2. Reference it',
        '- ARTIFACTS',
        '  - Copy "{{ path Doc }}"',
        '- PASS COMPLETE',
        '- FAIL STOP',
        '',
        'Use the copy.',
        '',
      ].join('\n'),
    );

    const { stdout, exitCode } = await runCliInProcess(
      ['run', '--allow-all', 'token.runbook.md'],
      workspace,
    );

    expect(exitCode).toBe(1);
    const events = parseJsonEvents(stdout);
    expect(events.find((event) => event.type === 'runbook_stopped')).toBeDefined();
    const error = events.find((event) => event.type === 'error_occurred');
    expect(error).toMatchObject({ code: 'ARTIFACT_INPUT_REQUIRED' });
    const message = String(error?.message);
    expect(message).toContain('{{ path Doc }} requires an artifact');
    expect(message).toContain('The run stops');
    expect(message).toContain('in the step that sets it');
    expect(message).not.toContain('keeps its position');
    expect(message).not.toContain('rundown goto');
  });

  describe('{{ path X }} over a FOR loop variable judges the iteration value (E1)', () => {
    // The iteration binds the loop variable before its substep is entered, so
    // the value a substep's `{{ path plan }}` judges is the iteration value —
    // never an outer `plan` the loop variable shadows. Only the substep's entry
    // render can see it; a whole-runbook render (launch or reload) must leave
    // the reference for that entry.
    const iterating = [
      '---',
      'inputs:',
      '  - plan',
      '  - plans',
      '---',
      '# Iterating',
      '## 1. Review each plan',
      '- FOR plan IN {{ plans }}',
      '- PASS ALL COMPLETE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 Read',
      '- PASS CONTINUE',
      '- FAIL STOP',
      '',
      'Read {{ path plan }}.',
      '',
    ].join('\n');

    beforeEach(async () => {
      await writeFile(join(workspace.cwd, 'iterating.runbook.md'), iterating);
    });

    function substepRefusal(stdout: string): string {
      const events = parseJsonEvents(stdout);
      // The refused unit is never entered, so no prompt shows the reference.
      expect(events.find((event) => event.type === 'step_entered')).toBeUndefined();
      const error = events.find((event) => event.type === 'error_occurred');
      expect(error).toMatchObject({ code: 'ARTIFACT_INPUT_REQUIRED' });
      return String(error?.message);
    }

    it('a plain iteration value is refused at the substep entry', async () => {
      const { stdout, exitCode } = await runCliInProcess(
        ['run', 'iterating.runbook.md', '--input-json', 'plans=["a.md","b.md"]'],
        workspace,
      );

      expect(exitCode).toBe(1);
      const message = substepRefusal(stdout);
      expect(message).toContain('{{ path plan }} requires an artifact, but "plan"');
      expect(message).toContain('The run keeps its position');
    });

    it('a plain iteration value is refused even when an outer artifact `plan` is shadowed', async () => {
      const uri = await seedArtifact('ctx-src', 'outer.md');

      const { stdout, exitCode } = await runCliInProcess(
        [
          'run',
          'iterating.runbook.md',
          '--artifacts',
          `plan=${uri}`,
          '--input-json',
          'plans=["a.md","b.md"]',
        ],
        workspace,
      );

      // The outer artifact's path must not stand in for the iteration value.
      expect(stdout).not.toContain('outer.md');
      expect(exitCode).toBe(1);
      const message = substepRefusal(stdout);
      expect(message).toContain('{{ path plan }} requires an artifact, but "plan"');
      expect(message).toContain('The run keeps its position');
    });

    it('an artifact iteration value renders even when an outer plain `plan` is shadowed', async () => {
      const first = await seedArtifact('ctx-src', 'plan-a.md');
      const second = await seedArtifact('ctx-src', 'plan-b.md');

      const started = await runCliInProcess(
        [
          'run',
          'iterating.runbook.md',
          '--input',
          'plan=draft',
          '--artifacts-json',
          `plans=${JSON.stringify([first, second])}`,
        ],
        workspace,
      );

      // The outer `plan` never reaches the substep, so launch does not judge it.
      expect(started.stdout).not.toContain('ARTIFACT_INPUT_REQUIRED');
      expect(started.exitCode).toBe(0);
      const entered = parseJsonEvents(started.stdout).find(
        (event) => event.type === 'step_entered',
      );
      expect(entered?.prompt).toMatch(/^Read \S*\.rundown\/work\/\.rd-ctx-src\/\S*\/plan-a\.md\.$/);

      const token = requireOwnerToken(started.stdout);
      const passed = await runCliInProcess(
        ['pass', '--token', token, '--step', '1.1', '--index', '1'],
        workspace,
      );
      expect(passed.stdout).not.toContain('ARTIFACT_INPUT_REQUIRED');
      const next = parseJsonEvents(passed.stdout).find((event) => event.type === 'step_entered');
      expect(next?.prompt).toMatch(/^Read \S*\.rundown\/work\/\.rd-ctx-src\/\S*\/plan-b\.md\.$/);
    });
  });

  it('a launch value a step rebinds stays deferred on every command after launch', async () => {
    // Launch defers `{{ path plan }}` because step 2 rebinds `plan`; the
    // commands that reload the run while step 1 is current must apply the
    // same deferral, or the still-plain launch value is judged before step 2
    // has rebound it.
    await writeFile(
      join(workspace.cwd, 'rebinding.runbook.md'),
      [
        '---',
        'inputs:',
        '  - plan',
        '---',
        '# Rebinding',
        '## 1. Prepare',
        '- PASS CONTINUE',
        '- FAIL STOP',
        '',
        'Prepare.',
        '',
        '## 2. Write the plan',
        '- ARTIFACTS',
        '  - plan "plan.md"',
        '- PASS CONTINUE',
        '- FAIL STOP',
        '',
        'Write the plan.',
        '',
        '## 3. Read the plan',
        '- PASS COMPLETE',
        '- FAIL STOP',
        '',
        'Read {{ path plan }}.',
        '',
      ].join('\n'),
    );

    const started = await runCliInProcess(
      ['run', 'rebinding.runbook.md', '--input', 'plan=draft'],
      workspace,
    );
    expect(started.stdout).not.toContain('ARTIFACT_INPUT_REQUIRED');
    expect(started.exitCode).toBe(0);
    const token = requireOwnerToken(started.stdout);

    const status = await runCliInProcess(['status'], workspace);
    expect(status.stdout).not.toContain('ARTIFACT_INPUT_REQUIRED');
    expect(status.exitCode).toBe(0);

    const first = await runCliInProcess(['pass', '--token', token, '--step', '1'], workspace);
    expect(first.stdout).not.toContain('ARTIFACT_INPUT_REQUIRED');
    expect(first.exitCode).toBe(0);

    const passed = await runCliInProcess(['pass', '--token', token, '--step', '2'], workspace);
    expect(passed.stdout).not.toContain('ARTIFACT_INPUT_REQUIRED');
    expect(passed.exitCode).toBe(0);
    const entered = parseConcatenatedJson(passed.stdout).find(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' &&
        value !== null &&
        (value as { type?: unknown }).type === 'step_entered',
    );
    expect(entered).toMatchObject({ stepName: '3' });
    expect(entered?.prompt).toMatch(/Read \S*\.rundown\/work\/\S*plan\.md\./);
  });

  it('reloading a run never judges {{ path X }}: status and stop work while a later step holds one', async () => {
    // Only the render of the unit being entered judges a `{{ path X }}`. The
    // whole-runbook reload that every command performs reaches steps nobody
    // is entering, so a non-artifact value there must not refuse it — or
    // `status` and `stop`, the commands that recover such a run, cannot run.
    await writeFile(
      join(workspace.cwd, 'later.runbook.md'),
      [
        '# Later',
        '## 1. Prepare',
        '- PASS CONTINUE',
        '- FAIL STOP',
        '',
        'Prepare.',
        '',
        '## 2. Read it',
        '- PASS COMPLETE',
        '- FAIL STOP',
        '',
        'Read {{ path Doc }}.',
        '',
      ].join('\n'),
    );
    const started = await runCliInProcess(['run', 'later.runbook.md'], workspace);
    expect(started.exitCode).toBe(0);
    const token = requireOwnerToken(started.stdout);
    const states = await getAllRunbookStates(workspace);
    expect(states).toHaveLength(1);
    const [state] = states;
    // A value no step of this runbook binds, present when the run reloads
    // (the deferral covers only names a step can rebind).
    await patchPersistedRunState(workspace.cwd, state.id, (current) => ({
      ...current,
      variables: { ...(current.variables as Record<string, unknown>), Doc: 'notes.md' },
    }));

    const status = await runCliInProcess(['status', '--run', state.id], workspace);
    expect(status.stdout).not.toContain('ARTIFACT_INPUT_REQUIRED');
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ step: { name: '1' } });

    const stopped = await runCliInProcess(['stop', '--token', token], workspace);
    expect(stopped.stdout).not.toContain('ARTIFACT_INPUT_REQUIRED');
    expect(parseConcatenatedJson(stopped.stdout)).toContainEqual(
      expect.objectContaining({ kind: 'action', action: 'stop', stopped: true }),
    );
  });

  it('a launch refusal never echoes the value, which may be a secret', async () => {
    const { stdout, exitCode } = await runCliInProcess(
      ['run', 'convert-skill.runbook.md', '--input', `SkillPath=${SECRET}`],
      workspace,
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ code: 'ARTIFACT_INPUT_REQUIRED' });
    expect(stdout).not.toContain(SECRET);
  });

  it('rundown run is not refused when a composed child may rebind the asserted name', async () => {
    await writeFile(
      join(workspace.cwd, 'planner.runbook.md'),
      [
        '---',
        'outputs:',
        '  - plan',
        '---',
        '# Planner',
        '## 1. Plan',
        '- PASS COMPLETE',
        '',
        'Plan.',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(workspace.cwd, 'composing.runbook.md'),
      [
        '---',
        'inputs:',
        '  - plan',
        '---',
        '# Composing',
        '## 1. Plan',
        '- PASS ALL CONTINUE',
        '- FAIL ANY STOP',
        '',
        '- planner.runbook.md',
        '',
        '## 2. Use the plan',
        '- ARTIFACTS',
        '  - plan',
        '- PASS COMPLETE',
        '',
        'Use it.',
        '',
      ].join('\n'),
    );

    const { stdout, exitCode } = await runCliInProcess(
      ['run', 'composing.runbook.md', '--input', 'plan=plan.json'],
      workspace,
    );

    expect(stdout).not.toContain('ARTIFACT_INPUT_REQUIRED');
    expect(exitCode).toBe(0);
  });

  describe('a step-entry refusal of a name no step binds names a new run with --artifacts (B2)', () => {
    // Composing a child defers every name at launch, so a plain launch value
    // reaches step entry although no step of the runbook ever binds it. The
    // only recovery is a new run supplied through the artifact channel.
    const composing = (use: string[]): string =>
      [
        '---',
        'inputs:',
        '  - plan',
        '---',
        '# Composing',
        ...use,
        '## 2. Compose',
        '- PASS ALL COMPLETE',
        '- FAIL ANY STOP',
        '',
        '- planner.runbook.md',
        '',
      ].join('\n');

    beforeEach(async () => {
      await writeFile(
        join(workspace.cwd, 'planner.runbook.md'),
        ['# Planner', '## 1. Plan', '- PASS COMPLETE', '', 'Plan.', ''].join('\n'),
      );
    });

    it('a naked assertion says to start a new run with --artifacts, not to fix a step', async () => {
      await writeFile(
        join(workspace.cwd, 'asserting.runbook.md'),
        composing([
          '## 1. Use the plan',
          '- ARTIFACTS',
          '  - plan',
          '- PASS CONTINUE',
          '- FAIL STOP',
          '',
          'Use it.',
          '',
        ]),
      );

      const { stdout } = await runCliInProcess(
        ['run', 'asserting.runbook.md', '--input', 'plan=./plan.md'],
        workspace,
      );

      const error = parseJsonEvents(stdout).find((event) => event.type === 'error_occurred');
      expect(error).toMatchObject({ code: 'ARTIFACT_INPUT_REQUIRED' });
      const message = String(error?.message);
      expect(message).toContain('The run stops');
      expect(message).toContain('No step of this runbook binds "plan"');
      expect(message).toContain('--artifacts plan=<rd:// URI>');
      expect(message).not.toContain('in the step that sets it');
    });

    it("a FOR step's own assertion on its loop variable judges the launch value, so names a new run (E3)", async () => {
      // ARTIFACTS precede FOR, so the step-level assertion resolves on entry,
      // before any iteration binds `plan`: the value judged is the launch
      // value, which no step rebinds. The loop variable binds only inside the
      // loop's substeps.
      await writeFile(
        join(workspace.cwd, 'looping.runbook.md'),
        [
          '---',
          'inputs:',
          '  - plan',
          '  - plans',
          '---',
          '# Composing',
          '## 1. Review each plan',
          '- ARTIFACTS',
          '  - plan',
          '- FOR plan IN {{ plans }}',
          '- PASS ALL CONTINUE',
          '- FAIL ANY STOP',
          '',
          '### 1.1 Read',
          '- PASS CONTINUE',
          '- FAIL STOP',
          '',
          'Read it.',
          '',
          '## 2. Compose',
          '- PASS ALL COMPLETE',
          '- FAIL ANY STOP',
          '',
          '- planner.runbook.md',
          '',
        ].join('\n'),
      );

      const { stdout } = await runCliInProcess(
        [
          'run',
          'looping.runbook.md',
          '--input',
          'plan=./plan.md',
          '--input-json',
          'plans=["a.md"]',
        ],
        workspace,
      );

      const error = parseJsonEvents(stdout).find((event) => event.type === 'error_occurred');
      expect(error).toMatchObject({ code: 'ARTIFACT_INPUT_REQUIRED' });
      const message = String(error?.message);
      expect(message).toContain('The run stops');
      expect(message).toContain('No step of this runbook binds "plan"');
      expect(message).toContain('--artifacts plan=<rd:// URI>');
      expect(message).not.toContain('in the step that sets it');
    });

    it('a {{ path X }} render says to stop and start a new run with --artifacts, not to goto', async () => {
      await writeFile(
        join(workspace.cwd, 'rendering.runbook.md'),
        composing([
          '## 1. Read the plan',
          '- PASS CONTINUE',
          '- FAIL STOP',
          '',
          'Read {{ path plan }}.',
          '',
        ]),
      );

      const { stdout } = await runCliInProcess(
        ['run', 'rendering.runbook.md', '--input', 'plan=./plan.md'],
        workspace,
      );

      const error = parseJsonEvents(stdout).find((event) => event.type === 'error_occurred');
      expect(error).toMatchObject({ code: 'ARTIFACT_INPUT_REQUIRED' });
      const message = String(error?.message);
      expect(message).toContain('The run keeps its position');
      expect(message).toContain('rundown stop');
      expect(message).toContain('--artifacts plan=<rd:// URI>');
      expect(message).not.toContain('rundown goto');
    });
  });

  it("a child's refusal says the value came from the parent, not a launch flag", async () => {
    await writeFile(
      join(workspace.cwd, 'reader.runbook.md'),
      [
        '---',
        'inputs:',
        '  - Doc',
        '---',
        '# Reader',
        '## 1. Read',
        '- ARTIFACTS',
        '  - Doc',
        '- PASS COMPLETE',
        '',
        'Read it.',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(workspace.cwd, 'parent.runbook.md'),
      [
        '---',
        'inputs:',
        '  - Doc',
        '---',
        '# Parent',
        '## 1. Read through a child',
        '- PASS ALL COMPLETE',
        '- FAIL ANY STOP',
        '',
        '- reader.runbook.md',
        '',
      ].join('\n'),
    );

    const { stdout } = await runCliInProcess(
      ['run', 'parent.runbook.md', '--input', 'Doc=notes.md'],
      workspace,
    );

    expect(stdout).toContain('ARTIFACT_INPUT_REQUIRED');
    const message = parseConcatenatedJson(stdout)
      .map((value) => JSON.stringify(value))
      .find((text) => text.includes('ARTIFACT_INPUT_REQUIRED'));
    expect(message).toBeDefined();
    expect(message).not.toContain('--artifacts');
    expect(message).toContain('parent');
  });
});
