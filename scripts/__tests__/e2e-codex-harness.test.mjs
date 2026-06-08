import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

async function readRepoFile(path) {
  return readFile(join(repoRoot, path), 'utf-8');
}

/**
 * Run scripts/e2e-shell.sh inside an isolated ROOT_DIR that contains NO
 * credential directories (.claude-docker / .codex-docker), with `docker`
 * stubbed on PATH so the wrapper's final `exec docker compose ... run`
 * succeeds without a real daemon. Exit 0 means the wrapper reached launch;
 * exit 1 with a "not found" message means a credential gate fired.
 *
 * This exercises real flag BEHAVIOR rather than string-matching the source —
 * a string-match test only pins the one line it names and is blind to the same
 * proxy-gate defect recurring in a sibling branch (the bug this guards).
 *
 * @param agent - 'claude' or 'codex'
 * @param extraArgs - additional flags (e.g. ['--bash', '--no-build'])
 * @returns the spawnSync result (status, stdout, stderr)
 */
async function runShellInIsolatedRoot(agent, extraArgs) {
  const work = await mkdtemp(join(tmpdir(), 'e2e-shell-'));
  try {
    const scriptsDir = join(work, 'scripts');
    const binDir = join(work, 'bin');
    await mkdir(scriptsDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    const script = join(scriptsDir, 'e2e-shell.sh');
    await copyFile(join(repoRoot, 'scripts/e2e-shell.sh'), script);
    await chmod(script, 0o755);

    const dockerStub = join(binDir, 'docker');
    await writeFile(dockerStub, '#!/usr/bin/env bash\nexit 0\n');
    await chmod(dockerStub, 0o755);

    return spawnSync('bash', [script, '--agent', agent, ...extraArgs], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: 'utf-8',
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

test('package exposes provider-specific e2e shell tasks', async () => {
  const packageJson = JSON.parse(await readRepoFile('package.json'));

  assert.equal(packageJson.scripts['test:e2e:claude'], './scripts/e2e-shell.sh --agent claude');
  assert.equal(packageJson.scripts['test:e2e:codex'], './scripts/e2e-shell.sh --agent codex');
  assert.equal(packageJson.scripts['test:e2e:shell'], './scripts/e2e-shell.sh --agent claude');
});

test('docker compose mounts persistent Claude and Codex auth homes', async () => {
  const compose = await readRepoFile('docker-compose.e2e.yml');

  assert.match(compose, /- \.\/\.claude-docker:\/home\/testuser\/\.claude/);
  assert.match(compose, /- \.\/\.codex-docker:\/home\/testuser\/\.codex/);
  assert.match(compose, /- CLAUDE_CONFIG_DIR=\/home\/testuser\/\.claude/);
  assert.match(compose, /- CODEX_HOME=\/home\/testuser\/\.codex/);
});

test('e2e build prepares a minimal persistent Codex home', async () => {
  const buildScript = await readRepoFile('scripts/build-e2e.sh');

  assert.match(buildScript, /Preparing \.codex-docker\/ directory/);
  assert.match(buildScript, /CODEX_SOURCE_DIR="\$\{CODEX_HOME:-\$HOME\/\.codex\}"/);
  assert.match(buildScript, /cp "\$CODEX_SOURCE_DIR\/auth\.json" \.codex-docker\/auth\.json/);
  assert.match(buildScript, /cp "\$CODEX_SOURCE_DIR\/config\.toml" \.codex-docker\/config\.toml/);
  assert.doesNotMatch(buildScript, /cp -r "\$CODEX_SOURCE_DIR"/);
});

test('e2e image installs Codex CLI and ships Codex shell entrypoint', async () => {
  const dockerfile = await readRepoFile('scripts/Dockerfile.verify');

  // Codex CLI must be pinned to a fixed version for reproducible E2E builds
  // (Hadolint DL3016); an unpinned install lets the agent's behavior drift
  // between builds.
  assert.match(dockerfile, /npm install -g @openai\/codex@\d+\.\d+\.\d+/);
  assert.match(
    dockerfile,
    /COPY --chmod=755 scripts\/e2e-codex-shell-entrypoint\.sh \/usr\/local\/bin\/e2e-codex-shell-entrypoint\.sh/,
  );
});

test('e2e shell wrapper selects Claude or Codex entrypoint', async () => {
  const shellScript = await readRepoFile('scripts/e2e-shell.sh');

  assert.match(shellScript, /AGENT="claude"/);
  assert.match(shellScript, /--agent/);
  assert.match(shellScript, /e2e-shell-entrypoint\.sh/);
  assert.match(shellScript, /e2e-codex-shell-entrypoint\.sh/);
});

test('Codex build only requires auth when actually launching Codex (not in --bash)', async () => {
  const shellScript = await readRepoFile('scripts/e2e-shell.sh');

  // `--bash` (SHELL_MODE=true) bypasses launching Codex, so the build must not
  // force REQUIRE_CODEX_AUTH: `npm run test:e2e:codex -- --bash` has to work for
  // users without Codex credentials. The auth requirement is gated on
  // non-shell mode.
  assert.match(shellScript, /\[ "\$AGENT" = codex \] && \[ "\$SHELL_MODE" = false \]/);

  // Guard against reverting to an unconditional codex auth requirement.
  assert.doesNotMatch(shellScript, /if \[ "\$AGENT" = codex \]; then\n\s*REQUIRE_CODEX_AUTH=1/);
});

// Behavioral coverage for the `--no-build` credential gate. The build-path
// `--bash` fix gated REQUIRE_CODEX_AUTH on SHELL_MODE, but the SAME proxy-vs-
// launch decision is made again in the `--no-build` branch (the credential-dir
// existence check). These tests run the wrapper under the flag matrix instead
// of grepping the source, so they catch the gate firing on a branch the string-
// match tests don't name.
for (const agent of ['codex', 'claude']) {
  const credDir = agent === 'codex' ? '.codex-docker' : '.claude-docker';

  test(`--bash --no-build launches ${agent} without requiring ${credDir}`, async () => {
    const result = await runShellInIsolatedRoot(agent, ['--bash', '--no-build']);
    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.equal(
      result.status,
      0,
      `expected exit 0 (--bash never launches ${agent}); got ${result.status}: ${combined}`,
    );
    assert.doesNotMatch(
      combined,
      new RegExp(`${credDir.replace('.', '\\.')}/ not found`),
      `--bash must not require ${credDir} (the agent is never launched)`,
    );
  });

  test(`--no-build without --bash still requires ${credDir} for ${agent}`, async () => {
    const result = await runShellInIsolatedRoot(agent, ['--no-build']);
    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.equal(
      result.status,
      1,
      `expected exit 1 (launching ${agent} requires credentials); got ${result.status}: ${combined}`,
    );
    assert.match(combined, new RegExp(`${credDir.replace('.', '\\.')}/ not found`));
  });
}

test('Codex shell entrypoint validates auth and launches Codex in the workspace', async () => {
  const entrypoint = await readRepoFile('scripts/e2e-codex-shell-entrypoint.sh');

  assert.match(entrypoint, /CODEX_DIR="\$\{CODEX_HOME:-\$HOME\/\.codex\}"/);
  assert.match(entrypoint, /AUTH_FILE="\$CODEX_DIR\/auth\.json"/);
  assert.match(entrypoint, /codex --version/);
  assert.match(entrypoint, /exec codex --cd "\$WORKSPACE"/);
  assert.match(entrypoint, /--sandbox danger-full-access/);
  assert.match(entrypoint, /--ask-for-approval never/);
});

test('Codex shell entrypoint exports experimental SQLite for mounted and fixture workspaces', async () => {
  const entrypoint = await readRepoFile('scripts/e2e-codex-shell-entrypoint.sh');

  const nodeOptionsIdx = entrypoint.indexOf('export NODE_OPTIONS="--experimental-sqlite"');
  const workspaceConditionalIdx = entrypoint.indexOf('if [ -d "$HOME/project" ]');

  assert.notEqual(nodeOptionsIdx, -1, 'NODE_OPTIONS export must be present');
  assert.ok(
    nodeOptionsIdx < workspaceConditionalIdx,
    'NODE_OPTIONS must be exported before the workspace conditional so mounted projects inherit it',
  );
  // The unused logs directory was removed.
  assert.doesNotMatch(entrypoint, /mkdir -p "\$HOME\/logs"/);
});
