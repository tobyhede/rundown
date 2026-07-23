# CI & Quality Setup

Reference for replicating Rundown's CI / linting / quality stack in another
TypeScript project.

## Tooling

### Lint & format

| Tool                                                                  | Version                       | Role                                                                                                                                       |
| --------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [Biome](https://biomejs.dev)                                          | 2.4.12                        | Formatter + fast (non-type-aware) linter. Single config (`biome.json`) replaces Prettier + base ESLint rules.                              |
| [ESLint](https://eslint.org)                                          | 10                            | Type-aware lint only — runs `typescript-eslint` `strictTypeCheckedOnly` + `stylisticTypeCheckedOnly` against built `tsconfig.eslint.json`. |
| [`typescript-eslint`](https://typescript-eslint.io)                   | 8                             | Type-checked rules: `explicit-function-return-type`, `consistent-type-imports/exports`, `no-unused-vars` (`_` exception).                  |
| [`eslint-plugin-jsdoc`](https://github.com/gajus/eslint-plugin-jsdoc) | 62                            | TSDoc coverage enforcement on exported symbols (off in test files).                                                                        |
| ESLint complexity config                                              | `eslint.complexity.config.js` | Advisory-only (`warn`): `complexity:15`, `max-lines-per-function:100`, `max-depth:4`, `max-params:4`.                                      |

**Split rationale:** Biome handles fast syntactic/style rules; ESLint owns the
slow type-aware rules. They don't overlap, so you don't fight conflicting
fixers.

### Spell & docs

| Tool                                                                 | Role                                                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [cspell](https://cspell.org) 10                                      | Spell check `src/`, tests, docs, runbooks. Project dictionary at `cspell-dictionary.txt`. |
| [markdownlint-cli2](https://github.com/DavidAnson/markdownlint-cli2) | Markdown lint config exists (`.markdownlint-cli2.yaml`) but is not yet wired to CI.       |

### Tests & coverage

| Tool                                    | Role                                             |
| --------------------------------------- | ------------------------------------------------ |
| Jest                                    | Unit, integration, property tests (per-package). |
| [Stryker](https://stryker-mutator.io) 9 | Mutation testing per package, scheduled weekly.  |
| [Playwright](https://playwright.dev)    | Browser tests for the marketing site.            |
| Codecov                                 | Coverage upload (LCOV from each package).        |

### Security

| Tool                                | Role                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| [CodeQL](https://codeql.github.com) | `javascript-typescript` + `security-extended` queries; PRs + weekly cron.                |
| [OSV-Scanner](https://osv.dev)      | Lockfile vuln scan; lockfile-touching PRs + daily cron. SARIF uploaded to Code Scanning. |
| Dependabot                          | Dependency update PRs (`.github/dependabot.yml`).                                        |

### Pre-commit

| Tool                                                         | Role                                           |
| ------------------------------------------------------------ | ---------------------------------------------- |
| [husky](https://typicode.github.io/husky) 9                  | Manages git hooks.                             |
| [lint-staged](https://github.com/lint-staged/lint-staged) 16 | Runs Biome format + lint on staged files only. |

### Release

| Tool                                                    | Role                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| [Changesets](https://github.com/changesets/changesets)  | Versioning + changelog + npm publish (with provenance).         |
| [npm-run-all2](https://github.com/bcomnes/npm-run-all2) | `run-p` / `run-s` for parallel/sequential script orchestration. |

## npm scripts (gate of truth)

The local equivalent of CI is `pnpm run verify`:

```text
verify = check:format → check:spell → check:lint:fast → check:lint:typed → build → check:types → test
```

Per-step scripts:

| Script                | Command                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `check:format`        | `biome check --formatter-enabled=true --linter-enabled=false .`                                                             |
| `check:spell`         | `cspell --no-progress --no-must-find-files .`                                                                               |
| `check:lint:fast`     | `biome lint .`                                                                                                              |
| `check:lint:typed`    | `eslint .`                                                                                                                  |
| `check:complexity`    | parallel: `biome lint --only=complexity/noExcessiveCognitiveComplexity .` + `eslint --config eslint.complexity.config.js .` |
| `check:types`         | parallel: `tsc --noEmit` per package                                                                                        |
| `fix:lint`            | `biome lint --write .` then `eslint . --fix`                                                                                |
| `test:coverage`       | parallel per-package coverage                                                                                               |
| `test:mutate`         | sequential Stryker per package                                                                                              |
| `test:mutate:cli`     | CLI package Stryker run; forwards extra Stryker flags after `--`                                                            |
| `test:mutate:cli:dry` | CLI package Stryker/Jest dry run; validates setup without executing mutants                                                 |

Scoped CLI mutation checks should use forwarded Stryker flags instead of
permanent per-file npm scripts:

```bash
pnpm run test:mutate:cli -- --mutate src/services/variable-discovery.ts --testFiles __tests__/services/variable-discovery.test.ts
```

## CI Workflows

All actions are SHA-pinned with a version comment for supply-chain safety. Node
version comes from `.nvmrc` or hardcoded `24`.

### `ci.yml` — main pipeline

Triggers: push to `main`, PR to `main`, manual.

Node matrix: `[24]` on PRs, `[24, 25]` on `main`/manual.

```text
quality-checks ─┐
complexity-checks ┤  (independent, fast feedback)
                  │
setup-build ──────┼─→ lint-typed
                  ├─→ test (coverage → Codecov)
                  ├─→ perf
                  ├─→ scenarios
                  └─→ playwright
```

| Job                 | What it runs                                                                       |
| ------------------- | ---------------------------------------------------------------------------------- |
| `quality-checks`    | format, spell, fast lint                                                           |
| `complexity-checks` | Biome cognitive complexity + ESLint advisory rules                                 |
| `setup-build`       | builds packages, uploads `dist/` artifacts (1-day retention)                       |
| `lint-typed`        | type-aware ESLint + per-package `tsc --noEmit` (downloads build artifacts)         |
| `test`              | per-package coverage → Codecov upload (Node 24 only)                               |
| `perf`              | performance benchmarks                                                             |
| `scenarios`         | runbook scenario suites (mise-driven)                                              |
| `playwright`        | WebContainer snapshot build + Playwright Chromium tests; uploads report on failure |

**Pattern:** build once, fan out. The `setup-build` job uploads artifacts and
downstream jobs download them — saves rebuilding 5× across `lint-typed`, `test`,
`perf`, `scenarios`, `playwright`.

### `codeql.yml` — code scanning

Triggers: push, PR, weekly `0 6 * * 1`. Single job: init → autobuild → analyze
with `security-extended`.

### `osv-scanner.yml` — dependency vulnerabilities

Triggers: changes to `pnpm-lock.yaml`, `packages/*/package.json`, or
`.osv-scanner.toml` (push/PR) + daily `0 5 * * *`. Scans `pnpm-lock.yaml` with
`--config=.osv-scanner.toml` and uploads SARIF to Code Scanning
(`if: always()`). **Blocking**: a finding red-fails the check (per commit
`e6c908ded`), so a CVE regression on the lockfile cannot merge. The escape hatch
is a dated `[[IgnoredVulns]]` entry in `.osv-scanner.toml`, not
`continue-on-error`; everything else is fixed by the correct mechanism per
[dependency-overrides.md](internal/dependency-overrides.md).

### `mutation.yml` — mutation tests

Triggers: manual + weekly `0 6 * * 1`. Matrix per package, 60-min timeout.
Caches Stryker incremental file (`reports/stryker-incremental.json`) keyed by
SHA with `restore-keys` fallback. Reports retained 30 days.

For local CLI mutation setup debugging, run `pnpm run test:mutate:cli:dry`
before the full CLI mutation suite. The CLI and core packages each generate both
their normal (`jest.config.js`) and Stryker (`jest.stryker.config.js`) Jest
configs from a single self-contained `jest.config.shared.js` factory,
parameterised by `{ sandboxed }`. The factory deliberately avoids importing the
root `jest.config.base.js` — Stryker copies only the package directory into its
`.stryker-tmp` sandbox, so a root-relative import would escape the sandbox and
fail to resolve. From `{ sandboxed }` it derives the sibling-package path depth
(one `../` normally, three in the deeper sandbox) and drops the
`/\.stryker-tmp/` ignore pattern in the sandbox (where every test path contains
that segment). Because both modes come from one source, the normal and Stryker
configs can no longer drift.

### `plugin-smoke-test.yml` — path-filtered

Triggers: changes under `packages/claude-code-plugin/**`. Linux + macOS smoke
tests, plus dependent perf and coverage jobs.

### `release.yml` — publish

Triggers: push to `main`. Build → `pnpm test` →
[Changesets action](https://github.com/changesets/action) opens "Version
Packages" PR or publishes with `--provenance`. Permissions: `contents:write`,
`pull-requests:write`, `id-token:write` (for npm provenance).

## Patterns worth copying

1. **Two-tier linting.** Biome for fast PR feedback; ESLint type-aware as a
   separate, slower job that depends on a build. Keep them non-overlapping.
2. **Build once, reuse via artifacts.** Avoids 5× rebuild cost.
3. **Conditional Node matrix.** Single version on PR, full matrix only on
   `main`/manual — saves CI minutes without losing coverage.
4. **Path-filtered workflows.** Plugin and OSV-Scanner only run when relevant
   paths change.
5. **SHA-pinned actions with version comments.** `actions/checkout@<sha>  # v6`
   — pinned for supply-chain, comment for human readability.
6. **Concurrency cancellation.**
   `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }` —
   supersedes in-flight CI on new pushes.
7. **Scheduled security/quality.** CodeQL weekly, OSV-Scanner daily, Stryker
   weekly — heavy stuff off the PR critical path.
8. **`verify` script as ground truth.** The PR-gate sequence runs identically
   locally and in CI.
9. **Pre-commit only does what's cheap.** lint-staged runs Biome (fast).
   Type-aware ESLint and tests stay in CI.
10. **Advisory-only complexity.** Complexity rules use `warn`, not `error` —
    they surface in output without blocking merges.

## Minimum viable port

For a small TS project, start with:

- `biome.json` (formatter + linter)
- `eslint.config.js` (type-aware only)
- `cspell.json` + dictionary
- `package.json` `verify` script
- `.husky/pre-commit` running `lint-staged`
- One CI workflow with `quality-checks` + `lint-typed` + `test` jobs
- `codeql.yml` + `osv-scanner.yml` (essentially copy-paste)
- Dependabot config

Add Stryker, Playwright, scenarios, and per-package matrices when project size
justifies them.
