import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Run scripts/plugin-dev.sh inside an isolated ROOT_DIR containing a fake plugin
 * manifest, with `npm` and (optionally) `rd`/`claude` stubbed on a pruned PATH so
 * the wrapper reaches its final `exec claude` without a real build or Claude Code.
 *
 * PATH is set to the stub bin dir plus only /usr/bin:/bin — this excludes the
 * developer's real npm/rd/claude so the wrapper's behavior is observed against
 * stubs, not whatever happens to be installed. The claude stub prints its argv,
 * and the npm stub appends its argv to npm.log, so the test asserts real flag
 * BEHAVIOR (what reaches claude, whether build/link ran) rather than string-
 * matching the script source.
 *
 * @param args - arguments passed to plugin-dev.sh
 * @param opts - control which stubs exist on PATH
 * @param opts.rd - whether an `rd` stub is on PATH (default true)
 * @param opts.claude - whether a `claude` stub is on PATH (default true)
 * @param opts.manifest - whether the plugin manifest exists (default true)
 * @param opts.linkProvidesRd - whether `npm link` puts `rd` on PATH (default true).
 *   Set false to simulate a link that succeeds but leaves the npm global bin off PATH.
 * @returns spawnSync result plus the captured npm invocation log
 */
async function runPluginDev(args, opts = {}) {
  const { rd = true, claude = true, manifest = true, linkProvidesRd = true } = opts;
  const work = await mkdtemp(join(tmpdir(), 'plugin-dev-'));
  try {
    const scriptsDir = join(work, 'scripts');
    const binDir = join(work, 'bin');
    const manifestDir = join(work, 'packages/claude-code-plugin/.claude-plugin');
    await mkdir(scriptsDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    if (manifest) {
      await mkdir(manifestDir, { recursive: true });
      await writeFile(join(manifestDir, 'plugin.json'), '{"name":"rundown"}\n');
    }

    const script = join(scriptsDir, 'plugin-dev.sh');
    await copyFile(join(repoRoot, 'scripts/plugin-dev.sh'), script);
    await chmod(script, 0o755);

    const npmLog = join(work, 'npm.log');
    const rdStub = join(binDir, 'rd');
    // npm stub records every invocation; `npm run build` no-ops. `npm link` no-ops
    // too, except that — when linkProvidesRd — it drops an `rd` stub on PATH to model
    // a link that makes the CLI resolvable, mirroring the script's post-link recheck.
    const npmStub = join(binDir, 'npm');
    const linkBody = linkProvidesRd
      ? `if [ "$1" = link ]; then printf '#!/usr/bin/env bash\\nexit 0\\n' > ${JSON.stringify(rdStub)}; chmod 0755 ${JSON.stringify(rdStub)}; fi\n`
      : '';
    await writeFile(
      npmStub,
      `#!/usr/bin/env bash\nprintf '%s ' "$@" >> ${JSON.stringify(npmLog)}\nprintf '\\n' >> ${JSON.stringify(npmLog)}\n${linkBody}exit 0\n`,
    );
    await chmod(npmStub, 0o755);

    if (rd) {
      await writeFile(rdStub, '#!/usr/bin/env bash\nexit 0\n');
      await chmod(rdStub, 0o755);
    }
    if (claude) {
      // Prints argv so the test can assert what the wrapper forwarded.
      const claudeStub = join(binDir, 'claude');
      await writeFile(claudeStub, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@"\n');
      await chmod(claudeStub, 0o755);
    }

    const result = spawnSync('bash', [script, ...args], {
      env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin` },
      encoding: 'utf-8',
    });
    const npmCalls = existsSync(npmLog) ? await readFile(npmLog, 'utf-8') : '';
    return { ...result, npmCalls, pluginDir: join(work, 'packages/claude-code-plugin') };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

test('launches claude with --plugin-dir pointing at the plugin package', async () => {
  const r = await runPluginDev(['--no-build']);
  assert.equal(r.status, 0, r.stderr);
  // Assert the exact trailing argv pair reaches claude, not just that the dir name
  // appears somewhere in stdout (which a launcher diagnostic could satisfy).
  const lines = r.stdout.trim().split('\n');
  assert.deepEqual(lines.slice(-2), ['--plugin-dir', r.pluginDir]);
});

test('--no-build skips the build; default builds', async () => {
  const skipped = await runPluginDev(['--no-build']);
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.doesNotMatch(skipped.npmCalls, /run build/);

  const built = await runPluginDev([]);
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.npmCalls, /run build/);
});

test('forwards args after -- to claude', async () => {
  const r = await runPluginDev(['--no-build', '--', '--debug', 'hooks,plugins']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  // The forwarded flags must arrive after --plugin-dir <dir>, in order. Assert the
  // full claude argv (the trailing lines after the script's diagnostics) so a
  // dropped or reordered --plugin-dir is caught, not just the forwarded tail.
  assert.deepEqual(lines.slice(-4), ['--plugin-dir', r.pluginDir, '--debug', 'hooks,plugins']);
});

test('links the local CLI when rd is absent, skips link when present', async () => {
  const absent = await runPluginDev(['--no-build'], { rd: false });
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.npmCalls, /link -w packages\/cli/);

  const present = await runPluginDev(['--no-build'], { rd: true });
  assert.equal(present.status, 0, present.stderr);
  assert.doesNotMatch(present.npmCalls, /link/);
});

test('fails fast when rd is still absent after npm link', async () => {
  const r = await runPluginDev(['--no-build'], { rd: false, linkProvidesRd: false });
  assert.match(r.npmCalls, /link -w packages\/cli/);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /still not on PATH after npm link/i);
});

test('fails when claude is not installed', async () => {
  const r = await runPluginDev(['--no-build'], { claude: false });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /claude.*not found/i);
});

test('fails on an unknown argument', async () => {
  const r = await runPluginDev(['--nope']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown argument/i);
});

test('fails when the plugin manifest is missing', async () => {
  const r = await runPluginDev(['--no-build'], { manifest: false });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /manifest not found/i);
});
