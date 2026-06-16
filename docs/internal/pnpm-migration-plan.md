# npm → pnpm Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the rundown monorepo from npm workspaces to pnpm workspaces so that many git worktrees share one content-addressable store (hardlinked, ~1× disk instead of N×446 MB) and per-worktree installs are near-instant — without changing how end users install the published npm packages.

**Architecture:** Dev-side package-manager swap only. The published packages (`@rundown-org/{parser,core,cli,mcp,claude-code-plugin}`) and the way consumers `npm install -g @rundown-org/cli` are unchanged. We convert: lockfile, workspace declaration, root/per-package scripts (`-w <pkg>` → `--filter <name>`), the `overrides` block (→ `pnpm-workspace.yaml` `overrides`), all pnpm settings (→ `pnpm-workspace.yaml`), dependency build-script approval (→ `pnpm-workspace.yaml` `allowBuilds`), CI bootstrap (the shared composite action + the three workflows that bypass it), Stryker `packageManager` + plugins, Changesets `packageManager`, and the worktree helper. Docker stages that simulate consumer installs (`npm install -g <tarball>`) **stay on npm by design**. The one genuine risk — phantom dependencies surfaced by pnpm's strict non-flat `node_modules` — is handled by an explicit "run verify, declare missing deps, repeat" loop (Task 11) rather than a blanket `shamefully-hoist`.

**Tech Stack:** pnpm 11.7.0 (via Corepack), Node ≥24, npm-workspaces→pnpm-workspaces, Jest+ts-jest (ESM), Stryker (jest-runner), Changesets, Biome, ESLint, GitHub Actions, Docker.

---

## pnpm 11 breaking changes (must-know before executing)

This migration targets pnpm **11.7.0**, which crosses the 9 → 10 → 11 boundary. Four changes affect this repo; each is wired into the tasks below. The config destination for almost everything is `pnpm-workspace.yaml`.

| # | Change | Where it bites | Fix (task) |
|---|--------|----------------|------------|
| 1 | `pnpm.overrides` in `package.json` is **no longer read** | Security pins silently stop applying | Move to `pnpm-workspace.yaml` `overrides:` (Task 3) |
| 2 | Dependency build scripts blocked by default; `onlyBuiltDependencies` **removed**; `strictDepBuilds: true` is the default → an **unreviewed build script is a hard install failure** (non-zero exit) | `pnpm install` exits 1 on esbuild/sharp/unrs-resolver | Allowlist via `allowBuilds:` map in `pnpm-workspace.yaml` (Task 4) |
| 3 | `.npmrc` is read **only for auth/registry**; every other setting must move to `pnpm-workspace.yaml` as a **camelCase** key | `node-options`, `link-/prefer-workspace-packages`, `auto-install-peers` all ignored | Move them to `pnpm-workspace.yaml` (Task 6) |
| 4 | Consequence of #3: `node-options=--experimental-vm-modules` ignored → Jest ESM not enabled → every ESM test suite fails to parse (`Unexpected token 'export'`) | Whole test suite red | Fixed by #3 via `nodeOptions:` (Task 6) |

`dangerouslyAllowAllBuilds: true` would also silence #2, but it runs **every** transitive build script — a supply-chain downgrade. Do not use it; allowlist explicitly.

---

## Background facts (verified against the repo at plan time)

These are load-bearing — do not re-derive, but do re-verify if the tree has drifted.

- **Workspaces today:** root `package.json` declares `workspaces: ["packages/*", "site"]`. Package names: `@rundown-org/parser`, `@rundown-org/core`, `@rundown-org/cli`, `@rundown-org/mcp`, `@rundown-org/claude-code-plugin`, and `site` (name is literally `site`).
- **`npm-run-all2` (`run-s`/`run-p`)** drives parallel/serial script groups. It is package-manager-agnostic — **keep it, no changes**. Only the leaf `npm run X -w <pkg>` invocations change.
- **`.npmrc`** previously set `node-options=--experimental-vm-modules` (Jest ESM) plus `link-workspace-packages`, `prefer-workspace-packages`, `auto-install-peers`. **pnpm 11 reads only auth/registry settings from `.npmrc`** — all of these MUST move to `pnpm-workspace.yaml` as camelCase keys or they are silently ignored (Task 6). The empty `NODE_OPTIONS` is what breaks every ESM Jest suite.
- **`overrides`** in root `package.json` is large (security pins). **pnpm 11 ignores both top-level `overrides` and `pnpm.overrides` in `package.json`** — overrides now live in `pnpm-workspace.yaml` `overrides:`. This MUST be moved or the security pins silently stop applying (Task 3).
- **Dependency build scripts** (esbuild, sharp, unrs-resolver) are blocked by default under pnpm 11's `strictDepBuilds: true`; an unreviewed one fails the install. They must be allowlisted in `pnpm-workspace.yaml` `allowBuilds:` (Task 4).
- **Jest workspace resolution is NOT hoisting-dependent:** every `packages/*/jest.config.js` maps `@rundown-org/*` to sibling `src/*.ts` via `moduleNameMapper`. So jest will not break on pnpm's layout for *workspace* packages. Third-party transitive deps are the risk (Task 11).
- **CI install chokepoint:** `.github/actions/setup-node-deps/action.yml` is a composite action used by every job in `ci.yml`. Updating it covers all of `ci.yml`. Three workflows bypass it and call `npm ci` directly: `release.yml`, `mutation.yml`, `plugin-smoke-test.yml`.
- **Stryker** spawns child processes that don't inherit `pnpm-workspace.yaml`'s `nodeOptions`; the 4 `stryker.config.mjs` files already pass `testRunnerNodeArgs: ['--experimental-vm-modules']` independently (so they are unaffected by the `.npmrc`→yaml move). They set `packageManager: 'npm'` and need `packageManager: 'pnpm'` plus an explicit `plugins: ['@stryker-mutator/jest-runner']` (pnpm's isolated layout breaks Stryker's plugin auto-discovery — Task 12).
- **Docker `Dockerfile.verify`:** the `local`/`npm`/`e2e` stages `npm install -g` published tarballs / registry packages. This **simulates end users** and stays npm. Only repo-source installs (`npm install --ignore-scripts` in `e2e-*-entrypoint.sh`) are migration candidates — see Task 10.

---

## File Structure

Files created:
- `pnpm-workspace.yaml` — workspace package globs **plus** all pnpm settings (`nodeOptions`, `linkWorkspacePackages`, `preferWorkspacePackages`, `autoInstallPeers`), the `allowBuilds:` build-script allowlist, and the `overrides:` security pins.
- `packages/cli/jest.live-cwd-environment.cjs` — custom Jest environment restoring a live cwd in the worker realm (test-harness fix; see Execution divergences).
- `.github/workflows/` — no new files; edits only.

