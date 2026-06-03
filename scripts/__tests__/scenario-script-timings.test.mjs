import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

async function makeWorkspace() {
  const cwd = await mkdtemp(join(tmpdir(), 'rd-script-test-'));
  await mkdir(join(cwd, 'runbooks'), { recursive: true });
  await mkdir(join(cwd, 'packages/cli/dist'), { recursive: true });
  await mkdir(join(cwd, 'packages/claude-code-plugin'), { recursive: true });

  await writeFile(
    join(cwd, 'runbooks/example.runbook.md'),
    [
      '---',
      'name: example',
      'scenarios:',
      '  happy:',
      '    commands:',
      '      - rd run example.runbook.md',
      '    result: COMPLETE',
      '---',
      '# Example',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(cwd, 'runbooks/scenario-suite.yaml'),
    'cases:\n  happy:\n    commands: []\n',
  );
  await writeFile(
    join(cwd, 'packages/claude-code-plugin/plugin.scenario-suite.yaml'),
    'cases:\n  plugin:\n    commands: []\n',
  );

  await writeFile(
    join(cwd, 'packages/cli/dist/cli.js'),
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      "if (args[0] === 'scenario' && args[1] === 'ls') {",
      "  console.error('scenario ls should not be used by the raw runner');",
      '  process.exit(99);',
      '}',
      "if (args[0] === 'scenario' && args[1] === 'run') {",
      "  if (process.env.RUNDOWN_SCENARIO_COMMAND_TIMINGS === '1') {",
      '    console.error(\'SCENARIO_TIMING {"scope":"command","kind":"rd","exitCode":0,"durationMs":12,"expectedFailure":false,"command":"rd run example.runbook.md"}\');',
      '  }',
      '  process.exit(0);',
      '}',
      "if (args[0] === 'scenario-suite' && args[1] === 'run') {",
      "  if (process.env.RUNDOWN_SCENARIO_COMMAND_TIMINGS === '1') {",
      '    console.error(\'SCENARIO_TIMING {"scope":"case","case":"plugin","durationMs":34}\');',
      '  }',
      '  process.exit(0);',
      '}',
      'process.exit(1);',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  return cwd;
}

test('frontmatter scenario raw script reports per-runbook and total timings', async () => {
  const cwd = await makeWorkspace();

  const result = spawnSync('node', [join(repoRoot, 'scripts/test-scenarios.mjs')], {
    cwd,
    encoding: 'utf-8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /runbooks\/example\.runbook\.md: 1 passed, 0 failed \(\d+ms\)/);
  assert.match(result.stdout, /1 passed, 0 failed \(\d+ms total\)/);
});

test('frontmatter scenario raw script discovers scenarios without scenario ls subprocess', async () => {
  const cwd = await makeWorkspace();

  const result = spawnSync('node', [join(repoRoot, 'scripts/test-scenarios.mjs')], {
    cwd,
    encoding: 'utf-8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /scenario ls should not be used/);
});

test('frontmatter scenario raw script reports frontmatter diagnostics', async () => {
  const cwd = await makeWorkspace();
  await writeFile(
    join(cwd, 'runbooks/invalid.runbook.md'),
    [
      '---',
      'name: invalid',
      'inputs:',
      '  - 42',
      'scenarios:',
      '  broken:',
      '    commands: []',
      '---',
      '# Invalid',
      '',
    ].join('\n'),
  );

  const result = spawnSync('node', [join(repoRoot, 'scripts/test-scenarios.mjs')], {
    cwd,
    encoding: 'utf-8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid frontmatter in runbooks\/invalid\.runbook\.md/);
  assert.match(result.stderr, /Frontmatter "inputs\[0\]" must be a string identifier/);
});

test('scenario suite raw script reports per-suite and total timings', async () => {
  const cwd = await makeWorkspace();

  const result = spawnSync('node', [join(repoRoot, 'scripts/test-scenario-suites.mjs')], {
    cwd,
    encoding: 'utf-8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /packages\/claude-code-plugin\/plugin\.scenario-suite\.yaml: passed \(\d+ms\)/,
  );
  assert.match(result.stdout, /runbooks\/scenario-suite\.yaml: passed \(\d+ms\)/);
  assert.match(result.stdout, /2 suites passed, 0 failed \(\d+ms total\)/);
});

test('scenario suite raw script reports failed suite output', async () => {
  const cwd = await makeWorkspace();
  await writeFile(
    join(cwd, 'packages/cli/dist/cli.js'),
    [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      "if (args[0] === 'scenario-suite' && args[1] === 'run') {",
      '  console.log(JSON.stringify({ result: false, failed: 1, cases: [{ scenario: "broken", result: false, actual: "UNKNOWN" }] }));',
      "  console.error('case diagnostic');",
      '  process.exit(1);',
      '}',
      'process.exit(1);',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  const result = spawnSync('node', [join(repoRoot, 'scripts/test-scenario-suites.mjs')], {
    cwd,
    encoding: 'utf-8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL: packages\/claude-code-plugin\/plugin\.scenario-suite\.yaml/);
  assert.match(result.stdout, /packages\/claude-code-plugin\/plugin\.scenario-suite\.yaml stdout:/);
  assert.match(result.stdout, /"scenario":"broken"/);
  assert.match(result.stderr, /packages\/claude-code-plugin\/plugin\.scenario-suite\.yaml stderr:/);
  assert.match(result.stderr, /case diagnostic/);
});

test('raw scripts forward detailed timings when enabled', async () => {
  const cwd = await makeWorkspace();

  const scenarios = spawnSync('node', [join(repoRoot, 'scripts/test-scenarios.mjs')], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, RUNDOWN_SCENARIO_COMMAND_TIMINGS: '1' },
  });
  assert.equal(scenarios.status, 0, scenarios.stderr);
  assert.match(scenarios.stderr, /SCENARIO_TIMING .*"scope":"command"/);

  const suites = spawnSync('node', [join(repoRoot, 'scripts/test-scenario-suites.mjs')], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, RUNDOWN_SCENARIO_COMMAND_TIMINGS: '1' },
  });
  assert.equal(suites.status, 0, suites.stderr);
  assert.match(suites.stderr, /SCENARIO_TIMING .*"scope":"case"/);
});

test('CI scenarios job uses raw scripts after downloading build artifacts', async () => {
  const workflow = await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf-8');

  assert.match(workflow, /run: npm run test:scenarios:raw/);
  assert.match(workflow, /run: npm run test:scenario-suites:raw/);
});
