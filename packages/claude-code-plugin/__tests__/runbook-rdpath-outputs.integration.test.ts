/**
 * End-to-end regression guard for `rdpath find` glob behavior.
 *
 * Drives a synthetic runbook through `rd run` (NOT --prompted) so bash blocks
 * actually execute, then asserts that `rdpath find` without a `*-` prefix glob
 * fails to match the date-prefixed file written by `rdpath --file`.
 *
 * Policy note: uses --allow-run with an explicit allowlist and --no-sandbox for the
 * mkdtemp workspace (an isolated trust boundary). --allow-write does not reach the
 * OS sandbox path grants, so --no-sandbox is the correct flag here.
 *
 * Bin-resolution note: rdpath/rdx dist scripts ship without the execute bit,
 * so symlinking them onto $PATH and relying on the shebang fails. We instead
 * write thin shell wrappers that exec `node <dist-path>` — hermetic, no
 * mutation of tracked files.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  listPersistedRunIds,
  readPersistedRunState,
} from '@rundown-org/core/testing/session-fixtures';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  - FixturePath
- PASS CONTINUE
- FAIL STOP

\`\`\`bash
TARGET="$(rdpath --dir "$RD_WORK_PATH" --ctx "$RD_CONTEXT_ID" --file fixture.json)"
mkdir -p "$(dirname "$TARGET")"
printf '%s\\n' '{"ok":true}' > "$TARGET"
printf '%s' "$TARGET" > "$RD_OUTPUTS_FixturePath"
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
    // .rundown holds the SQLite run store (rundown.db); the store creates the
    // db file, but the directory must exist for the workspace to be recognised.
    await mkdir(join(tempDir, '.rundown'), { recursive: true });
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
      [
        cliPath,
        'run',
        runbookPath,
        '--allow-run',
        'rdpath,mkdir,printf,dirname',
        '--no-sandbox',
        '--non-interactive',
      ],
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
   * Read the (single) runbook state persisted in the SQLite run store.
   * Throws if zero or more than one run is found.
   */
  async function readSingleRunbookState(): Promise<{
    variables?: Record<string, unknown>;
    [k: string]: unknown;
  }> {
    const ids = await listPersistedRunIds(tempDir);
    if (ids.length !== 1) {
      throw new Error(
        `Expected exactly 1 persisted runbook state, found ${String(ids.length)}: ${ids.join(', ')}`,
      );
    }
    const state = await readPersistedRunState(tempDir, ids[0]);
    if (state === null) {
      throw new Error(`Persisted run ${ids[0]} could not be read`);
    }
    return state;
  }

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