Files modified:
- `package.json` (root) — `packageManager` field, `workspaces` removed, all `-w <pkg>` → `--filter <name>`, `pnpm.overrides` block + `"//overrides"` comment **removed** (overrides moved to `pnpm-workspace.yaml`).
- `.npmrc` — stripped to auth/registry-only (pnpm 11 ignores all other keys here); a comment points to `pnpm-workspace.yaml`.
- `.nvmrc` — unchanged (referenced by workflows; confirm present).
- `packages/cli/jest.config.js` — wire up the custom cwd environment.
- `eslint.ignores.js` — add `**/*.cjs` to the typed-ESLint ignore list.
- `scripts/worktree.sh` — `pnpm install` in the new worktree.
- `.github/actions/setup-node-deps/action.yml` — add `pnpm/action-setup`, switch cache + install.
- `.github/workflows/release.yml`, `mutation.yml`, `plugin-smoke-test.yml` — pnpm bootstrap + install.
- `.github/workflows/osv-scanner.yml` — point `--lockfile` at `pnpm-lock.yaml`.
- `.changeset/config.json` — `packageManager: "pnpm"`.
- `packages/{parser,core,cli,claude-code-plugin}/stryker.config.mjs` — `packageManager: 'pnpm'` + explicit `plugins: ['@stryker-mutator/jest-runner']`.
- `packages/{parser,core,cli,claude-code-plugin}/package.json` — declare `@stryker-mutator/{core,jest-runner}` as devDeps (pnpm isolated layout).
- `scripts/e2e-entrypoint.sh`, `e2e-shell-entrypoint.sh`, `e2e-codex-shell-entrypoint.sh` — see Task 10.
- Per-package `package.json` — also if Task 11 finds undeclared deps.
- `README.md` / `CONTRIBUTING.md` / contributor docs — install instructions (pnpm v11).

Files deleted:
- `package-lock.json` (replaced by `pnpm-lock.yaml`).
- `site/package-lock.json` (dead npm lockfile; `site` is now a pnpm workspace member).

---

## Task 1: Create a feature worktree and pin pnpm via Corepack

**Files:**
- Create: `.worktrees/issue-446-pnpm/` (worktree)

- [ ] **Step 1: Create the worktree from main**

Run from the main checkout:

```bash
git -C "$(git rev-parse --show-toplevel)" worktree add -b issue-446-pnpm .worktrees/issue-446-pnpm main
cd "$(git rev-parse --show-toplevel)/.worktrees/issue-446-pnpm"
```

Expected: `Preparing worktree (new branch 'issue-446-pnpm')`. Do NOT run `npm install` — we are switching package managers.

- [ ] **Step 2: Enable Corepack and confirm pnpm is reachable**

```bash
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm --version
```

Expected: prints `11.7.0` (or the pinned version). If `corepack` is missing, install Node ≥24 which bundles it. Record the exact version you activated — it must match the `packageManager` field in Task 2.

- [ ] **Step 3: Commit the empty starting point**

No file changes yet; this step is a no-op marker. Proceed to Task 2.

---

## Task 2: Add pnpm workspace declaration and `packageManager` field

**Files:**
- Create: `pnpm-workspace.yaml`
- Modify: `package.json` (root) — remove `workspaces`, add `packageManager`

- [ ] **Step 1: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
  - "site"
```

- [ ] **Step 2: Remove the `workspaces` key from root `package.json`**

Delete these lines:

```json
  "workspaces": [
    "packages/*",
    "site"
  ],
```

(pnpm uses `pnpm-workspace.yaml`, not the `workspaces` field. Leaving it is harmless to pnpm but misleading — remove it.)

- [ ] **Step 3: Add `packageManager` to root `package.json`**

Add a top-level field (place it next to `"private": true`). Use the exact version activated in Task 1:

```json
  "packageManager": "pnpm@11.7.0",
```

- [ ] **Step 4: Verify pnpm recognizes the workspace**

```bash
pnpm -r exec node -e "console.log(process.env.npm_package_name)"
```

Expected: lists all 6 workspace package names (parser, core, cli, mcp, claude-code-plugin, site) without an install. If it errors about no projects found, the YAML globs are wrong.

- [ ] **Step 5: Commit**

```bash
git add pnpm-workspace.yaml package.json
git commit -m "build(pnpm): add pnpm-workspace.yaml and packageManager field"
```

---

## Task 3: Move security `overrides` to `pnpm-workspace.yaml`

**Files:**
- Modify: `package.json` (root) — remove the `pnpm.overrides` block + `"//overrides"` comment
- Modify: `pnpm-workspace.yaml` — add the `overrides:` map

**Why first:** pnpm 11 ignores **both** the top-level `overrides` key and the `pnpm.overrides` field in `package.json`. Overrides now live in `pnpm-workspace.yaml`. If we install before moving them, the security pins (devalue, brace-expansion, esbuild, postcss, qs, yaml, etc.) silently stop applying. Move the block before the first `pnpm install`.

- [ ] **Step 1: Add the `overrides:` map to `pnpm-workspace.yaml`**

pnpm uses a **flat** map and expresses scoping with the `parent>child` selector syntax (npm's nested `"parent": { "child": "version" }` objects are **not** supported and error out). Blanket (unscoped) pins are plain keys. Add, with the GHSA rationale carried over as comments:

```yaml
# Security overrides for transitive deps — scoped by consumer where possible, remove
# when upstream updates. pnpm 11 no longer reads the `pnpm.overrides` field from
# package.json; overrides live here. Flat `parent>child` selectors target transitive deps.
# (Keep the per-pin GHSA rationale comments — devalue sparse-array DoS, brace-expansion
# range DoS, esbuild dev-server, postcss XSS, qs DoS, yaml DoS, MCP SDK hono/node-server/
# rate-limit, astro svgo Billion Laughs, test-exclude minimatch ReDoS.)
overrides:
  lodash: "^4.17.23"
  flatted: "^3.4.0"
  devalue: "^5.8.1"
  brace-expansion: "^5.0.6"
  qs: "^6.15.2"
  "@modelcontextprotocol/sdk>hono": "^4.12.21"
  "@modelcontextprotocol/sdk>@hono/node-server": "^1.19.13"
  "@modelcontextprotocol/sdk>express-rate-limit": "^8.5.2"
  "@hono/node-server>hono": "^4.12.21"
  "express-rate-limit>ip-address": "^10.1.1"
  "astro>esbuild": "^0.28.1"
  "astro>svgo": "^4.0.1"
  "vite>esbuild": "^0.28.1"
  "vite>postcss": "^8.5.10"
  "tsx>esbuild": "^0.28.1"
  "yaml-language-server>yaml": "^2.8.3"
  "test-exclude>minimatch": "^3.1.3"
```

All 17 entries must match `main`'s `overrides` values **byte-for-byte** so the lockfile's recorded overrides hash does not churn.

- [ ] **Step 2: Remove the old block from `package.json`**

Delete the entire `"pnpm": { "overrides": { ... } }` field **and** the long `"//overrides": "..."` comment string above it. The rationale now lives as comments in `pnpm-workspace.yaml`.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-workspace.yaml
git commit -m "build(pnpm): move security overrides to pnpm-workspace.yaml"
```

