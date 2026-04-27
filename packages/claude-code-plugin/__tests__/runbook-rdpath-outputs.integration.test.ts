/**
 * End-to-end integration test for rdpath / OUTPUTS / rdpath-find contracts.
 *
 * Drives a synthetic runbook through `rd run` (NOT --prompted) so bash blocks
 * actually execute. Catches regressions that `rd check` and orchestration-only
 * scenarios both miss:
 *   - rdpath invocations missing --file
 *   - Truncated rdx --check "$(rdpath ...)" invocations
 *   - rdpath find globs broken by the YYYY-MM-DD- date prefix
 *
 * Pattern: combines the spawn-style runner from test-utils.ts with the
 * `state.variables` assertion model in
 * packages/cli/__tests__/integration/context-passing-outputs.test.ts.
 *
 * Sandbox/policy note: rd run defaults to sandbox-on. We pass --allow-all
 * --non-interactive for this test. The user-realistic alternative — an
 * explicit `--allow-run rdpath,mkdir,...` allowlist — does not work because
 * the policy parser (packages/core/src/policy/parser.ts, shell-quote based)
 * strips $VAR references at parse time and produces empty/literal-$()
 * "executable" names from redirects whose target uses command substitution.
 * Those stray executables never match any allowlist pattern, so the policy
 * denies the bash block. An isolated mkdtemp workspace is a sufficient trust
 * boundary for this fixture; tightening the allowlist further is tracked
 * at https://github.com/tobyhede/rundown/issues/242.
 *
 * Bin-resolution note: rdpath/rdx dist scripts ship without the execute bit,
 * so symlinking them onto $PATH and relying on the shebang fails. We instead
 * write thin shell wrappers that exec `node <dist-path>` — hermetic, no
 * mutation of tracked files.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginDir = resolve(__dirname, '..');
const repoRoot = resolve(pluginDir, '..', '..');
const cliPath = join(repoRoot, 'packages', 'cli', 'dist', 'cli.js');
const rdpathDist = join(pluginDir, 'dist', 'rdpath.js');
const rdxDist = join(pluginDir, 'dist', 'rdx.js');

const RUNBOOK_SOURCE = `---
name: rdpath-outputs-integration
---
# rdpath + OUTPUTS contract probe

## 1. Write fixture and record its path
- OUTPUTS
  - FixturePath {{ path "fixture.json" }}
- PASS CONTINUE
- FAIL STOP

\`\`\`bash
TARGET="$(rdpath --dir "$RD_WORK_PATH" --ctx "$RD_CONTEXT_ID" --file fixture.json)"
mkdir -p "$(dirname "$TARGET")"
printf '%s\\n' '{"ok":true}' > "$TARGET"
\`\`\`

## 2. Discover fixture via rdpath find
- PASS COMPLETE
- FAIL STOP

\`\`\`bash
rdpath find "*-fixture.json"
\`\`\`
`;

describe('runbook end-to-end: rdpath + OUTPUTS contract', () => {
  let tempDir: string;
  let binDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'rd-rdpath-outputs-'));
    // .rundown/runs is required for state persistence
    await mkdir(join(tempDir, '.rundown', 'runs'), { recursive: true });
    // .git marker prevents WorkPath discovery from walking above the workspace
    await writeFile(join(tempDir, '.git'), 'gitdir: /dev/null\n');

    // Thin wrappers in node_modules/.bin so $PATH resolution finds rdpath/rdx
    // without depending on the execute bit on the dist scripts (which ship 0644).
    binDir = join(tempDir, 'node_modules', '.bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, 'rdpath'), `#!/bin/sh\nexec node "${rdpathDist}" "$@"\n`, {
      mode: 0o755,
    });
    await writeFile(join(binDir, 'rdx'), `#!/bin/sh\nexec node "${rdxDist}" "$@"\n`, {
      mode: 0o755,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Spawn `node cli.js run <runbookPath>` (no --prompted) inside the tempdir
   * with rdpath/rdx wrappers on $PATH and an explicit policy allowlist.
   * Returns the captured stdout/stderr and exit code.
   */
  function runRunbook(runbookPath: string): {
    stdout: string;
    stderr: string;
    exitCode: number;
  } {
    const result = spawnSync(
      'node',
      [cliPath, 'run', runbookPath, '--allow-all', '--non-interactive'],
      {
        cwd: tempDir,
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          NO_COLOR: '1',
          RUNDOWN_LOG: '0',
        },
      },
    );
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.status ?? 1,
    };
  }

  /**
   * Read the (single) runbook state JSON written under .rundown/runs/.
   * Throws if zero or more than one state file is found.
   */
  async function readSingleRunbookState(): Promise<{
    variables?: Record<string, unknown>;
    [k: string]: unknown;
  }> {
    const runsDir = join(tempDir, '.rundown', 'runs');
    const files = (await readdir(runsDir)).filter((f) => f.endsWith('.json'));
    if (files.length !== 1) {
      throw new Error(
        `Expected exactly 1 runbook state file, found ${String(files.length)}: ${files.join(', ')}`,
      );
    }
    const raw = await readFile(join(runsDir, files[0]), 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  }

  it('runs end-to-end, populates OUTPUTS, finds fixture via rdpath find', async () => {
    const runbookPath = join(tempDir, 'probe.runbook.md');
    await writeFile(runbookPath, RUNBOOK_SOURCE);

    const result = runRunbook(runbookPath);

    // Diagnostic: surface CLI output if the run fails
    if (result.exitCode !== 0) {
      throw new Error(
        `runbook exited ${String(result.exitCode)}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
      );
    }
    expect(result.exitCode).toBe(0);

    // Assertion 1: OUTPUTS path helper resolved and merged into state.variables.
    // Tolerates an optional <branch>/ segment between work/ and .rd-<ctx>/
    // because WorkPath may include a branch suffix in some workspaces.
    const state = await readSingleRunbookState();
    const fixturePath = state.variables?.FixturePath;
    expect(typeof fixturePath).toBe('string');
    expect(fixturePath as string).toMatch(
      /^\.rundown\/work\/(?:[^/]+\/)?\.rd-[A-Za-z0-9_-]+\/\d{4}-\d{2}-\d{2}-fixture\.json$/,
    );

    // Assertion 2: the fixture file actually exists at that resolved path,
    // proving rdpath --file produces the same path as the OUTPUTS path helper.
    const absoluteFixturePath = join(tempDir, fixturePath as string);
    expect(existsSync(absoluteFixturePath)).toBe(true);
    const fixtureContents = await readFile(absoluteFixturePath, 'utf-8');
    expect(fixtureContents.trim()).toBe('{"ok":true}');

    // Assertion 3: rdpath find with date-prefix glob ("*-fixture.json") matched
    // and step 2 reached COMPLETE. Step 2 is PASS COMPLETE / FAIL STOP, so the
    // runbook only completes if the bash block exited 0 — i.e. rdpath find
    // matched at least one file. state.lifecycle is a string discriminant
    // ("completed" | "stopped" | ...), not an object.
    expect(state.lifecycle).toBe('completed');
  }, 30_000);

  it('regression guard: rdpath find without "*-" prefix glob fails to match dated file', async () => {
    // Same as the happy path but step 2 uses an unprefixed glob.
    // Because assembleArtifactPath writes "YYYY-MM-DD-fixture.json", a glob
    // of "fixture.json" (no "*-" prefix) MUST NOT match. The runbook should
    // STOP at step 2.
    const broken = RUNBOOK_SOURCE.replace('"*-fixture.json"', '"fixture.json"');
    const runbookPath = join(tempDir, 'probe-broken.runbook.md');
    await writeFile(runbookPath, broken);

    runRunbook(runbookPath);

    const state = await readSingleRunbookState();
    expect(state.lifecycle).toBe('stopped');
  }, 30_000);
});
