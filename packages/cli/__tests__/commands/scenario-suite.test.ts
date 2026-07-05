import { createTestWorkspace, runCliInProcess, type TestWorkspace } from '../helpers/test-utils.js';
import { validateCommandOutput } from '../helpers/schema-validator.js';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
// Stryker static-import linkage (mutation testing): links this test file into
// Jest's static inverse-module graph so `--findRelatedTests src/commands/scenario-suite.ts`
// credits the behavioural tests below (which reach the command only via the
// dynamic `import('../cli.js')` seam in runCliInProcess). See collect.test.ts.
import { registerScenarioSuiteCommand } from '../../src/commands/scenario-suite.js';

describe('scenario-suite command wiring', () => {
  it('registers the scenario-suite command with its subcommands and descriptions', () => {
    const program = new Command();
    registerScenarioSuiteCommand(program);

    const suite = program.commands.find((c) => c.name() === 'scenario-suite');
    expect(suite).toBeDefined();
    expect(suite?.description()).toBe('List, show, or run cases from a scenario suite file');

    const byName = new Map(suite!.commands.map((c) => [c.name(), c]));
    expect([...byName.keys()].sort()).toEqual(['ls', 'run', 'show']);
    expect(byName.get('ls')?.description()).toBe('List all cases in a scenario suite');
    expect(byName.get('show')?.description()).toBe('Show details for a specific case in a suite');
    expect(byName.get('run')?.description()).toBe(
      'Execute a case (or all cases with --all) from a suite',
    );

    const runByLong = new Map((byName.get('run')?.options ?? []).map((o) => [o.long, o]));
    expect(runByLong.get('--all')?.description).toBe('Run all cases in the suite');
    expect(runByLong.get('--quiet')?.description).toBe('Suppress command output');
    expect(runByLong.get('--quiet')?.short).toBe('-q');
  });
});