---

## Task 4: Generate `pnpm-lock.yaml` and delete `package-lock.json`

**Files:**
- Create: `pnpm-lock.yaml`
- Delete: `package-lock.json`

- [ ] **Step 1: Import the existing lockfile to preserve resolved versions**

```bash
pnpm import
```

Expected: reads `package-lock.json` and writes `pnpm-lock.yaml` with the same resolved versions. This minimizes version drift vs. a cold resolve. If `pnpm import` is unavailable or errors, skip to Step 2 (a fresh resolve is acceptable; it just may bump some transitive versions).

- [ ] **Step 2: Run a full install to materialize and reconcile the lockfile**

```bash
pnpm install
```

Expected: completes and writes/updates `pnpm-lock.yaml`. **Do not** pass `--frozen-lockfile` here (we are intentionally generating it). Note any `WARN` lines about unmet peer deps or ignored build scripts — see Step 3 and Task 11.

- [ ] **Step 3: Allowlist dependency build scripts (`strictDepBuilds` is on by default)**

pnpm 11 does not run dependency lifecycle scripts (`postinstall`, etc.) unless allowlisted, and `strictDepBuilds: true` (the default) makes an **unreviewed** build script a **hard install failure** — `pnpm install` exits 1 with `ERR_PNPM_IGNORED_BUILDS`. The `onlyBuiltDependencies` setting from pnpm 9/10 was **removed**; the replacement is the `allowBuilds:` map in `pnpm-workspace.yaml`. Inspect what is blocked:

```bash
pnpm install 2>&1 | grep -iE "ignored build scripts|ERR_PNPM_IGNORED_BUILDS" || echo "none"
```

This repo needs three (native binaries / platform downloads): `esbuild` (astro/vite/tsx), `sharp` (astro image pipeline), `unrs-resolver` (eslint napi resolver). Add to `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  esbuild: true
  sharp: true
  unrs-resolver: true
```

Only allow packages that actually need their build script — do **not** use `dangerouslyAllowAllBuilds: true` (it runs every transitive build script). Re-run `pnpm install` after editing; expect exit 0 with the three postinstalls running.

- [ ] **Step 4: Delete the npm lockfile**

```bash
git rm package-lock.json
```

- [ ] **Step 5: Sanity check the store is hardlinked (the whole point of the issue)**

```bash
du -sh node_modules
pnpm store path
```

Expected: `node_modules` exists; `pnpm store path` prints the global store dir. (Disk savings are validated end-to-end in Task 12.)

- [ ] **Step 6: Commit**

```bash
git add pnpm-lock.yaml pnpm-workspace.yaml package.json
git rm --cached package-lock.json 2>/dev/null || true
git commit -m "build(pnpm): generate pnpm-lock.yaml, remove package-lock.json"
```

---

## Task 5: Convert root `package.json` scripts (`-w <pkg>` → `--filter <name>`)

**Files:**
- Modify: `package.json` (root) — `scripts` block

**Translation rules:**
- `npm run <script> -w packages/<dir>` → `pnpm --filter @rundown-org/<name> <script>`
- `npm run <script> -w site` → `pnpm --filter site <script>`
- `npm run <script> -w packages/a -w packages/b` → `pnpm --filter @rundown-org/a --filter @rundown-org/b <script>`
- `npm run <script>` (same-package, no `-w`) → `pnpm run <script>` (or leave as `npm run` — but standardize on `pnpm run` to avoid invoking npm)
- Trailing `--` passthrough (e.g. `test:mutate:cli`) → pnpm passes args after `--` the same way; keep the `--`.
- `run-s` / `run-p` invocations → **unchanged** (npm-run-all2 binary).

- [ ] **Step 1: Rewrite the `scripts` block**

Replace the entire `"scripts"` object with the following (every `-w` translated; `run-s`/`run-p`/`biome`/`eslint`/`node`/`cspell` lines unchanged):

```json
  "scripts": {
    "worktree": "bash scripts/worktree.sh",
    "build": "pnpm --filter @rundown-org/parser build && pnpm --filter @rundown-org/core build && pnpm --filter @rundown-org/cli build && pnpm --filter @rundown-org/claude-code-plugin build && pnpm --filter @rundown-org/mcp build",
    "build:site": "pnpm --filter site build",
    "build:all": "pnpm run build && pnpm --filter site build",
    "test": "pnpm run test:unit",
    "test:unit": "run-p test:unit:*",
    "test:unit:parser": "pnpm --filter @rundown-org/parser test:unit",
    "test:unit:core": "pnpm --filter @rundown-org/core test:unit",
    "test:unit:cli": "pnpm --filter @rundown-org/cli test:unit",
    "test:unit:plugin": "pnpm --filter @rundown-org/claude-code-plugin test:unit",
    "test:unit:mcp": "pnpm --filter @rundown-org/mcp test:unit",
    "test:unit:scripts": "node --test scripts/__tests__/*.test.mjs",
    "test:integration": "run-p test:integration:*",
    "test:integration:cli": "pnpm --filter @rundown-org/cli test:integration",
    "test:integration:plugin": "pnpm --filter @rundown-org/claude-code-plugin test:integration",
    "test:property": "pnpm --filter @rundown-org/claude-code-plugin --filter @rundown-org/core test:property",
    "test:perf": "pnpm --filter @rundown-org/claude-code-plugin test:perf",
    "test:all": "run-s test:unit test:integration test:property test:perf",
    "test:mutate": "run-s test:mutate:parser test:mutate:core test:mutate:cli test:mutate:plugin",
    "test:mutate:parser": "pnpm --filter @rundown-org/parser test:mutate",
    "test:mutate:core": "pnpm --filter @rundown-org/core test:mutate",
    "test:mutate:cli": "pnpm --filter @rundown-org/cli test:mutate --",
    "test:mutate:cli:dry": "pnpm --filter @rundown-org/cli test:mutate:dry",
    "test:mutate:plugin": "pnpm --filter @rundown-org/claude-code-plugin test:mutate",
    "test:pw": "pnpm --filter site test",
    "test:coverage": "run-p test:coverage:*",
    "test:coverage:parser": "pnpm --filter @rundown-org/parser test:coverage",
    "test:coverage:core": "pnpm --filter @rundown-org/core test:coverage",
    "test:coverage:cli": "pnpm --filter @rundown-org/cli test:coverage",
    "test:coverage:plugin": "pnpm --filter @rundown-org/claude-code-plugin test:coverage",
    "test:coverage:mcp": "pnpm --filter @rundown-org/mcp test:coverage",
    "test:scenarios:raw": "node scripts/test-scenarios.mjs",
    "test:scenario-suites:raw": "node scripts/test-scenario-suites.mjs",
    "test:scenarios": "pnpm run build && pnpm run test:scenarios:raw",
    "test:scenario-suites": "pnpm run build && pnpm run test:scenario-suites:raw",
    "test:scenarios:all": "pnpm run build && run-s test:scenarios:raw test:scenario-suites:raw",
    "format": "biome format --write .",
    "check:format": "biome check --formatter-enabled=true --linter-enabled=false .",
    "check:spell": "cspell --no-progress --no-must-find-files .",
    "check:lint:fast": "biome lint .",
    "check:lint:typed": "eslint .",
    "check:types": "run-p check:types:core check:types:parser check:types:plugin check:types:cli check:types:mcp",
    "check:types:core": "pnpm --filter @rundown-org/core check:types",
    "check:types:parser": "pnpm --filter @rundown-org/parser check:types",
    "check:types:plugin": "pnpm --filter @rundown-org/claude-code-plugin check:types",
    "check:types:cli": "pnpm --filter @rundown-org/cli check:types",
    "check:types:mcp": "pnpm --filter @rundown-org/mcp check:types",
    "fix:lint:fast": "biome lint --write .",
    "fix:lint:typed": "eslint . --fix",
    "fix:lint": "pnpm run fix:lint:fast && pnpm run fix:lint:typed",
    "check:complexity": "run-p check:complexity:*",
    "check:complexity:biome": "biome lint --only=complexity/noExcessiveCognitiveComplexity .",
    "check:complexity:eslint": "eslint --config eslint.complexity.config.js .",
    "lint": "pnpm run check:lint:fast && pnpm run check:lint:typed",
    "verify": "run-s check:format check:spell check:lint:fast check:lint:typed build check:types check:docs:cli-help check:docs:xstate-version test",
    "cli": "node packages/cli/dist/cli.js",
    "docs:cli-help": "pnpm --filter @rundown-org/parser --filter @rundown-org/core --filter @rundown-org/cli build && node packages/cli/dist/scripts/gen-cli-help.js",
    "check:docs:cli-help": "pnpm --filter @rundown-org/parser --filter @rundown-org/core --filter @rundown-org/cli build && node packages/cli/dist/scripts/gen-cli-help.js --check",
    "check:docs:xstate-version": "node scripts/check-xstate-doc-version.mjs",
    "changeset": "changeset",
    "version": "changeset version",
    "release": "changeset publish",
    "prepare": "husky || true",
    "verify:claude": "./scripts/verify-install.sh local",
    "verify:claude:npm": "./scripts/verify-install.sh npm",
    "test:e2e": "./scripts/run-e2e.sh",
    "test:e2e:build": "./scripts/build-e2e.sh",
    "test:e2e:claude": "./scripts/e2e-shell.sh --agent claude",
    "test:e2e:codex": "./scripts/e2e-shell.sh --agent codex",
    "test:e2e:shell": "./scripts/e2e-shell.sh --agent claude"
  },
```

