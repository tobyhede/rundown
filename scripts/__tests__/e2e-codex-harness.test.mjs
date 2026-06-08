import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

async function readRepoFile(path) {
  return readFile(join(repoRoot, path), 'utf-8');
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
