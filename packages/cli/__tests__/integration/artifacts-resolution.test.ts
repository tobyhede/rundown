import { describe, expect, it } from '@jest/globals';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestWorkspace, getAllRunbookStates, runCli } from '../helpers/test-utils.js';

describe('ARTIFACTS resolution integration', () => {
  it('emits file artifact references and renders them through the path helper', async () => {
    const workspace = await createTestWorkspace();
    try {
      await mkdir(join(workspace.cwd, 'schemas'), { recursive: true });
      const schemaPath = join(workspace.cwd, 'schemas', 'review.schema.json');
      await writeFile(schemaPath, '{}');
      const canonicalSchemaPath = await realpath(schemaPath);
      await writeFile(
        join(workspace.cwd, 'schema-reference.runbook.md'),
        `# Schema Reference

## 1. Read schema
- ARTIFACTS
  - ReviewSchemaPath "schemas/review.schema.json"
- PASS COMPLETE

\`\`\`bash
test -f "{{ path ReviewSchemaPath }}"
\`\`\`
`,
      );

      const result = runCli(['run', 'schema-reference.runbook.md', '--prompted'], workspace);

      expect(result.exitCode).toBe(0);
      const entered = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((line) => line.type === 'step_entered');
      expect(entered.artifacts.ReviewSchemaPath).toMatchObject({
        kind: 'file-artifact-record',
        uri: pathToFileURL(canonicalSchemaPath).href,
        key: 'schemas/review.schema.json',
      });
      expect(entered.commandCode).toContain(canonicalSchemaPath);
    } finally {
      await workspace.cleanup();
    }
  });

  it('resolves explicit absolute file references when read policy allows them', async () => {
    const workspace = await createTestWorkspace();
    try {
      const schemaPath = join(workspace.cwd, 'absolute-review.schema.json');
      await writeFile(schemaPath, '{}');
      const canonicalSchemaPath = await realpath(schemaPath);
      await writeFile(
        join(workspace.cwd, 'absolute-schema-reference.runbook.md'),
        `# Absolute Schema Reference

## 1. Read schema
- ARTIFACTS
  - ReviewSchemaPath "${canonicalSchemaPath}"
- PASS COMPLETE

\`\`\`bash
test -f "{{ path ReviewSchemaPath }}"
\`\`\`
`,
      );

      const result = runCli(
        [
          'run',
          'absolute-schema-reference.runbook.md',
          '--prompted',
          '--allow-read',
          canonicalSchemaPath,
        ],
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const entered = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((line) => line.type === 'step_entered');
      expect(entered.artifacts.ReviewSchemaPath).toMatchObject({
        kind: 'file-artifact-record',
        uri: pathToFileURL(canonicalSchemaPath).href,
        key: canonicalSchemaPath,
      });
    } finally {
      await workspace.cleanup();
    }
  });

  it('resolves plugin file references when project files are absent', async () => {
    const workspace = await createTestWorkspace();
    try {
      await mkdir(join(workspace.cwd, 'plugin', 'schemas'), { recursive: true });
      const schemaPath = join(workspace.cwd, 'plugin', 'schemas', 'review.schema.json');
      await writeFile(schemaPath, '{}');
      const canonicalSchemaPath = await realpath(schemaPath);
      await writeFile(
        join(workspace.cwd, 'plugin-schema-reference.runbook.md'),
        `# Plugin Schema Reference

## 1. Read schema
- ARTIFACTS
  - ReviewSchemaPath "schemas/review.schema.json"
- PASS COMPLETE

\`\`\`bash
test -f "{{ path ReviewSchemaPath }}"
\`\`\`
`,
      );

      const result = runCli(['run', 'plugin-schema-reference.runbook.md', '--prompted'], workspace);

      expect(result.exitCode).toBe(0);
      const entered = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((line) => line.type === 'step_entered');
      expect(entered.artifacts.ReviewSchemaPath).toMatchObject({
        kind: 'file-artifact-record',
        uri: pathToFileURL(canonicalSchemaPath).href,
        key: 'schemas/review.schema.json',
      });
    } finally {
      await workspace.cleanup();
    }
  });

  it('emits step_entered.artifacts and renders the resolved artifact variable', async () => {
    const workspace = await createTestWorkspace();
    try {
      await writeFile(
        join(workspace.cwd, 'plan.runbook.md'),
        `# Plan

## 1. Write plan
- ARTIFACTS
  - PlanPath "plan.json"
- PASS COMPLETE

\`\`\`bash
printf '{}' > "{{ PlanPath.uri }}"
\`\`\`
`,
      );

      const result = runCli(['run', 'plan.runbook.md', '--prompted'], workspace);

      expect(result.exitCode).toBe(0);
      const lines = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const entered = lines.find((line) => line.type === 'step_entered');
      expect(entered.artifacts.PlanPath.uri).toMatch(
        /^rd:\/\/artifacts\/[^/]+\/rd_[a-f0-9]{32}\/plan\.json$/,
      );
      expect(entered.commandCode).toContain(entered.artifacts.PlanPath.uri);
    } finally {
      await workspace.cleanup();
    }
  });

  it('renders the resolved artifact URI in --text output', async () => {
    // Issue 11 coverage: the JSON path is exercised above; the text renderer
    // must also surface the resolved URI so an operator running with --text
    // sees the path their shell will read.
    const workspace = await createTestWorkspace();
    try {
      await writeFile(
        join(workspace.cwd, 'plan-text.runbook.md'),
        `# Plan (text)

## 1. Write plan
- ARTIFACTS
  - PlanPath "plan.json"
- PASS COMPLETE

\`\`\`bash
printf '{}' > "{{ PlanPath.uri }}"
\`\`\`
`,
      );

      const result = runCli(['run', 'plan-text.runbook.md', '--prompted', '--text'], workspace);

      expect(result).toMatchObject({ exitCode: 0 });
      // Text output renders the expanded command code; the artifact URI must
      // appear inline.
      expect(result.stdout).toMatch(/rd:\/\/artifacts\/[^/]+\/rd_[a-f0-9]{32}\/plan\.json/);
    } finally {
      await workspace.cleanup();
    }
  });

  it('emits an empty artifacts object for runbooks without ARTIFACTS', async () => {
    const workspace = await createTestWorkspace();
    try {
      await writeFile(
        join(workspace.cwd, 'plain.runbook.md'),
        `# Plain

## 1. No artifacts
- PASS COMPLETE

\`\`\`bash
echo ok
\`\`\`
`,
      );

      const result = runCli(['run', 'plain.runbook.md', '--prompted'], workspace);

      expect(result).toMatchObject({ exitCode: 0 });
      const entered = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((line) => line.type === 'step_entered');
      expect(entered.artifacts).toEqual({});
    } finally {
      await workspace.cleanup();
    }
  });

  it('routes rd goto to a parent substep through parent ARTIFACTS before step_entered', async () => {
    const workspace = await createTestWorkspace();
    try {
      await writeFile(
        join(workspace.cwd, 'parent.runbook.md'),
        `# Parent

## 1. Start
- PASS CONTINUE

## 2. Parent
- ARTIFACTS
  - ParentPath "parent.json"
### 2.1 First
- PASS CONTINUE
### 2.2 Second
- PASS COMPLETE
`,
      );

      const run = runCli(['run', 'parent.runbook.md', '--prompted'], workspace);
      expect(run.exitCode).toBe(0);
      const goto = runCli(['goto', '2.2'], workspace);
      expect(goto.exitCode).toBe(0);
      const entered = goto.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((line) => line.type === 'step_entered');
      expect(entered.artifacts.ParentPath.key).toBe('parent.json');
    } finally {
      await workspace.cleanup();
    }
  });

  it('emits artifact_resolution_failed when ARTIFACTS resolution fails', async () => {
    const workspace = await createTestWorkspace();
    try {
      await writeFile(
        join(workspace.cwd, 'missing-artifact.runbook.md'),
        `# Missing

## 1. Missing artifact
- ARTIFACTS
  - MissingPath
- PASS COMPLETE
`,
      );

      const result = runCli(['run', 'missing-artifact.runbook.md', '--prompted'], workspace);

      expect(result.exitCode).not.toBe(0);
      const stopped = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((line) => line.type === 'runbook_stopped');
      expect(stopped.reason).toBe('artifact_resolution_failed');
      expect(stopped.message).toMatch(/unbound/i);
    } finally {
      await workspace.cleanup();
    }
  });

  it('emits artifact_resolution_failed when a path-like file reference is missing', async () => {
    // Regression: a path-like ARTIFACTS token that does not resolve to any
    // existing file MUST surface as runbook_stopped with
    // `artifact_resolution_failed`, not silently fall through to the managed
    // producer (which would create a manifest row pointing at a non-existent
    // path-like key like "missing/file.json").
    const workspace = await createTestWorkspace();
    try {
      await writeFile(
        join(workspace.cwd, 'missing-file-ref.runbook.md'),
        `# Missing file reference

## 1. Missing file
- ARTIFACTS
  - PlanPath "missing/file.json"
- PASS COMPLETE
`,
      );

      const result = runCli(['run', 'missing-file-ref.runbook.md', '--prompted'], workspace);

      expect(result.exitCode).not.toBe(0);
      const stopped = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((line) => line.type === 'runbook_stopped');
      expect(stopped).toBeDefined();
      expect(stopped.reason).toBe('artifact_resolution_failed');
      expect(stopped.message).toMatch(/file reference|not found/i);
    } finally {
      await workspace.cleanup();
    }
  });

  it('runs a plugin-style write-plan ARTIFACTS declaration through core resolution', async () => {
    const workspace = await createTestWorkspace();
    try {
      await writeFile(
        join(workspace.cwd, 'plugin-write-plan.runbook.md'),
        `---
name: plugin-write-plan
inputs:
  - FeatureName
---
# Write Plan

## 1. Draft plan
- ARTIFACTS
  - PlanPath "implementation-plan.md"
- PASS COMPLETE

\`\`\`bash
printf '# %s\\n' "{{ FeatureName }}" > "{{ PlanPath.uri }}"
\`\`\`
`,
      );

      const result = runCli(
        ['run', 'plugin-write-plan.runbook.md', '--prompted', '--input', 'FeatureName=Artifacts'],
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const events = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const entered = events.find((event) => event.type === 'step_entered');
      expect(entered.artifacts.PlanPath.key).toBe('implementation-plan.md');
      expect(entered.commandCode).toContain(entered.artifacts.PlanPath.uri);
    } finally {
      await workspace.cleanup();
    }
  });

  it('iterates wildcard ARTIFACTS records as a FOR source through the CLI', async () => {
    const workspace = await createTestWorkspace();
    try {
      await writeFile(
        join(workspace.cwd, 'artifact-for-source.runbook.md'),
        `# Artifact FOR source

## 1. Produce plans
- ARTIFACTS
  - PlanA "plan-a.json"
  - PlanB "plan-b.json"
- PASS CONTINUE
- FAIL STOP

\`\`\`bash
printf '{"plan":"a"}' > "{{ path PlanA }}"
printf '{"plan":"b"}' > "{{ path PlanB }}"
\`\`\`

## 2. Iterate plans
- ARTIFACTS
  - Plans "plan-*.json"
- FOR item IN {{ Plans }}
- PASS ALL COMPLETE
- FAIL ANY STOP

### 2.1 Capture artifact key
- OUTPUTS
  - LastArtifactKey
- PASS CONTINUE
- FAIL STOP

\`\`\`bash
printf '{{ item.key }}' > "$RD_OUTPUTS_LastArtifactKey"
\`\`\`
`,
      );

      const result = runCli(
        ['run', 'artifact-for-source.runbook.md', '--allow-all', '--input-json', 'Plans=[]'],
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const states = await getAllRunbookStates(workspace);
      expect(states).toHaveLength(1);
      const state = states[0] as { variables?: Record<string, unknown> };
      expect(state.variables?.Plans).toEqual([
        expect.objectContaining({ kind: 'artifact-record', key: 'plan-a.json' }),
        expect.objectContaining({ kind: 'artifact-record', key: 'plan-b.json' }),
      ]);
      expect(state.variables?.LastArtifactKey).toBe('plan-b.json');
    } finally {
      await workspace.cleanup();
    }
  });
});