> **Ordering note for `build`:** pnpm `--filter` can topo-order with `pnpm -r --workspace-concurrency=1`, but the existing script hard-codes parser→core→cli→plugin→mcp order, which is correct and explicit. Keep the explicit chain rather than relying on `-r` topo-sort — it preserves the current, known-good build order.

- [ ] **Step 2: Verify a representative leaf script runs under pnpm**

```bash
pnpm run build
```

Expected: all 5 packages build (tsc + post-build steps). If a package fails with a missing-module error for a third-party package, that is a phantom dependency — note it for Task 11; do not paper over it here.

- [ ] **Step 3: Verify a parallel group runs**

```bash
pnpm run check:types
```

Expected: `run-p` fans out to all 5 `check:types:*`, each invoking `pnpm --filter ... check:types`. All pass (assuming Task 11 deps are clean).

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "build(pnpm): translate root scripts from npm -w to pnpm --filter"
```

---

## Task 6: Move pnpm settings from `.npmrc` to `pnpm-workspace.yaml`

**Files:**
- Modify: `.npmrc` — strip to auth/registry-only
- Modify: `pnpm-workspace.yaml` — add the settings as camelCase keys

**Why:** pnpm 11 reads **only auth/registry settings** from `.npmrc`. Everything else must move to `pnpm-workspace.yaml` as camelCase. The most damaging symptom of missing this is the empty `NODE_OPTIONS`: without `--experimental-vm-modules`, every ESM Jest suite fails to parse (`Unexpected token 'export'`).

- [ ] **Step 1: Add the settings to `pnpm-workspace.yaml`**

```yaml
# pnpm 11 reads only auth/registry from .npmrc; every other setting lives here in camelCase.
#   nodeOptions: Jest ESM (--experimental-vm-modules). Stryker configs duplicate this via
#     testRunnerNodeArgs because Stryker spawns child processes that don't inherit it.
#   link/preferWorkspacePackages: link local workspace packages instead of the registry —
#     npm auto-linked "*" deps; pnpm only links them with these enabled.
#   autoInstallPeers: keep peers resolving like npm 7+.
nodeOptions: --experimental-vm-modules
linkWorkspacePackages: true
preferWorkspacePackages: true
autoInstallPeers: true
```

> **Do NOT add `shamefullyHoist: true` or `nodeLinker: hoisted`.** Either re-creates npm's flat layout and throws away the correctness benefit (strict dep boundaries) and partially the disk benefit. Last-resort escape hatch only if Task 11 uncovers an unfixable upstream phantom-dep; if you reach for one, document why here and flag it in the PR.

- [ ] **Step 2: Strip `.npmrc` to auth/registry-only**

Remove every active key from `.npmrc` (they are now in `pnpm-workspace.yaml`). Leave a comment block noting that pnpm 11 reads only auth/registry here, that pnpm settings live in `pnpm-workspace.yaml`, and that strict layout is intentional (no `shamefully-hoist` / `node-linker=hoisted`).

- [ ] **Step 3: Re-install and confirm the flag is applied**

```bash
pnpm install
pnpm exec bash -lc 'echo NODE_OPTIONS=$NODE_OPTIONS'
```

Expected: install succeeds (no lockfile change beyond peer-dep additions); `NODE_OPTIONS=--experimental-vm-modules` is printed (proving the `.npmrc`→yaml move worked).

- [ ] **Step 4: Commit**

```bash
git add .npmrc pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "build(pnpm): move pnpm settings from .npmrc to pnpm-workspace.yaml"
```

---

## Task 7: Update the worktree helper script

**Files:**
- Modify: `scripts/worktree.sh`

- [ ] **Step 1: Replace the npm install with pnpm install**

Change the install block. Current:

```bash
echo "→ Installing dependencies in $dir"
npm --prefix "$dir" install

echo "✓ Worktree ready: $dir"
echo "  cd $dir && npm run build"
```

New (pnpm has no `--prefix`; use `-C <dir>` or `--dir <dir>`):

```bash
echo "→ Installing dependencies in $dir"
pnpm -C "$dir" install

