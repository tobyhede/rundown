import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Read a repository-relative file as UTF-8 text.
 *
 * @param path - repository-relative path
 * @returns the file contents
 */
async function readRepoFile(path) {
  return readFile(join(repoRoot, path), 'utf-8');
}

function parseLocalPackageList(source) {
  const match = source.match(/RUNDOWN_LOCAL_PACKAGES=\(([^)]*)\)/);
  assert.ok(match, 'scripts/lib/local-packages.sh must define RUNDOWN_LOCAL_PACKAGES');
  return match[1].trim().split(/\s+/).filter(Boolean);
}

function packageTarballName(pkg) {
  return `rundown-org-${pkg}`;
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

/**
 * Run scripts/e2e-shell.sh with an arbitrary argument vector (no implicit
 * --agent), used to exercise argument-parsing and validation failure paths.
 * `docker` is stubbed on PATH and a project directory is created on demand so
 * the mounting path is exercised without a real daemon.
 *
 * @param args - the raw argument vector passed to e2e-shell.sh
 * @param options - optional { projectDir: relative-name-to-create }
 * @returns { result, work } — the spawnSync result and the temp ROOT_DIR
 */
async function runShellRaw(args, options = {}) {
  const work = await mkdtemp(join(tmpdir(), 'e2e-shell-'));
  const scriptsDir = join(work, 'scripts');
  const binDir = join(work, 'bin');
  await mkdir(scriptsDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  const script = join(scriptsDir, 'e2e-shell.sh');
  await copyFile(join(repoRoot, 'scripts/e2e-shell.sh'), script);
  await chmod(script, 0o755);

  const dockerStub = join(binDir, 'docker');
  // Echo argv so tests can assert what `docker compose run` was invoked with.
  await writeFile(dockerStub, '#!/usr/bin/env bash\nprintf "DOCKER_ARGV: %s\\n" "$*"\nexit 0\n');
  await chmod(dockerStub, 0o755);

  // Provide a docker-compose file so the pre-flight existence check passes.
  await writeFile(join(work, 'docker-compose.e2e.yml'), 'services: {}\n');

  let projectPath;
  if (options.projectDir) {
    projectPath = join(work, options.projectDir);
    await mkdir(projectPath, { recursive: true });
  }

  const result = spawnSync('bash', [script, ...args], {
    cwd: work,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    encoding: 'utf-8',
  });
  return { result, work, projectPath };
}

/**
 * Source scripts/lib/e2e-auth.sh and invoke one of its credential-preparation
 * functions in isolation, with HOME/CODEX_HOME/OSTYPE controlled by the test.
 * This is the testable seam for the agent-scoped auth-gating decision: tests
 * exercise the actual gating logic without running a full Docker build.
 *
 * @param fn - 'e2e_prepare_claude_auth' or 'e2e_prepare_codex_auth'
 * @param agent - active agent (claude|codex|none)
 * @param env - environment overrides (HOME, CODEX_HOME, OSTYPE)
 * @returns { status, stdout, stderr, dir } where dir is the prepared cred home
 */
async function runAuthGate(fn, agent, env = {}) {
  const work = await mkdtemp(join(tmpdir(), 'e2e-auth-'));
  try {
    const lib = join(work, 'e2e-auth.sh');
    await copyFile(join(repoRoot, 'scripts/lib/e2e-auth.sh'), lib);
    const credDir = join(work, 'cred-home');
    // Emit existence markers from inside the harness, before the finally block
    // removes the temp dir, so callers can assert on files without racing cleanup.
    const harness = [
      'set -euo pipefail',
      `. "${lib}"`,
      `rc=0; ${fn} "${agent}" "${credDir}" || rc=$?`,
      `[ -d "${credDir}" ] && echo "MARKER_DIR_EXISTS"`,
      `[ -f "${credDir}/auth.json" ] && echo "MARKER_AUTH_JSON"`,
      `[ -f "${credDir}/config.toml" ] && echo "MARKER_CONFIG_TOML"`,
      `[ -f "${credDir}/.credentials.json" ] && echo "MARKER_CLAUDE_CREDENTIALS"`,
      'exit $rc',
    ].join('\n');
    const result = spawnSync('bash', ['-c', harness], {
      // Strip inherited HOME/CODEX_HOME/OSTYPE; the test sets exactly what it needs.
      env: {
        PATH: process.env.PATH,
        HOME: env.HOME ?? join(work, 'fake-home'),
        ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {}),
        ...(env.OSTYPE ? { OSTYPE: env.OSTYPE } : {}),
      },
      encoding: 'utf-8',
    });
    return { ...result, dir: credDir };
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

test('harness scripts tests are wired into pnpm test and CI', async () => {
  const packageJson = JSON.parse(await readRepoFile('package.json'));

  // The scripts/__tests__ mjs tests run under `pnpm test` (run-p test:unit:*)…
  assert.equal(
    packageJson.scripts['test:unit:scripts'],
    'node --test scripts/__tests__/*.test.mjs',
  );
  assert.match(packageJson.scripts['test:unit'], /test:unit:\*/);

  // …and on every pull request via the CI `scenarios` job (the per-package
  // coverage jobs do not run scripts/__tests__).
  const ci = await readRepoFile('.github/workflows/ci.yml');
  assert.match(ci, /pnpm run test:unit:scripts/);
});

test('docker compose mounts persistent Claude and Codex auth homes', async () => {
  const compose = await readRepoFile('docker-compose.e2e.yml');

  assert.match(compose, /- \.\/\.claude-docker:\/home\/testuser\/\.claude/);
  assert.match(compose, /- \.\/\.codex-docker:\/home\/testuser\/\.codex/);
  assert.match(compose, /- CLAUDE_CONFIG_DIR=\/home\/testuser\/\.claude/);
  assert.match(compose, /- CODEX_HOME=\/home\/testuser\/\.codex/);
});

test('e2e build prepares a minimal persistent Codex home via the auth library', async () => {
  const buildScript = await readRepoFile('scripts/build-e2e.sh');

  // Credential prep is delegated to the sourced, agent-scoped auth library.
  assert.match(buildScript, /\. "\$SCRIPT_DIR\/lib\/e2e-auth\.sh"/);
  assert.match(buildScript, /e2e_prepare_codex_auth "\$E2E_AGENT" \.codex-docker/);
  assert.match(buildScript, /e2e_prepare_claude_auth "\$E2E_AGENT" \.claude-docker/);

  // Only selected files are copied — never the whole Codex home.
  const lib = await readRepoFile('scripts/lib/e2e-auth.sh');
  assert.match(lib, /cp "\$source_dir\/auth\.json" "\$codex_home\/auth\.json"/);
  assert.match(lib, /cp "\$source_dir\/config\.toml" "\$codex_home\/config\.toml"/);
  assert.doesNotMatch(lib, /cp -r "\$source_dir"/);
});

test('e2e image installs Codex CLI, ships the Codex entrypoint, and the Codex AGENTS guidance', async () => {
  const dockerfile = await readRepoFile('scripts/Dockerfile.verify');

  // Codex CLI must be pinned to a fixed version for reproducible E2E builds
  // (Hadolint DL3016); an unpinned install lets the agent's behavior drift
  // between builds.
  assert.match(dockerfile, /npm install -g @openai\/codex@\d+\.\d+\.\d+/);
  assert.match(
    dockerfile,
    /COPY --chmod=755 scripts\/e2e-codex-shell-entrypoint\.sh \/usr\/local\/bin\/e2e-codex-shell-entrypoint\.sh/,
  );
  // The Rundown-aware Codex guidance is baked into the image.
  assert.match(
    dockerfile,
    /COPY --chmod=644 scripts\/e2e-codex-agents\.md \/usr\/local\/share\/rundown\/codex-agents\.md/,
  );
});

test('local Docker tarball producers share the Dockerfile package list', async () => {
  const build = await readRepoFile('scripts/build-e2e.sh');
  const verify = await readRepoFile('scripts/verify-install.sh');
  const dockerfile = await readRepoFile('scripts/Dockerfile.verify');
  const packageList = parseLocalPackageList(await readRepoFile('scripts/lib/local-packages.sh'));

  assert.match(build, /\. "\$SCRIPT_DIR\/lib\/local-packages\.sh"/);
  assert.match(verify, /\. "\$SCRIPT_DIR\/lib\/local-packages\.sh"/);
  assert.match(build, /pack_rundown_local_packages "\$dist_abs"/);
  assert.match(verify, /pack_rundown_local_packages "\$dist_abs"/);
  assert.ok(packageList.includes('mcp'), 'local Docker package list must include mcp');

  for (const pkg of packageList) {
    const tarball = packageTarballName(pkg);
    assert.match(dockerfile, new RegExp(`COPY dist/${tarball}-\\*\\.tgz /tmp/tarballs/`));
    assert.match(dockerfile, new RegExp(`/tmp/tarballs/${tarball}-\\*\\.tgz`));
  }
});

test('Rundown MCP tool surface includes Stage 1 execution tools', async () => {
  const definitions = await readRepoFile('packages/mcp/src/tool-definitions.ts');
  const tools = ['validate', 'list', 'status', 'run', 'pass', 'fail', 'goto', 'complete', 'stop'];

  for (const tool of tools) {
    assert.match(definitions, new RegExp(`${tool}: \\{`));
  }

  assert.match(definitions, /description: 'Start or enter a runbook'/);
  assert.match(definitions, /description: 'Mark a step passed'/);
  assert.match(definitions, /description: 'Mark a step failed'/);
});

test('E2E image copies the Rundown Codex plugin root', async () => {
  const dockerfile = await readRepoFile('scripts/Dockerfile.verify');

  assert.match(
    dockerfile,
    /packages\/claude-code-plugin\/codex-plugin \/usr\/local\/share\/rundown\/packages\/claude-code-plugin\/codex-plugin/,
  );
  assert.match(
    dockerfile,
    /\.agents\/plugins\/marketplace\.json \/usr\/local\/share\/rundown\/\.agents\/plugins\/marketplace\.json/,
  );
});

test('repo-local Codex marketplace exposes the Rundown plugin', async () => {
  const marketplace = JSON.parse(await readRepoFile('.agents/plugins/marketplace.json'));

  assert.equal(marketplace.name, 'rundown-local');
  assert.equal(marketplace.interface.displayName, 'Rundown Local');
  assert.deepEqual(marketplace.plugins[0], {
    name: 'rundown',
    source: {
      source: 'local',
      path: './packages/claude-code-plugin/codex-plugin',
    },
    policy: {
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL',
    },
    category: 'Developer Tools',
  });
});

test('repo-local Codex marketplace source path resolves from the checkout root', async () => {
  const marketplace = JSON.parse(await readRepoFile('.agents/plugins/marketplace.json'));
  const sourcePath = marketplace.plugins[0].source.path;

  assert.equal(
    join(repoRoot, sourcePath),
    join(repoRoot, 'packages/claude-code-plugin/codex-plugin'),
  );
  assert.equal(
    join(repoRoot, sourcePath, '.codex-plugin', 'plugin.json'),
    join(repoRoot, 'packages/claude-code-plugin/codex-plugin', '.codex-plugin', 'plugin.json'),
  );
});

test('Rundown Claude plugin package also ships a Codex plugin surface', async () => {
  const manifest = JSON.parse(
    await readRepoFile('packages/claude-code-plugin/codex-plugin/.codex-plugin/plugin.json'),
  );
  const mcp = JSON.parse(await readRepoFile('packages/claude-code-plugin/codex-plugin/.mcp.json'));
  const pluginPackage = JSON.parse(await readRepoFile('packages/claude-code-plugin/package.json'));

  assert.equal(manifest.name, 'rundown');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.equal(manifest.interface.displayName, 'Rundown');
  assert.equal(manifest.interface.category, 'Developer Tools');
  assert.match(manifest.interface.longDescription, /runbook/i);
  assert.ok(manifest.interface.capabilities.includes('Interactive'));
  assert.equal(manifest.interface.logo, './assets/rundown.svg');
  assert.equal(manifest.interface.composerIcon, './assets/rundown.svg');

  assert.deepEqual(mcp.mcpServers.rundown, {
    command: 'node',
    args: ['${CODEX_PLUGIN_ROOT}/../dist/rundown-mcp.js'],
  });

  assert.ok(pluginPackage.files.includes('codex-plugin'));
  assert.equal(pluginPackage.dependencies['@rundown-org/mcp'], '*');
  assert.equal(pluginPackage.bin['rundown-mcp'], 'dist/rundown-mcp.js');
});

test('Codex plugin bundles Rundown skills without Claude-only syntax', async () => {
  const expectedSkills = [
    'rundown',
    'running-runbooks',
    'writing-runbooks',
    'planning',
    'executing-plans',
    'writing-plans',
    'converting-skills-to-runbooks',
    'end-to-end-testing',
  ];

  for (const skill of expectedSkills) {
    const skillText = await readRepoFile(
      `packages/claude-code-plugin/codex-plugin/skills/${skill}/SKILL.md`,
    );
    assert.match(skillText, /^---\nname:/);
    assert.doesNotMatch(skillText, /CLAUDE_PLUGIN_ROOT/);
    assert.doesNotMatch(skillText, /Skill\(skill: "rundown:/);
    assert.doesNotMatch(skillText, /Claude Code lifecycle|SubagentStop|PreToolUse/);
    assert.match(skillText, /rundown/);
  }

  const running = await readRepoFile(
    'packages/claude-code-plugin/codex-plugin/skills/running-runbooks/SKILL.md',
  );
  assert.match(running, /MCP tools are available/);
  assert.match(running, /rundown run/);
  assert.match(running, /rundown pass/);
  assert.match(running, /rundown fail/);

  const delegating = await readRepoFile(
    'packages/claude-code-plugin/codex-plugin/skills/delegating-runbooks/SKILL.md',
  ).catch(() => '');
  assert.equal(
    delegating,
    '',
    'Stage 1 must not ship automatic delegation orchestration as a Codex skill',
  );
});

test('e2e shell wrapper selects Claude or Codex entrypoint', async () => {
  const shellScript = await readRepoFile('scripts/e2e-shell.sh');

  assert.match(shellScript, /AGENT="claude"/);
  assert.match(shellScript, /--agent/);
  assert.match(shellScript, /e2e-shell-entrypoint\.sh/);
  assert.match(shellScript, /e2e-codex-shell-entrypoint\.sh/);
});

// ── Behavioral: build-path credential gating (RUNDOWN_E2E_AGENT) ─────────────
//
// The wrapper passes the effective agent into build-e2e.sh, which gates auth on
// it. In --bash mode the effective agent is 'none' (no auth). Otherwise only
// the launching agent's credentials are required.
test('build-path passes RUNDOWN_E2E_AGENT matching the launch decision', async () => {
  const shellScript = await readRepoFile('scripts/e2e-shell.sh');

  // --bash collapses to the 'none' agent so neither Claude nor Codex auth fires.
  assert.match(shellScript, /BUILD_AGENT=none/);
  assert.match(shellScript, /RUNDOWN_E2E_AGENT="\$BUILD_AGENT" \.\/scripts\/build-e2e\.sh/);

  // Guard against reverting to the old Claude-always / REQUIRE_CODEX_AUTH gate.
  assert.doesNotMatch(shellScript, /REQUIRE_CODEX_AUTH=1/);
});

// ── Behavioral: agent-scoped auth library (the testable seam) ────────────────

test('codex agent does NOT require Claude credentials (issue #401.1)', async () => {
  // Non-darwin so the Keychain branch is skipped; no .credentials.json present.
  const { status, stdout, stderr } = await runAuthGate('e2e_prepare_claude_auth', 'codex', {
    OSTYPE: 'linux-gnu',
  });
  const combined = `${stdout ?? ''}${stderr ?? ''}`;
  assert.equal(status, 0, `codex must not require Claude auth; got ${status}: ${combined}`);
  assert.match(combined, /Skipping Claude credentials/);
  // The credential home is still created so the volume mount resolves.
  assert.match(combined, /MARKER_DIR_EXISTS/, 'Claude credential home should be created');
});

test('claude agent without credentials fails the Claude auth gate', async () => {
  const { status, stdout, stderr } = await runAuthGate('e2e_prepare_claude_auth', 'claude', {
    OSTYPE: 'linux-gnu',
  });
  const combined = `${stdout ?? ''}${stderr ?? ''}`;
  assert.equal(status, 1, `claude agent must require Claude auth; got ${status}: ${combined}`);
  assert.match(combined, /No Claude credentials found/);
});

test('codex agent without credentials fails the Codex auth gate', async () => {
  const emptyHome = await mkdtemp(join(tmpdir(), 'codex-empty-'));
  try {
    const { status, stdout, stderr } = await runAuthGate('e2e_prepare_codex_auth', 'codex', {
      CODEX_HOME: emptyHome, // no auth.json here
    });
    const combined = `${stdout ?? ''}${stderr ?? ''}`;
    assert.equal(status, 1, `codex agent must require Codex auth; got ${status}: ${combined}`);
    assert.match(combined, /Codex auth file not found/);
  } finally {
    await rm(emptyHome, { recursive: true, force: true });
  }
});

test('codex agent WITH credentials copies auth.json into the Codex home', async () => {
  const sourceHome = await mkdtemp(join(tmpdir(), 'codex-src-'));
  try {
    await writeFile(join(sourceHome, 'auth.json'), '{"token":"x"}');
    await writeFile(join(sourceHome, 'config.toml'), 'model = "x"\n');
    const { status, stdout } = await runAuthGate('e2e_prepare_codex_auth', 'codex', {
      CODEX_HOME: sourceHome,
    });
    assert.equal(status, 0);
    assert.match(stdout, /MARKER_AUTH_JSON/, 'auth.json must be copied');
    assert.match(stdout, /MARKER_CONFIG_TOML/, 'config.toml must be copied when present');
  } finally {
    await rm(sourceHome, { recursive: true, force: true });
  }
});

test('claude agent does NOT require Codex credentials', async () => {
  const emptyHome = await mkdtemp(join(tmpdir(), 'codex-empty-'));
  try {
    const { status, stdout, stderr } = await runAuthGate('e2e_prepare_codex_auth', 'claude', {
      CODEX_HOME: emptyHome,
    });
    const combined = `${stdout ?? ''}${stderr ?? ''}`;
    assert.equal(status, 0, `claude must not require Codex auth; got ${status}: ${combined}`);
    assert.match(combined, /Skipping Codex credentials/);
  } finally {
    await rm(emptyHome, { recursive: true, force: true });
  }
});

test("'none' agent (--bash) requires neither Claude nor Codex credentials", async () => {
  const emptyHome = await mkdtemp(join(tmpdir(), 'codex-empty-'));
  try {
    const claude = await runAuthGate('e2e_prepare_claude_auth', 'none', { OSTYPE: 'linux-gnu' });
    assert.equal(claude.status, 0, 'bash mode must not require Claude auth');
    const codex = await runAuthGate('e2e_prepare_codex_auth', 'none', { CODEX_HOME: emptyHome });
    assert.equal(codex.status, 0, 'bash mode must not require Codex auth');
  } finally {
    await rm(emptyHome, { recursive: true, force: true });
  }
});

// ── Behavioral: argument parsing & validation failure paths ──────────────────

test('--agent rejects an unknown agent value', async () => {
  const { result, work } = await runShellRaw(['--agent', 'gpt', '--no-build']);
  try {
    assert.equal(result.status, 1, 'unknown agent must fail');
    assert.match(`${result.stdout}${result.stderr}`, /unknown agent 'gpt'/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('--agent without a value fails fast', async () => {
  const { result, work } = await runShellRaw(['--agent']);
  try {
    assert.equal(result.status, 1, '--agent with no value must fail');
    assert.match(`${result.stdout}${result.stderr}`, /--agent requires/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('--bash --no-build drops to bash without any agent credential gate', async () => {
  const { result, work } = await runShellRaw(['--agent', 'codex', '--bash', '--no-build']);
  try {
    const combined = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, `--bash must reach launch; got ${result.status}: ${combined}`);
    // bash entrypoint, no credential-dir error.
    assert.match(combined, /--entrypoint bash/);
    assert.doesNotMatch(combined, /not found/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('a missing project path fails before any docker invocation', async () => {
  const { result, work } = await runShellRaw([
    '--agent',
    'codex',
    '--bash',
    '--no-build',
    '/no/such/project',
  ]);
  try {
    assert.equal(result.status, 1, 'nonexistent project path must fail');
    assert.match(`${result.stdout}${result.stderr}`, /Project path does not exist/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('an existing project path is mounted into the container', async () => {
  const { result, work, projectPath } = await runShellRaw(
    ['--agent', 'codex', '--bash', '--no-build', 'my-project'],
    { projectDir: 'my-project' },
  );
  try {
    const combined = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, `mount path must reach launch; got: ${combined}`);
    assert.match(combined, /Mounting project:/);
    // The resolved absolute project path is bind-mounted to the container path.
    assert.match(combined, new RegExp(`${projectPath}:/home/testuser/project`));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

// ── Behavioral: --no-build credential-dir gate (existing matrix) ─────────────

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

// ── Codex entrypoint: auth, launch, plugin marketplace integration ──────────

test('Codex shell entrypoint validates auth and launches Codex in the workspace', async () => {
  const entrypoint = await readRepoFile('scripts/e2e-codex-shell-entrypoint.sh');

  assert.match(entrypoint, /CODEX_DIR="\$\{CODEX_HOME:-\$HOME\/\.codex\}"/);
  assert.match(entrypoint, /AUTH_FILE="\$CODEX_DIR\/auth\.json"/);
  assert.match(entrypoint, /codex --version/);
  assert.match(entrypoint, /exec codex --cd "\$WORKSPACE"/);
  assert.match(entrypoint, /--sandbox danger-full-access/);
  assert.match(entrypoint, /--ask-for-approval never/);
});

test('Codex shell entrypoint installs the local Rundown Codex plugin and exports MCP env', async () => {
  const entrypoint = await readRepoFile('scripts/e2e-codex-shell-entrypoint.sh');

  assert.match(
    entrypoint,
    /PLUGIN_DIR="\/usr\/local\/share\/rundown\/packages\/claude-code-plugin\/codex-plugin"/,
  );
  assert.match(entrypoint, /MARKETPLACE_ROOT="\/usr\/local\/share\/rundown"/);
  assert.match(entrypoint, /export CODEX_PLUGIN_ROOT="\$PLUGIN_DIR"/);
  assert.match(entrypoint, /export RUNDOWN_PLUGIN_ROOT="\$PLUGIN_DIR"/);
  assert.match(entrypoint, /codex plugin marketplace add "\$MARKETPLACE_ROOT"/);
  assert.match(entrypoint, /codex plugin add rundown@rundown-local/);
  assert.doesNotMatch(entrypoint, /--plugin-dir/);
  assert.match(entrypoint, /command -v rundown-mcp/);
  assert.match(entrypoint, /Plugin:    \$PLUGIN_DIR/);
  assert.match(entrypoint, /Marketplace: \$MARKETPLACE_ROOT\/\.agents\/plugins\/marketplace\.json/);
  assert.match(entrypoint, /MCP:/);

  assert.doesNotMatch(entrypoint, /CODEX_AGENTS_SOURCE=/);
  assert.doesNotMatch(entrypoint, /cp "\$CODEX_AGENTS_SOURCE" "\$WORKSPACE\/AGENTS\.md"/);
});

test('Codex AGENTS.md guidance is fallback CLI guidance', async () => {
  const agents = await readRepoFile('scripts/e2e-codex-agents.md');

  assert.match(agents, /fallback notes/);
  assert.match(agents, /rundown run/);
  assert.match(agents, /rundown status/);
  assert.match(agents, /rundown pass/);
  assert.match(agents, /rundown fail/);
  assert.doesNotMatch(agents, /\brd\s/);
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