describe('scenario-suite command', () => {
  let workspace: TestWorkspace;

  const RUNBOOK_CONTENT = `---
name: suite-test
---

# Suite Test

## 1. First Step

- PASS CONTINUE
- FAIL STOP

\`\`\`bash
rd echo --result pass
\`\`\`

## 2. Second Step

- PASS COMPLETE
- FAIL STOP

\`\`\`bash
rd echo --result pass
\`\`\`
`;

  const SUITE_YAML = `version: 1
name: Test Suite
description: Suite for testing
tags:
  - test
cases:
  happy-path:
    description: All steps pass
    file: suite-test.runbook.md
    commands:
      - rd run --prompted suite-test.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
    tags:
      - happy
  stop-path:
    description: First step fails and stops
    file: suite-test.runbook.md
    commands:
      - rd run --prompted suite-test.runbook.md
      - rd fail
    result: STOP
  wrong-expectation:
    description: Expects COMPLETE but stops
    file: suite-test.runbook.md
    commands:
      - rd run --prompted suite-test.runbook.md
      - rd fail
    result: COMPLETE
`;

  const EXPECT_SUITE_YAML = `version: 1
name: Expect Suite
cases:
  with-expect:
    file: suite-test.runbook.md
    commands:
      - rd run --prompted suite-test.runbook.md
      - rd pass
      - rd pass
    expect:
      result: COMPLETE
`;

  const ARTIFACT_RUNBOOK_CONTENT = `---
name: artifact-suite-test
---

# Artifact Suite Test

## 1. Produce
- ARTIFACTS
  - PlanPath "plan.json"
- PASS COMPLETE

\`\`\`bash
printf '{"ok":true}' > "{{ path PlanPath }}"
\`\`\`
`;

  const STATIC_ARTIFACT_RUNBOOK_CONTENT = `---
name: static-artifact-suite-test
---

# Static Artifact Suite Test

## 1. Consume
- ARTIFACTS
  - Schema "schemas/review.schema.json"
- PASS COMPLETE
- FAIL STOP

\`\`\`bash
schema_path="{{ path Schema }}"
case "$schema_path" in "$PWD"/*) ;; *) echo "schema escaped workspace: $schema_path" >&2; exit 1 ;; esac
schema="$(cat "$schema_path")"
case "$schema" in root-schema|nested-schema) ;; *) echo "unexpected schema: $schema" >&2; exit 1 ;; esac
printf 'schema=%s\\n' "$schema"
\`\`\`
`;

  const INPUT_FILE_RUNBOOK_CONTENT = `---
name: input-file-suite-test
---

# Input File Suite Test

## 1. Iterate
- FOR item IN {{ items }}
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Echo item
- PASS CONTINUE
- FAIL STOP

\`\`\`bash
rd echo "item={{ item }}"
\`\`\`
`;

  const INPUT_FILE_EXPECT_SUITE_RUNBOOK_CONTENT = `---
name: input-file-expect-suite-test
---

# Input File Suite Preference Test

## 1. Iterate
- FOR item IN {{ items }}
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Assert suite item
- PASS CONTINUE
- FAIL STOP

\`\`\`bash
rd echo --result {{ item }}
\`\`\`
`;

  beforeEach(async () => {
    workspace = await createTestWorkspace();

    // Write runbook to workspace root (suite resolves file: paths relative to suite dir)
    await writeFile(join(workspace.cwd, 'suite-test.runbook.md'), RUNBOOK_CONTENT);
    await writeFile(
      join(workspace.cwd, 'artifact-suite-test.runbook.md'),
      ARTIFACT_RUNBOOK_CONTENT,
    );
    await writeFile(
      join(workspace.cwd, 'input-file-suite-test.runbook.md'),
      INPUT_FILE_RUNBOOK_CONTENT,
    );

    // Write suite files in workspace root
    await writeFile(join(workspace.cwd, 'test.scenario-suite.yaml'), SUITE_YAML);
    await writeFile(join(workspace.cwd, 'expect.scenario-suite.yaml'), EXPECT_SUITE_YAML);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('ls subcommand', () => {
    it('lists cases with table headers', async () => {
      const result = await runCliInProcess(
        'scenario-suite ls test.scenario-suite.yaml --text',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('NAME');
      expect(result.stdout).toContain('FILE');
      expect(result.stdout).toContain('EXPECTED');
      expect(result.stdout).toContain('DESCRIPTION');
      expect(result.stdout).toContain('TAGS');
      expect(result.stdout).toContain('happy-path');
      expect(result.stdout).toContain('stop-path');
      expect(result.stdout).toContain('wrong-expectation');
      expect(result.stdout).toContain('COMPLETE');
      expect(result.stdout).toContain('STOP');
      expect(result.stdout).toMatch(/NAME\s{2,}FILE\s{2,}EXPECTED/);
    });

    it('outputs JSON by default', async () => {
      const result = await runCliInProcess('scenario-suite ls test.scenario-suite.yaml', workspace);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(3);
      expect(parsed.map((item: { name: string }) => item.name)).toEqual(
        expect.arrayContaining(['happy-path', 'stop-path', 'wrong-expectation']),
      );
      expect(validateCommandOutput('scenario-suite ls', parsed)).toEqual({
        valid: true,
        errors: [],
      });
    });

    it('shows VALIDATION_ERROR for invalid suite file', async () => {
      await writeFile(join(workspace.cwd, 'bad.scenario-suite.yaml'), 'version: 99\nname: Bad\n');

      const result = await runCliInProcess(
        'scenario-suite ls bad.scenario-suite.yaml --text',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('VALIDATION_ERROR');
    });

    it('shows error for missing file', async () => {
      const result = await runCliInProcess('scenario-suite ls nonexistent.yaml --text', workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
    });

    it('shows expect.result when result is omitted', async () => {
      const result = await runCliInProcess(
        'scenario-suite ls expect.scenario-suite.yaml --text',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('with-expect');
      expect(result.stdout).toContain('COMPLETE');
    });
  });

  describe('show subcommand', () => {
    it('shows case details', async () => {
      const result = await runCliInProcess(
        'scenario-suite show test.scenario-suite.yaml happy-path',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('happy-path');
      expect(result.stdout).toContain('COMPLETE');
      expect(result.stdout).toContain('suite-test.runbook.md');
    });

    it('outputs JSON by default', async () => {
      const result = await runCliInProcess(
        'scenario-suite show test.scenario-suite.yaml happy-path',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.name).toBe('happy-path');
      expect(parsed.expected).toBe('COMPLETE');
      expect(parsed.commands).toHaveLength(3);
      // tags must be a comma-joined string (matching `ls`), not a raw array.
      expect(parsed.tags).toBe('happy');
      expect(validateCommandOutput('scenario-suite show', parsed)).toEqual({
        valid: true,
        errors: [],
      });
    });

    it('includes expect block when present', async () => {
      const result = await runCliInProcess(
        'scenario-suite show expect.scenario-suite.yaml with-expect',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.expect).toBeDefined();
      expect(parsed.expect.result).toBe('COMPLETE');
    });

    it('shows SCENARIO_NOT_FOUND for non-existent case', async () => {
      const result = await runCliInProcess(
        'scenario-suite show test.scenario-suite.yaml nonexistent',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      // Error is emitted as JSON to stdout (JSON is the default output mode)
      expect(result.stdout + result.stderr).toContain('SCENARIO_NOT_FOUND');
    });
  });

  describe('run subcommand', () => {
    it('runs single passing case successfully', async () => {
      const result = await runCliInProcess(
        'scenario-suite run test.scenario-suite.yaml happy-path',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.result).toBe(true);
      expect(parsed.expected).toBe('COMPLETE');
      expect(parsed.actual).toBe('COMPLETE');
      expect(validateCommandOutput('scenario-suite run', parsed)).toEqual({
        valid: true,
        errors: [],
      });
    }, 30000);

    it('runs case where actual differs from expected with exit code 1', async () => {
      const result = await runCliInProcess(
        'scenario-suite run test.scenario-suite.yaml wrong-expectation',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.result).toBe(false);
      expect(parsed.expected).toBe('COMPLETE');
      expect(parsed.actual).toBe('STOP');
    }, 30000);

    it('outputs JSON for single case by default', async () => {
      const result = await runCliInProcess(
        'scenario-suite run test.scenario-suite.yaml happy-path',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const jsonLines = result.stdout.trim().split(/\n(?=\{)/);
      const parsed = JSON.parse(jsonLines[0]);
      expect(parsed.result).toBe(true);
      expect(parsed.scenario).toBe('happy-path');
      expect(parsed.expected).toBe('COMPLETE');
      expect(parsed.actual).toBe('COMPLETE');
    }, 30000);

    it('runs case with artifact assertions', async () => {
      const suiteWithArtifact = `version: 1
name: Artifact Suite
cases:
  artifact-produced:
    file: artifact-suite-test.runbook.md
    commands:
      - rd run artifact-suite-test.runbook.md --allow-all
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"
          alias: PlanPath
          key: plan.json
          runbook: artifact-suite-test.runbook.md
          exists: true
`;
      await writeFile(join(workspace.cwd, 'artifact.scenario-suite.yaml'), suiteWithArtifact);

      const result = await runCliInProcess(
        'scenario-suite run artifact.scenario-suite.yaml artifact-produced',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.result).toBe(true);
      expect(parsed.artifactAssertions).toEqual([
        expect.objectContaining({
          matched: true,
          assertion: expect.objectContaining({ alias: 'PlanPath', exists: true }),
        }),
      ]);
    }, 30000);

    it('scopes unqualified suite step assertions to the suite case runbook path', async () => {
      await mkdir(join(workspace.cwd, 'nested'), { recursive: true });
      await writeFile(
        join(workspace.cwd, 'nested', 'suite-target.runbook.md'),
        `---
name: suite-target
---

# Suite Target

## 1. Root Step
- PASS COMPLETE
`,
      );
      await writeFile(
        join(workspace.cwd, 'child.runbook.md'),
        `---
name: child
---

# Child

## 1. Child Step
- PASS COMPLETE

\`\`\`bash
rd echo --result pass
\`\`\`
`,
      );
      const suiteWithChildAssertion = `version: 1
name: Scoped Step Suite
cases:
  child-only:
    file: nested/suite-target.runbook.md
    commands:
      - rd run child.runbook.md
    expect:
      result: COMPLETE
      steps:
        - from: "1"
          action: COMPLETE
          result: PASS
`;
      await writeFile(
        join(workspace.cwd, 'scoped-step.scenario-suite.yaml'),
        suiteWithChildAssertion,
      );

      const result = await runCliInProcess(
        'scenario-suite run scoped-step.scenario-suite.yaml child-only',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.result).toBe(false);
      expect(parsed.stepAssertions).toEqual([
        expect.objectContaining({
          matched: false,
          assertion: expect.objectContaining({ from: '1', action: 'COMPLETE' }),
        }),
      ]);
    }, 30000);

    it('runs error-only case with expect.errors', async () => {
      const suiteWithErrorAssertion = `version: 1
name: Error Assertion Suite
cases:
  missing-token:
    file: suite-test.runbook.md
    commands:
      - "! rd claim rdtk_ABCDABCDABCDABCDABCDABCDABCDABCD"
    expect:
      errors:
        - code: TOKEN_NOT_FOUND
          command: claim
`;
      await writeFile(
        join(workspace.cwd, 'error-assertion.scenario-suite.yaml'),
        suiteWithErrorAssertion,
      );

      const result = await runCliInProcess(
        'scenario-suite run error-assertion.scenario-suite.yaml missing-token',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.result).toBe(true);
      expect(parsed.expected).toBe('UNKNOWN');
      expect(parsed.errorAssertions).toEqual([
        expect.objectContaining({
          matched: true,
          assertion: expect.objectContaining({ code: 'TOKEN_NOT_FOUND', command: 'claim' }),
        }),
      ]);
    }, 30000);

    it('fails suite case when command sequence emits an unasserted warning', async () => {
      const suiteWithUnassertedWarning = `version: 1
name: Warning Suite
cases:
  trailing-pass:
    file: suite-test.runbook.md
    commands:
      - rd run suite-test.runbook.md
      - rd pass
    result: COMPLETE
`;
      await writeFile(
        join(workspace.cwd, 'unasserted-warning.scenario-suite.yaml'),
        suiteWithUnassertedWarning,
      );

      const result = await runCliInProcess(
        'scenario-suite run unasserted-warning.scenario-suite.yaml trailing-pass',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.result).toBe(false);
      expect(parsed.unassertedWarnings).toEqual([
        { code: 'NO_ACTIVE_RUNBOOK', command: 'pass', message: 'No active runbook' },
      ]);
    }, 30000);

    it('prints matched warning assertions in text mode', async () => {
      const suiteWithWarningAssertion = `version: 1
name: Warning Assertion Suite
cases:
  no-active-runbook:
    file: suite-test.runbook.md
    commands:
      - rd pass
    expect:
      warnings:
        - code: NO_ACTIVE_RUNBOOK
          command: pass
`;
      await writeFile(
        join(workspace.cwd, 'warning-assertion.scenario-suite.yaml'),
        suiteWithWarningAssertion,
      );

      const result = await runCliInProcess(
        'scenario-suite run warning-assertion.scenario-suite.yaml no-active-runbook --text',
        workspace,
        { env: { RUNDOWN_SCENARIO_IN_PROCESS: '1' } },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Warning Assertions:');
      expect(result.stdout).toContain('warning code=NO_ACTIVE_RUNBOOK command=pass: matched');
    }, 30000);

    it('prints unasserted warnings in text mode', async () => {
      const suiteWithUnassertedWarning = `version: 1
name: Unasserted Warning Text Suite
cases:
  no-active-runbook:
    file: suite-test.runbook.md
    commands:
      - rd pass
    result: COMPLETE
`;
      await writeFile(
        join(workspace.cwd, 'unasserted-warning-text.scenario-suite.yaml'),
        suiteWithUnassertedWarning,
      );

      const result = await runCliInProcess(
        'scenario-suite run unasserted-warning-text.scenario-suite.yaml no-active-runbook --text',
        workspace,
        { env: { RUNDOWN_SCENARIO_IN_PROCESS: '1' } },
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Unasserted Warnings:');
      expect(result.stdout).toContain(
        'unasserted warning code=NO_ACTIVE_RUNBOOK command=pass message=No active runbook',
      );
    }, 30000);

    it('includes warning assertions in run --all case results', async () => {
      const suiteWithWarningAssertion = `version: 1
name: Warning Assertion All Suite
cases:
  no-active-runbook:
    file: suite-test.runbook.md
    commands:
      - rd pass
    expect:
      warnings:
        - code: NO_ACTIVE_RUNBOOK
          command: pass
`;
      await writeFile(
        join(workspace.cwd, 'warning-assertion-all.scenario-suite.yaml'),
        suiteWithWarningAssertion,
      );

      const result = await runCliInProcess(
        'scenario-suite run warning-assertion-all.scenario-suite.yaml --all',
        workspace,
        { env: { RUNDOWN_SCENARIO_IN_PROCESS: '1' } },
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      // Aggregate (`--all`) arm of the scenario-suite run output union.
      expect(parsed.kind).toBe('scenario_suite_run');
      expect(validateCommandOutput('scenario-suite run', parsed)).toEqual({
        valid: true,
        errors: [],
      });
      expect(parsed.cases).toHaveLength(1);
      expect(parsed.cases[0].warningAssertions).toEqual([
        expect.objectContaining({
          matched: true,
          assertion: expect.objectContaining({ code: 'NO_ACTIVE_RUNBOOK', command: 'pass' }),
          matchedWarning: expect.objectContaining({
            code: 'NO_ACTIVE_RUNBOOK',
            command: 'pass',
          }),
        }),
      ]);
    }, 30000);

    it('includes artifact assertions in run --all case results', async () => {
      const suiteWithArtifact = `version: 1
name: Artifact Suite
cases:
  artifact-produced:
    file: artifact-suite-test.runbook.md
    commands:
      - rd run artifact-suite-test.runbook.md --allow-all
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"
          alias: PlanPath
          key: plan.json
          runbook: artifact-suite-test.runbook.md
          exists: true
`;
      await writeFile(join(workspace.cwd, 'artifact-all.scenario-suite.yaml'), suiteWithArtifact);

      const result = await runCliInProcess(
        'scenario-suite run artifact-all.scenario-suite.yaml --all',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.cases).toHaveLength(1);
      expect(parsed.cases[0].artifactAssertions).toEqual([
        expect.objectContaining({
          matched: true,
          assertion: expect.objectContaining({ alias: 'PlanPath', exists: true }),
        }),
      ]);
    }, 30000);

    it('copies static relative ARTIFACTS fixtures into the suite workspace', async () => {
      await mkdir(join(workspace.cwd, 'schemas'), { recursive: true });
      await writeFile(join(workspace.cwd, 'schemas', 'review.schema.json'), 'root-schema');
      await writeFile(
        join(workspace.cwd, 'static-artifact-suite-test.runbook.md'),
        STATIC_ARTIFACT_RUNBOOK_CONTENT,
      );
      const suiteWithStaticArtifact = `version: 1
name: Static Artifact Suite
cases:
  static-artifact:
    file: static-artifact-suite-test.runbook.md
    commands:
      - rd run --allow-all static-artifact-suite-test.runbook.md
    result: COMPLETE
`;
      await writeFile(
        join(workspace.cwd, 'static-artifact.scenario-suite.yaml'),
        suiteWithStaticArtifact,
      );

      const result = await runCliInProcess(
        'scenario-suite run static-artifact.scenario-suite.yaml static-artifact --text',
        workspace,
      );

      if (result.exitCode !== 0) {
        throw new Error(result.stdout + result.stderr);
      }
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('schema=root-schema');
      expect(result.stderr).toContain('schema=root-schema');
    }, 30000);

    it('reports missing static relative ARTIFACTS fixtures before execution', async () => {
      await writeFile(
        join(workspace.cwd, 'static-artifact-suite-test.runbook.md'),
        STATIC_ARTIFACT_RUNBOOK_CONTENT,
      );
      const suiteWithMissingArtifact = `version: 1
name: Missing Static Artifact Suite
cases:
  missing-static-artifact:
    file: static-artifact-suite-test.runbook.md
    commands:
      - rd run --allow-all static-artifact-suite-test.runbook.md
    result: COMPLETE
`;
      await writeFile(
        join(workspace.cwd, 'missing-static-artifact.scenario-suite.yaml'),
        suiteWithMissingArtifact,
      );

      const result = await runCliInProcess(
        'scenario-suite run missing-static-artifact.scenario-suite.yaml missing-static-artifact',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.result).toBe(false);
      expect(parsed.actual).toContain('CHILD_ARTIFACT_NOT_FOUND: schemas/review.schema.json');
    }, 30000);

    it('copies nested runbook ARTIFACTS fixtures from the runbook directory', async () => {
      await mkdir(join(workspace.cwd, 'nested', 'schemas'), { recursive: true });
      await writeFile(
        join(workspace.cwd, 'nested', 'schemas', 'review.schema.json'),
        'nested-schema',
      );
      await mkdir(join(workspace.cwd, 'schemas'), { recursive: true });
      await writeFile(join(workspace.cwd, 'schemas', 'review.schema.json'), 'root-schema');
      await writeFile(
        join(workspace.cwd, 'nested', 'static-artifact-suite-test.runbook.md'),
        STATIC_ARTIFACT_RUNBOOK_CONTENT,
      );
      const suiteWithNestedStaticArtifact = `version: 1
name: Nested Static Artifact Suite
cases:
  nested-static-artifact:
    file: nested/static-artifact-suite-test.runbook.md
    commands:
      - rd run --allow-all static-artifact-suite-test.runbook.md
    result: COMPLETE
`;
      await writeFile(
        join(workspace.cwd, 'nested-static-artifact.scenario-suite.yaml'),
        suiteWithNestedStaticArtifact,
      );

      const result = await runCliInProcess(
        'scenario-suite run nested-static-artifact.scenario-suite.yaml nested-static-artifact --text',
        workspace,
      );

      if (result.exitCode !== 0) {
        throw new Error(result.stdout + result.stderr);
      }
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('schema=nested-schema');
      expect(result.stderr).toContain('schema=nested-schema');
      expect(result.stdout).not.toContain('schema=root-schema');
    }, 30000);

    it('rejects suite runbook files whose source symlink escapes the suite root', async () => {
      const outsideDir = await mkdtemp(join(tmpdir(), 'rd-suite-runbook-escape-'));
      try {
        await writeFile(join(outsideDir, 'escaped.runbook.md'), RUNBOOK_CONTENT);
        await symlink(
          join(outsideDir, 'escaped.runbook.md'),
          join(workspace.cwd, 'escaped.runbook.md'),
        );
        const suiteWithSymlinkRunbook = `version: 1
name: Symlink Runbook Suite
cases:
  symlink-runbook:
    file: escaped.runbook.md
    commands:
      - rd run --prompted escaped.runbook.md
    result: COMPLETE
`;
        await writeFile(
          join(workspace.cwd, 'symlink-runbook.scenario-suite.yaml'),
          suiteWithSymlinkRunbook,
        );

        const result = await runCliInProcess(
          'scenario-suite run symlink-runbook.scenario-suite.yaml symlink-runbook',
          workspace,
        );

        expect(result.exitCode).toBe(1);
        const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
        expect(parsed.result).toBe(false);
        expect(parsed.actual).toContain('Runbook source escapes source root: escaped.runbook.md');
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    }, 30000);

    it('rejects static relative ARTIFACTS fixtures whose source symlink escapes the source root', async () => {
      const outsideDir = await mkdtemp(join(tmpdir(), 'rd-suite-artifact-escape-'));
      try {
        await writeFile(join(outsideDir, 'review.schema.json'), '{"type":"object"}\n');
        await mkdir(join(workspace.cwd, 'schemas'), { recursive: true });
        await symlink(
          join(outsideDir, 'review.schema.json'),
          join(workspace.cwd, 'schemas', 'review.schema.json'),
        );
        await writeFile(
          join(workspace.cwd, 'static-artifact-suite-test.runbook.md'),
          STATIC_ARTIFACT_RUNBOOK_CONTENT,
        );
        const suiteWithSymlinkArtifact = `version: 1
name: Symlink Static Artifact Suite
cases:
  symlink-static-artifact:
    file: static-artifact-suite-test.runbook.md
    commands:
      - rd run --allow-all static-artifact-suite-test.runbook.md
    result: COMPLETE
`;
        await writeFile(
          join(workspace.cwd, 'symlink-static-artifact.scenario-suite.yaml'),
          suiteWithSymlinkArtifact,
        );

        const result = await runCliInProcess(
          'scenario-suite run symlink-static-artifact.scenario-suite.yaml symlink-static-artifact',
          workspace,
        );

        expect(result.exitCode).toBe(1);
        const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
        expect(parsed.result).toBe(false);
        expect(parsed.actual).toContain(
          'Artifact source escapes source root: schemas/review.schema.json',
        );
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    }, 30000);

    it('copies --input-file data directories into the suite workspace', async () => {
      await mkdir(join(workspace.cwd, 'data'), { recursive: true });
      await writeFile(join(workspace.cwd, 'data', 'items.jsonl'), '"alpha"\n"beta"\n');
      await writeFile(
        join(workspace.cwd, 'data', 'sources.yaml'),
        'items: file:data/items.jsonl\n',
      );
      const suiteWithInputFile = `version: 1
name: Input File Suite
cases:
  input-file-source:
    file: input-file-suite-test.runbook.md
    commands:
      - rd run --allow-all --input-file data/sources.yaml input-file-suite-test.runbook.md
    result: COMPLETE
`;
      await writeFile(join(workspace.cwd, 'input-file.scenario-suite.yaml'), suiteWithInputFile);

      const result = await runCliInProcess(
        'scenario-suite run input-file.scenario-suite.yaml input-file-source',
        workspace,
      );

      if (result.exitCode !== 0) {
        throw new Error(result.stdout + result.stderr);
      }
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.result).toBe(true);
      expect(parsed.actual).toBe('COMPLETE');
    }, 30000);

    it('rejects root-level --input-file paths in suite cases', async () => {
      await writeFile(join(workspace.cwd, 'items.jsonl'), '"alpha"\n');
      await writeFile(join(workspace.cwd, 'sources.yaml'), 'items: file:items.jsonl\n');
      const suiteWithRootInputFile = `version: 1
name: Root Input File Suite
cases:
  root-input-file:
    file: input-file-suite-test.runbook.md
    commands:
      - rd run --allow-all --input-file sources.yaml input-file-suite-test.runbook.md
    result: COMPLETE
`;
      await writeFile(
        join(workspace.cwd, 'root-input-file.scenario-suite.yaml'),
        suiteWithRootInputFile,
      );

      const result = await runCliInProcess(
        'scenario-suite run root-input-file.scenario-suite.yaml root-input-file',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.result).toBe(false);
      expect(parsed.actual).toContain('Root-level input-file paths are not allowed');
    }, 30000);

    it('rejects normalized root-level --input-file paths in suite cases', async () => {
      await mkdir(join(workspace.cwd, 'a'), { recursive: true });
      await writeFile(join(workspace.cwd, 'items.jsonl'), '"alpha"\n');
      await writeFile(join(workspace.cwd, 'sources.yaml'), 'items: file:items.jsonl\n');
      const suiteWithNormalizedRootInputFile = `version: 1
name: Normalized Root Input File Suite
cases:
  root-input-file:
    file: input-file-suite-test.runbook.md
    commands:
      - rd run --allow-all --input-file a/../sources.yaml input-file-suite-test.runbook.md
    result: COMPLETE
`;
      await writeFile(
        join(workspace.cwd, 'normalized-root-input-file.scenario-suite.yaml'),
        suiteWithNormalizedRootInputFile,
      );

      const result = await runCliInProcess(
        'scenario-suite run normalized-root-input-file.scenario-suite.yaml root-input-file',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.result).toBe(false);
      expect(parsed.actual).toContain('Root-level input-file paths are not allowed');
    }, 30000);

    it('resolves --input-file data directories relative to the suite when runbook is nested', async () => {
      await mkdir(join(workspace.cwd, 'data'), { recursive: true });
      await mkdir(join(workspace.cwd, 'nested'), { recursive: true });
      await writeFile(join(workspace.cwd, 'data', 'items.jsonl'), '"alpha"\n"beta"\n');
      await writeFile(
        join(workspace.cwd, 'data', 'sources.yaml'),
        'items: file:data/items.jsonl\n',
      );
      await writeFile(
        join(workspace.cwd, 'nested', 'input-file-suite-test.runbook.md'),
        INPUT_FILE_RUNBOOK_CONTENT,
      );
      const suiteWithNestedRunbook = `version: 1
name: Nested Input File Suite
cases:
  input-file-source:
    file: nested/input-file-suite-test.runbook.md
    commands:
      - rd run --allow-all --input-file data/sources.yaml input-file-suite-test.runbook.md
    result: COMPLETE
`;
      await writeFile(
        join(workspace.cwd, 'nested-input-file.scenario-suite.yaml'),
        suiteWithNestedRunbook,
      );

      const result = await runCliInProcess(
        'scenario-suite run nested-input-file.scenario-suite.yaml input-file-source',
        workspace,
      );

      if (result.exitCode !== 0) {
        throw new Error(result.stdout + result.stderr);
      }
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.result).toBe(true);
      expect(parsed.actual).toBe('COMPLETE');
    }, 30000);

    it('prefers suite-relative --input-file data over same-named runbook-relative data', async () => {
      await mkdir(join(workspace.cwd, 'data'), { recursive: true });
      await mkdir(join(workspace.cwd, 'nested', 'data'), { recursive: true });
      await writeFile(join(workspace.cwd, 'data', 'items.jsonl'), '"pass"\n');
      await writeFile(
        join(workspace.cwd, 'data', 'sources.yaml'),
        'items: file:data/items.jsonl\n',
      );
      await writeFile(join(workspace.cwd, 'nested', 'data', 'items.jsonl'), '"fail"\n');
      await writeFile(
        join(workspace.cwd, 'nested', 'data', 'sources.yaml'),
        'items: file:data/items.jsonl\n',
      );
      await writeFile(
        join(workspace.cwd, 'nested', 'input-file-expect-suite-test.runbook.md'),
        INPUT_FILE_EXPECT_SUITE_RUNBOOK_CONTENT,
      );
      const suiteWithShadowedInput = `version: 1
name: Shadowed Input File Suite
cases:
  input-file-source:
    file: nested/input-file-expect-suite-test.runbook.md
    commands:
      - rd run --allow-all --input-file data/sources.yaml nested/input-file-expect-suite-test.runbook.md
    result: COMPLETE
`;
      await writeFile(
        join(workspace.cwd, 'shadowed-input-file.scenario-suite.yaml'),
        suiteWithShadowedInput,
      );

      const result = await runCliInProcess(
        'scenario-suite run shadowed-input-file.scenario-suite.yaml input-file-source',
        workspace,
      );

      if (result.exitCode !== 0) {
        throw new Error(result.stdout + result.stderr);
      }
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.result).toBe(true);
      expect(parsed.actual).toBe('COMPLETE');
    }, 30000);

    it('rejects --input-file data directories that escape the suite root through symlinks', async () => {
      const outsideDir = await mkdtemp(join(tmpdir(), 'rd-suite-input-escape-'));
      try {
        await writeFile(join(outsideDir, 'items.jsonl'), '"escaped"\n');
        await writeFile(join(outsideDir, 'sources.yaml'), 'items: file:data/items.jsonl\n');
        await symlink(outsideDir, join(workspace.cwd, 'data'));
        const suiteWithSymlinkInput = `version: 1
name: Symlink Input File Suite
cases:
  input-file-source:
    file: input-file-suite-test.runbook.md
    commands:
      - rd run --allow-all --input-file data/sources.yaml input-file-suite-test.runbook.md
    result: COMPLETE
`;
        await writeFile(
          join(workspace.cwd, 'symlink-input-file.scenario-suite.yaml'),
          suiteWithSymlinkInput,
        );

        const result = await runCliInProcess(
          'scenario-suite run symlink-input-file.scenario-suite.yaml input-file-source',
          workspace,
        );

        expect(result.exitCode).toBe(1);
        const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
        expect(parsed.result).toBe(false);
        expect(parsed.actual).toContain('Input-file source escapes source root: data');
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    }, 30000);

    it('runs all cases with --all and verifies results', async () => {
      const result = await runCliInProcess(
        'scenario-suite run test.scenario-suite.yaml --all',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.passed).toBe(2);
      expect(parsed.failed).toBe(1);
      const failedCase = parsed.cases.find((c: { result: boolean }) => !c.result);
      expect(failedCase.scenario).toBe('wrong-expectation');
      expect(failedCase.expected).toBe('COMPLETE');
      expect(failedCase.actual).toBe('STOP');
    }, 60000);

    it('outputs summary JSON with --all', async () => {
      const result = await runCliInProcess(
        'scenario-suite run test.scenario-suite.yaml --all',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const jsonLines = result.stdout.trim().split(/\n(?=\{)/);
      const parsed = JSON.parse(jsonLines[0]);
      expect(parsed.total).toBe(3);
      expect(parsed.passed).toBe(2);
      expect(parsed.failed).toBe(1);
      expect(parsed.cases).toHaveLength(3);
    }, 60000);

    it('emits case timings to stderr when enabled', async () => {
      const result = await runCliInProcess(
        'scenario-suite run test.scenario-suite.yaml --all',
        workspace,
        { env: { RUNDOWN_SCENARIO_COMMAND_TIMINGS: '1' } },
      );

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.total).toBe(3);
      expect(result.stderr).toContain('SCENARIO_TIMING');
      expect(result.stderr).toContain('"scope":"case"');
      expect(result.stderr).toContain('"case":"happy-path"');
      expect(result.stderr).toContain('"scope":"command"');
    }, 60000);

    it('runs suite case commands in-process when enabled', async () => {
      const result = await runCliInProcess(
        'scenario-suite run test.scenario-suite.yaml happy-path',
        workspace,
        {
          env: {
            RUNDOWN_SCENARIO_IN_PROCESS: '1',
            RUNDOWN_SCENARIO_COMMAND_TIMINGS: '1',
          },
        },
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.result).toBe(true);
      const timingLines = result.stderr
        .split('\n')
        .filter((line) => line.startsWith('SCENARIO_TIMING '))
        .map(
          (line) =>
            JSON.parse(line.slice('SCENARIO_TIMING '.length)) as {
              kind: string;
              exitCode: number;
            },
        );
      expect(timingLines).toHaveLength(3);
      expect(timingLines).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'rd', exitCode: 0 })]),
      );
    }, 30000);

    it('errors without case name or --all', async () => {
      const result = await runCliInProcess(
        'scenario-suite run test.scenario-suite.yaml --text',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain('VALIDATION_ERROR');
    });

    it('errors for non-existent case', async () => {
      const result = await runCliInProcess(
        'scenario-suite run test.scenario-suite.yaml nonexistent -q --text',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain('SCENARIO_NOT_FOUND');
    });

    it('reports error when child runbook referenced in commands is not found', async () => {
      const suiteWithChild = `version: 1
name: Child Test
cases:
  needs-child:
    file: suite-test.runbook.md
    commands:
      - rd run --prompted suite-test.runbook.md
      - rd delegate nonexistent-child.runbook.md --step 1
    result: COMPLETE
`;
      await writeFile(join(workspace.cwd, 'child-ref.scenario-suite.yaml'), suiteWithChild);

      const result = await runCliInProcess(
        'scenario-suite run child-ref.scenario-suite.yaml needs-child -q --text',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain('CHILD_RUNBOOK_NOT_FOUND');
    }, 30000);

    it('reports child runbook error with ERROR prefix in --all mode', async () => {
      const suiteWithChild = `version: 1
name: Child Test All
cases:
  needs-child:
    file: suite-test.runbook.md
    commands:
      - rd run --prompted suite-test.runbook.md
      - rd delegate nonexistent-child.runbook.md --step 1
    result: COMPLETE
`;
      await writeFile(join(workspace.cwd, 'child-all.scenario-suite.yaml'), suiteWithChild);

      const result = await runCliInProcess(
        'scenario-suite run child-all.scenario-suite.yaml --all',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.failed).toBe(1);
      const failedCase = parsed.cases[0];
      expect(failedCase.result).toBe(false);
      expect(failedCase.actual).toContain('ERROR:');
      expect(failedCase.actual).toContain('CHILD_RUNBOOK_NOT_FOUND');
    }, 30000);

    it('reports child runbook error with ERROR prefix in single-case mode', async () => {
      const suiteWithChild = `version: 1
name: Child Test Single
cases:
  needs-child:
    file: suite-test.runbook.md
    commands:
      - rd run --prompted suite-test.runbook.md
      - rd delegate nonexistent-child.runbook.md --step 1
    result: COMPLETE
`;
      await writeFile(join(workspace.cwd, 'child-single.scenario-suite.yaml'), suiteWithChild);

      const result = await runCliInProcess(
        'scenario-suite run child-single.scenario-suite.yaml needs-child',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout.trim().split(/\n(?=\{)/)[0]);
      expect(parsed.result).toBe(false);
      expect(parsed.actual).toContain('ERROR:');
      expect(parsed.actual).toContain('CHILD_RUNBOOK_NOT_FOUND');
    }, 30000);

    it('errors for invalid suite file', async () => {
      await writeFile(join(workspace.cwd, 'bad.scenario-suite.yaml'), 'not: valid\n');

      const result = await runCliInProcess(
        'scenario-suite run bad.scenario-suite.yaml --all -q --text',
        workspace,
      );

      expect(result.exitCode).toBe(1);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain('VALIDATION_ERROR');
    });
  });
});