echo "✓ Worktree ready: $dir"
echo "  cd $dir && pnpm run build"
```

- [ ] **Step 2: Update the header comment**

In the top comment block, change the two references from `npm install` to `pnpm install` and the explanation of the footgun (it now says the worktree typechecks against an unbuilt core after `npm run build` — change to `pnpm run build`). Keep the substance; just swap the command names.

- [ ] **Step 3: Update the `scripts/__tests__` expectation if it asserts on worktree.sh**

```bash
grep -rn "worktree" scripts/__tests__/ || echo "no worktree test assertions"
```

If a test asserts the script contains `npm`, update the assertion to `pnpm`. If none, skip.

- [ ] **Step 4: Smoke-test the helper end to end**

```bash
pnpm run worktree -- migration-smoke main
ls .worktrees/migration-smoke/node_modules >/dev/null && echo "deps present"
git worktree remove .worktrees/migration-smoke --force
git branch -D migration-smoke
```

Expected: worktree created, `pnpm -C` installs (hardlinked, fast), `deps present` prints, cleanup succeeds.

- [ ] **Step 5: Commit**

```bash
git add scripts/worktree.sh scripts/__tests__/ 2>/dev/null
git commit -m "build(pnpm): worktree.sh uses pnpm install"
```

---

## Task 8: Update the shared CI composite action (covers all of `ci.yml`)

**Files:**
- Modify: `.github/actions/setup-node-deps/action.yml`

**Repo convention reminder:** GitHub Actions are pinned by commit SHA with a `# vX` comment. When adding `pnpm/action-setup`, look up the SHA for the desired tag and pin it the same way. **Do not use a bare tag.** (CLAUDE.md "CI / Workflow Conventions".)

- [ ] **Step 1: Rewrite the composite action**

Replace the contents with:

```yaml
name: Setup Node dependencies
description: Install Node.js and pnpm dependencies with the shared CI defaults.

inputs:
  node-version:
    description: Node.js version to install.
    required: true

runs:
  using: composite
  steps:
    - name: Install pnpm
      uses: pnpm/action-setup@<SHA>  # v4 — look up and pin the commit SHA for v4

    - name: Use Node.js ${{ inputs.node-version }}
      uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e  # v6
      with:
        node-version: ${{ inputs.node-version }}
        cache: pnpm

    - name: Install dependencies
      shell: bash
      run: pnpm install --frozen-lockfile
```

> Notes:
> - `pnpm/action-setup` must run **before** `setup-node` so that `cache: pnpm` can find pnpm. Alternatively, omit `pnpm/action-setup` and rely on Corepack via `packageManager` — but `pnpm/action-setup` + `cache: pnpm` is the documented, cache-friendly path; prefer it.
> - `--frozen-lockfile` is pnpm's `npm ci` equivalent (fails if the lockfile is out of date). It replaces `npm ci --prefer-offline --no-audit --fund=false`; pnpm has no `--fund`/`--audit` noise, and the store already gives offline-ish behavior.
> - Look up the real `pnpm/action-setup` v4 SHA and replace `<SHA>`.

- [ ] **Step 2: Verify the YAML parses and references resolve**

```bash
grep -n "pnpm/action-setup@" .github/actions/setup-node-deps/action.yml
```

Expected: shows a 40-char SHA with `# v4` comment (not `<SHA>`).

- [ ] **Step 3: Commit**

```bash
git add .github/actions/setup-node-deps/action.yml
git commit -m "ci(pnpm): setup-node-deps uses pnpm install --frozen-lockfile"
```

---

## Task 9: Update the three workflows that bypass the composite action

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/mutation.yml`
- Modify: `.github/workflows/plugin-smoke-test.yml`

These call `actions/setup-node` + `npm ci` directly. Add `pnpm/action-setup` before `setup-node`, switch `cache: 'npm'` → `cache: 'pnpm'`, and `npm ci` → `pnpm install --frozen-lockfile`.

- [ ] **Step 1: `release.yml`**

Before the `Setup Node.js` step, insert:

```yaml
      - name: Install pnpm
        uses: pnpm/action-setup@<SHA>  # v4 — pin the commit SHA
```

In the `Setup Node.js` step change `cache: 'npm'` → `cache: 'pnpm'` (keep `node-version-file: .nvmrc` and `registry-url`). Then:
- `Install Dependencies` step: `run: npm ci` → `run: pnpm install --frozen-lockfile`
- `Build Packages` step: `run: npm run build` → `run: pnpm run build`
- `Run Tests` step: `run: npm test` → `run: pnpm test`
- Changesets action `publish:` value: `npm run release -- --provenance` → `pnpm release -- --provenance`

> **Publishing note:** `changeset publish` runs `pnpm publish` under the hood when `packageManager` is pnpm. `--provenance` is supported by pnpm publish. `registry-url` + `NODE_AUTH_TOKEN` still authenticate via the generated `.npmrc`. The published artifacts and registry (npmjs.org) are unchanged.

- [ ] **Step 2: `mutation.yml`**

Insert before the `setup-node` step (respect the existing `if: ${{ env.RUN_PACKAGE == 'true' }}` guard — add the same guard to the pnpm step):

```yaml
      - uses: pnpm/action-setup@<SHA>  # v4 — pin the commit SHA
        if: ${{ env.RUN_PACKAGE == 'true' }}
```

In the `setup-node` step change `cache: 'npm'` → `cache: 'pnpm'`. Then:
- `Install dependencies`: `npm ci` → `pnpm install --frozen-lockfile`
- `Build`: `npm run build` → `pnpm run build`

- [ ] **Step 3: `plugin-smoke-test.yml`**

This file has multiple jobs, each with `setup-node` + `npm ci` + `npm run build` + a `test:*` script. For **each** job:
- Insert `- uses: pnpm/action-setup@<SHA>  # v4` before its `setup-node` step.
- `cache: npm` → `cache: pnpm` (if present in the `with:` of setup-node).
- `npm ci` → `pnpm install --frozen-lockfile`
- `npm run build` → `pnpm run build`
- `npm run test:smoke` → `pnpm run test:smoke`
- `npm run test:perf` → `pnpm run test:perf`
- `npm run test:coverage` → `pnpm run test:coverage`

```bash
grep -n "npm \|cache: " .github/workflows/plugin-smoke-test.yml
```

Expected after edits: no `npm ci`/`npm run` remain; all caches say `pnpm`.

- [ ] **Step 4: Verify no stray `npm ci`/`npm run` left in any workflow**

```bash
grep -rn "npm ci\|npm run\|cache: 'npm'\|cache: npm" .github/workflows/ .github/actions/ || echo "clean"
```

Expected: `clean` (Docker-internal `npm install -g` is in `scripts/`, not workflows — handled in Task 10).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml .github/workflows/mutation.yml .github/workflows/plugin-smoke-test.yml
git commit -m "ci(pnpm): migrate release, mutation, plugin-smoke-test workflows to pnpm"
```

---

## Task 10: Docker / e2e scripts — migrate dev installs, keep consumer-simulation installs on npm

**Files:**
- Inspect/Modify (case-by-case): `scripts/e2e-entrypoint.sh`, `scripts/e2e-shell-entrypoint.sh`, `scripts/e2e-codex-shell-entrypoint.sh`
- Do NOT change: `scripts/Dockerfile.verify` global tarball/registry installs, `scripts/docker-entrypoint.sh` (`npm install -g @rundown-org/cli ...`)

**Decision rule:** If an install reproduces *how an end user installs the published packages* (`npm install -g <tarball>` or `npm install -g @rundown-org/cli` from the registry), it **stays npm** — that is the behavior under test. If an install is *building the repo's own dev workspace from source*, it migrates to pnpm.

- [ ] **Step 1: Classify each `npm install` in scripts**

```bash
grep -rn "npm install\|npm ci\|npm run\|npm --prefix" scripts/ | grep -v node_modules
```

For each hit, decide: consumer-simulation (keep) vs dev-workspace (migrate). Expected classifications:
- `scripts/Dockerfile.verify` `npm install -g /tmp/tarballs/*.tgz` → **keep** (consumer install).
- `scripts/docker-entrypoint.sh` `npm install -g @rundown-org/cli @rundown-org/claude-code-plugin` → **keep** (consumer install).
- `scripts/e2e-*-entrypoint.sh` `npm install --ignore-scripts` → **inspect** (Step 2).
- `scripts/verify-install.sh` `npm run build` and `scripts/build-e2e.sh` `npm run build` → **migrate** to `pnpm run build` (these build the dev workspace before packing).

- [ ] **Step 2: Inspect what the e2e entrypoints install**

```bash
sed -n '1,60p' scripts/e2e-entrypoint.sh
sed -n '1,60p' scripts/e2e-shell-entrypoint.sh
sed -n '1,60p' scripts/e2e-codex-shell-entrypoint.sh
```

Determine the target of `npm install --ignore-scripts`:
- If it installs **the test-app fixture's** own deps (a standalone consumer-style app), keep it as `npm install` — the fixture is a consumer, not our workspace.
- If it installs **the rundown workspace** from source, change to `pnpm install --frozen-lockfile` and ensure `pnpm` is available in the image (add a Corepack enable / `pnpm/action-setup` equivalent: `RUN corepack enable` in the relevant Docker stage, or `npm install -g pnpm@11.7.0`).

Document the decision for each file inline in this plan's PR description.

- [ ] **Step 3: Migrate the dev-workspace build commands**

In `scripts/verify-install.sh` and `scripts/build-e2e.sh`, change `npm run build` → `pnpm run build`. These run on the host/builder against the repo source. Ensure the host has pnpm (Corepack). If `scripts/build-e2e.sh` runs inside a container, add pnpm provisioning to that stage of `Dockerfile.verify` first.

- [ ] **Step 4: Update `scripts/__tests__` assertions that pin command strings**

```bash
grep -rn "npm install\|npm run\|npm ci" scripts/__tests__/
```

For each assertion (e.g. `e2e-codex-harness.test.mjs` asserts on dockerfile/CI command strings, `scenario-script-timings.test.mjs` asserts `run: npm run test:scenarios:raw`):
- Update assertions for commands we migrated (CI `npm run` → `pnpm run`).
- Leave assertions for consumer-install commands (`npm install -g @openai/codex@...`, `npm install -g @rundown-org/cli`) unchanged.
Run the script tests:

```bash
pnpm run test:unit:scripts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/
git commit -m "build(pnpm): migrate dev-workspace installs to pnpm; keep consumer-simulation installs on npm"
```

---

## Task 11: Resolve phantom dependencies (the real risk) — run-fix-repeat loop

**Files:**
- Modify (as discovered): `packages/*/package.json` `dependencies` / `devDependencies`

**Why:** pnpm's non-flat `node_modules` only exposes a package's *declared* deps. Any module that imports a transitive dep it never declared (npm hid this via flat hoisting) will fail at build/test/runtime. This is the most likely source of breakage and must be fixed by *declaring the dep*, not by hoisting.

- [ ] **Step 1: Run the full local verify and capture failures**

```bash
pnpm install --frozen-lockfile
pnpm run verify 2>&1 | tee /tmp/pnpm-verify.log
```

Expected first pass: may fail. Grep for the signature of a phantom dep:

```bash
grep -iE "cannot find module|module not found|cannot resolve|ERR_MODULE_NOT_FOUND" /tmp/pnpm-verify.log
```

- [ ] **Step 2: For each missing module, find which workspace package imports it and declare it there**

For a reported missing module `<dep>` in `packages/<pkg>`:

```bash
grep -rn "from '<dep>'\|require('<dep>')\|from \"<dep>\"" packages/<pkg>/src packages/<pkg>/__tests__
```

Then add `<dep>` to that package's own `package.json` (`dependencies` if used in `src/`, `devDependencies` if only in tests/build):

```bash
pnpm --filter @rundown-org/<pkg> add <dep>@<version-matching-root-resolution>
```

Use the version already resolved in `pnpm-lock.yaml` to avoid drift. Repeat for every missing module.

- [ ] **Step 3: Confirm the security overrides actually applied**

```bash
pnpm why devalue brace-expansion esbuild postcss qs 2>&1 | grep -E "devalue|brace-expansion|esbuild|postcss|qs"
pnpm list -r --depth Infinity devalue brace-expansion esbuild postcss qs yaml 2>/dev/null | sort -u
```

Expected: pinned versions match the `overrides` from Task 3 (e.g. `devalue ^5.8.1`, `esbuild ^0.28.1`). If any resolve below the pin, the override syntax didn't take — confirm the `overrides:` map is in `pnpm-workspace.yaml` (not `package.json`) and uses flat `parent>child` keys (Task 3 Step 1), then re-install.

- [ ] **Step 4: Re-run verify until green**

```bash
pnpm run verify 2>&1 | tee /tmp/pnpm-verify.log
```

Repeat Steps 2–3 until `verify` exits 0. Each newly declared dep is a real correctness fix (the code always needed it); commit them together with a clear message.

- [ ] **Step 5: Commit**

```bash
git add packages/*/package.json pnpm-lock.yaml
git commit -m "build(pnpm): declare previously-phantom dependencies surfaced by strict pnpm layout"
```

---

## Task 12: Update Stryker and Changesets package-manager config

**Files:**
- Modify: `packages/parser/stryker.config.mjs`, `packages/core/stryker.config.mjs`, `packages/cli/stryker.config.mjs`, `packages/claude-code-plugin/stryker.config.mjs`
- Modify: `.changeset/config.json`

- [ ] **Step 1: Switch Stryker `packageManager` and add explicit plugins in all 4 configs**

In each `stryker.config.mjs`, change `packageManager: 'npm'` → `packageManager: 'pnpm'`, and add an explicit plugins list:

```js
  packageManager: 'pnpm',
  // pnpm's isolated layout breaks Stryker's default '@stryker-mutator/*' auto-discovery
  // glob (it resolves relative to stryker-core's own node_modules, where jest-runner is
  // not a sibling). Naming the plugin makes Stryker resolve it from this package.
  plugins: ['@stryker-mutator/jest-runner'],
```

Leave everything else (jest config, `testRunnerNodeArgs: ['--experimental-vm-modules']`, thresholds) unchanged. `testRunnerNodeArgs` is independent of the `.npmrc`→yaml move, so the ESM flag keeps working for Stryker's child processes.

- [ ] **Step 1b: Declare the Stryker plugins as devDeps**

Add `@stryker-mutator/core` and `@stryker-mutator/jest-runner` to the `devDependencies` of each of the four packages (`parser`, `core`, `cli`, `claude-code-plugin`). Under pnpm's strict layout Stryker can only resolve plugins declared in the consuming package.

- [ ] **Step 2: Switch Changesets `packageManager`**

In `.changeset/config.json`:

```json
  "packageManager": "npm"
```

→

```json
  "packageManager": "pnpm"
```

- [ ] **Step 3: Verify a dry mutation run starts under pnpm**

```bash
pnpm run test:mutate:cli:dry
```

Expected: Stryker performs its dry run without a package-manager error. (Full mutation runs are slow; the dry run validates wiring.)

- [ ] **Step 4: Commit**

```bash
git add packages/*/stryker.config.mjs .changeset/config.json
git commit -m "build(pnpm): point Stryker and Changesets at pnpm"
```

---

## Task 13: Update contributor docs and CLAUDE.md

**Files:**
- Modify: `README.md` (contributor/dev sections)
- Modify: `CLAUDE.md` (Development Commands section references npm)
- Modify: any `docs/**` referencing `npm install` / `npm run` for **dev** workflows

Do NOT change consumer-facing `npm install -g @rundown-org/cli` — that path is unchanged.

- [ ] **Step 1: Find dev-side npm references in docs**

```bash
grep -rn "npm install\|npm run\|npm ci\|npm test" README.md CLAUDE.md docs/ | grep -v "npm install -g @rundown-org"
```

- [ ] **Step 2: Update them to pnpm**

For each dev command, translate: `npm install` → `pnpm install`, `npm run X` → `pnpm run X` / `pnpm X`, `npm test` → `pnpm test`. Add a one-line prerequisite note where contributors first clone:

```markdown
This repo uses **pnpm** (via Corepack). Enable it once: `corepack enable`.
```

In `CLAUDE.md`, the long "Development Commands" code block lists `npm run build`, `npm test`, etc. — translate the dev commands to `pnpm run …`. Keep the published-install line (`npm install -g @rundown-org/cli`) as npm.

- [ ] **Step 3: Verify no dev-side npm references remain**

```bash
grep -rn "npm run\|npm ci\|npm test" README.md CLAUDE.md docs/ | grep -v "npm install -g @rundown-org" || echo "clean"
```

Expected: `clean` (or only intentional consumer-install mentions).

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md docs/
git commit -m "docs(pnpm): update contributor instructions for pnpm"
```

---

## Task 14: Final full verification (acceptance criteria)

**Files:** none (validation only)

- [ ] **Step 1: Cold install from scratch (lockfile is authoritative)**

```bash
rm -rf node_modules packages/*/node_modules site/node_modules
pnpm install --frozen-lockfile
```

Expected: succeeds with no lockfile change. If `--frozen-lockfile` errors that the lockfile is out of date, run `pnpm install` (no flag), commit the updated `pnpm-lock.yaml`, and retry.

- [ ] **Step 2: Full verify suite green**

```bash
pnpm run verify
```

Expected: exits 0 — format, spell, lint (biome + eslint), build, typecheck, cli-help/xstate doc checks, and all unit tests pass. This is acceptance criterion #1.

- [ ] **Step 3: Broader test tiers**

```bash
pnpm run test:integration
pnpm run test:property
```

Expected: PASS.

- [ ] **Step 4: Validate the worktree disk win (acceptance criterion #2)**

```bash
git -C "$(git rev-parse --show-toplevel)" worktree add -b pnpm-disk-check .worktrees/pnpm-disk-check main
cd .worktrees/pnpm-disk-check
corepack enable
time pnpm install
du -sh node_modules
```

Expected: install completes in **seconds** (hardlinks, not downloads); the *incremental* disk cost is near-zero because packages hardlink into the shared store. Compare `pnpm store path` size vs. per-worktree `node_modules`. Clean up:

```bash
cd -
git worktree remove .worktrees/pnpm-disk-check --force
git branch -D pnpm-disk-check
```

- [ ] **Step 5: e2e Docker path (acceptance criterion #3)**

```bash
pnpm run test:e2e:build
pnpm run test:e2e
```

Expected: Docker image builds (consumer tarball installs still npm, dev build steps pnpm) and the e2e plugin workflow passes. If Docker is unavailable locally, mark this for CI verification and note it in the PR.

- [ ] **Step 6: Push and open PR for CI to validate the workflow changes**

```bash
git push -u origin issue-446-pnpm
gh pr create --fill --base main --title "build(pnpm): migrate npm → pnpm for cheap worktrees (closes #446)"
```

Expected: CI (`ci.yml`, `mutation.yml`, `plugin-smoke-test.yml`) is green on pnpm. Workflow changes can only be fully validated in CI — watch the run and fix any pnpm-cache/setup ordering issues there.

---

## Self-Review (completed against issue #446)

**Spec coverage** — every acceptance-criterion and scope checkbox from issue #446 maps to a task:
- Convert `package-lock.json` → `pnpm-lock.yaml` + `pnpm-workspace.yaml` → Tasks 2, 4.
- `packageManager` + corepack bootstrap → Tasks 1, 2.
- Audit root + per-package scripts, translate `-w` → `--filter`, handle `run-s`/`run-p` → Task 5 (run-* kept; documented).
- `scripts/worktree.sh` → Task 7.
- CI workflows → Tasks 8, 9.
- Docker images / e2e entrypoints → Task 10 (with the keep-vs-migrate decision rule the issue's checklist omitted).
- Tooling configs (Stryker, Jest resolution, `.bin`/hoisting) → Task 12 (Stryker), Task 11 (phantom deps), with the verified fact that Jest workspace resolution is moduleNameMapper-based and unaffected.
- Verify green + e2e Docker → Task 14.
- Contributor docs / consumer guidance unchanged → Task 13.
- Acceptance: full verify green (Task 14 Step 2), cheap worktree (Task 14 Step 4), CI+e2e green (Task 14 Steps 5–6).

**Placeholder scan:** The only intentional `<SHA>` placeholders are for `pnpm/action-setup` (Tasks 8, 9) — these REQUIRE a real SHA lookup per the repo's SHA-pinning convention and cannot be hard-coded blind in a plan. Every other step has concrete commands/content.

**Type/name consistency:** Package filter names (`@rundown-org/parser|core|cli|mcp|claude-code-plugin`, `site`) are used consistently across Tasks 5, 9, 11. Pnpm flags (`--filter`, `--frozen-lockfile`, `-C`) used consistently.

**Open risk explicitly carried:** Task 11 is the loop where unknowns surface (undeclared transitive deps). It is structured as run-fix-repeat with a hard "don't `shamefully-hoist`" guard (Task 6) so the migration fixes correctness rather than masking it.

---

## Execution divergences (PR #456)

The plan's structure was correct, but execution surfaced gaps a static read of the tree could not predict. Recorded here so the next package-manager change starts from reality, not the original assumptions.

| # | Plan assumed | Reality | Resolution |
|---|--------------|---------|------------|
| 1 | Workspace deps declared `"*"` would auto-link locally (as npm does) | pnpm resolved `"*"` to **registry downloads**, breaking the build with stale published source | Added `link-workspace-packages=true` + `prefer-workspace-packages=true` to `.npmrc` **and** a clean reinstall (the setting doesn't re-resolve an existing lockfile). Kept `"*"` specs — published metadata stays byte-identical (no `workspace:*`). |
| 2 | `overrides` → `pnpm.overrides` is a straight move | pnpm 9 **rejects npm's nested-object** override form (`pref.startsWith is not a function` during `pnpm import`) | Rewrote every entry to pnpm's flat `"parent>child": "ver"` selector; blanket pins stay plain `"pkg": "ver"` keys. All 17 entries verified 1:1 against `main`. |
| 3 | CI commands live in the composite action + 3 bypassing workflows | `ci.yml` also had its **own inline** `npm -w` / `npm run` / `npx` step commands the plan's task list didn't enumerate | Translated ci.yml's inline steps too (core test, site snapshot/test, `playwright install`, `stryker run`). |
| 4 | `npm pack --workspace <pkg>` → pnpm equivalent | `pnpm pack` has **no workspace selector** (`--filter`/`--workspace` rejected) | Pack each package from inside its dir into an absolute `dist/`: `( cd packages/$pkg && pnpm pack --pack-destination "$abs" )`. Tarball names unchanged (`rundown-org-*-*.tgz`). |
| 5 | Stryker just needs `packageManager: 'pnpm'` | pnpm's isolated layout **breaks Stryker's `@stryker-mutator/*` auto-discovery glob** (`Cannot find TestRunner plugin "jest"`) | Declared `@stryker-mutator/{core,jest-runner}` as devDeps in each package **and** added explicit `plugins: ['@stryker-mutator/jest-runner']` to each `stryker.config.mjs`. |

**Test-harness regression (not a product defect).** 29 `scenario-suite` tests failed under pnpm with `RUNBOOK_NOT_FOUND` (passed on `main`). Root cause: `graceful-fs` (transitive via Jest) memoizes `process.cwd()` in Jest's **worker realm** — where `node:path` reads its implicit base — and pnpm's symlinked layout freezes that memo, so `path.resolve('rel')` stopped tracking the in-process runner's `process.chdir()`. The fix had to run in the worker realm (the sandbox can't reach it): a custom Jest environment (`packages/cli/jest.live-cwd-environment.cjs`) that restores a live `realpathSync.native('.')` cwd. **Test infrastructure only — no production code changed.** Hoisting `graceful-fs` did *not* help (it is not a multiple-copies problem).

**Items the plan's scope missed:**
- `osv-scanner.yml` still triggered on / scanned the deleted `package-lock.json` → silently no-op on lockfile changes. Repointed paths + `--lockfile` to `pnpm-lock.yaml`.
- `site/package-lock.json` left behind as dead cruft (site is now a pnpm member) → removed.
- `**/*.cjs` was missing from the typed-ESLint ignore list (only `*.js` / `*.mjs` were ignored) → added, so config-style `.cjs` files aren't typed-linted.

**Deferred:** full Docker e2e was not run locally — it exercises the consumer-npm install path (unchanged by design) and the only migration-touched part (build→pack) was validated separately; left for CI.

---

## Follow-up: bump pnpm 9.15.0 → 11.7.0

> The tasks above have been **retargeted to pnpm 11.7.0**. PR #456 landed on pnpm 9.15.0; the
> subsequent bump to 11.7.0 crossed the 9 → 10 → 11 boundary and moved several config homes.
> Where the #456 divergence table above mentions `.npmrc` (`link-workspace-packages`,
> `prefer-workspace-packages`, `node-options`) or `package.json` `pnpm.overrides`, those were
> **superseded** by the moves below — pnpm 11 no longer reads them from those locations.

Reproduced each change with real installs; validated end-to-end on 11.7.0 (clean frozen install
exit 0, build, ~7,900 tests green).

| # | pnpm 11 change | Symptom | Resolution |
|---|----------------|---------|------------|
| 1 | `pnpm.overrides` in `package.json` no longer read | Security pins silently dropped | Moved all 17 overrides (flat `parent>child`) + GHSA rationale to `pnpm-workspace.yaml` `overrides:`; removed the `pnpm` field and `"//overrides"` comment from `package.json` |
| 2 | `onlyBuiltDependencies` removed; `strictDepBuilds: true` default → unreviewed build = hard fail | `pnpm install` exits 1 (`ERR_PNPM_IGNORED_BUILDS`) on esbuild/sharp/unrs-resolver | Allowlisted the three via `allowBuilds:` map in `pnpm-workspace.yaml`. Rejected `dangerouslyAllowAllBuilds` (would run all transitive build scripts — supply-chain downgrade) |
| 3 | `.npmrc` is auth/registry-only; other settings must move to `pnpm-workspace.yaml` (camelCase) | `node-options`/`link-`/`prefer-workspace-packages`/`auto-install-peers` ignored | Moved to `pnpm-workspace.yaml` as `nodeOptions`, `linkWorkspacePackages`, `preferWorkspacePackages`, `autoInstallPeers`; stripped `.npmrc` to a comment-only pointer |
| 4 | Consequence of #3: empty `NODE_OPTIONS` → Jest ESM flag missing | All ESM test suites fail to parse (`Unexpected token 'export'`) | Fixed by `nodeOptions: --experimental-vm-modules` (#3). Verified `pnpm exec` reports the flag set |

**Confirmed unaffected by the bump:** Stryker (passes `--experimental-vm-modules` via
`testRunnerNodeArgs`, independent of the `.npmrc`→yaml move; mutation runs don't trip the build
gate), all CI workflows / composite action / Docker / `scripts/*.sh` (pnpm version resolves via
Corepack / `pnpm/action-setup@v4` reading `packageManager` — no version pinned anywhere but
`package.json`), OSV-Scanner (already targets `pnpm-lock.yaml`), and the lockfile
(`lockfileVersion 9.0` is compatible with pnpm 11; frozen install has no churn — do not regenerate).

**Worktree caveat:** validating in a git worktree nested under an npm-based main checkout can let
the parent's `node_modules` leak into resolution (pnpm 11 hoists less than 10). That is a
worktree artifact, not a CI failure — confirm on a clean checkout.
