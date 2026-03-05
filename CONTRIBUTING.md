# Contributing to Rundown

Thank you for your interest in contributing to Rundown! This document provides guidelines and instructions for setting up your development environment and contributing to the project.

## Project Structure

Rundown is a monorepo managed with npm workspaces:

- `packages/parser`: Markdown runbook parser and validator.
- `packages/core`: Core runbook logic and CLI output formatting.
- `packages/cli`: The `rd` command-line interface.
- `site`: The Astro-based documentation and interactive demo site.
- `runbooks`: A collection of pattern and example runbooks.

## Security Policy Layer

The security policy layer (`packages/core/src/policy/`) enforces permission controls on command execution during runbook runs.

### Architecture

| Module | Purpose |
|--------|---------|
| `schema.ts` | Zod schema for PolicyConfig, DEFAULT_POLICY |
| `parser.ts` | Shell command parsing via shell-quote (handles pipes, `sh -c` wrappers, logical operators) |
| `evaluator.ts` | Permission checks with picomatch glob matching |
| `loader.ts` | Config discovery via lilconfig |
| `prompter.ts` | Interactive prompts via @inquirer/prompts (confirm, select) |

### Key Design Decisions

1. **Deny takes precedence**: Deny lists are always checked before allow lists
2. **Environment filtering**: Sensitive env vars (`*_TOKEN`, `AWS_*`, etc.) filtered by default
3. **Runbook overrides**: Policy can vary by runbook path pattern
4. **Session grants**: Memory-only permissions that don't persist to disk

### Testing Policy Changes

```bash
# Run policy-specific tests
npm test --workspace=packages/core -- --testPathPattern="policy"

# Test CLI integration
npm run cli -- run packages/cli/__tests__/fixtures/simple.runbook.md --allow-run git,npm
```

## Development Setup

### Prerequisites

- **Node.js**: v18 or later.
- **npm**: v9 or later (for monorepo management).
- **pnpm**: v9 or later (specifically used for the `site` package).

### Initialization

1. Clone the repository:
   ```bash
   git clone https://github.com/tobyhede/rundown.git
   cd rundown
   ```

2. Install dependencies for the entire monorepo:
   ```bash
   npm install
   ```

3. Build all packages:
   ```bash
   npm run build
   ```

## Development Workflow

### CLI and Core Packages

The CLI and core logic are written in TypeScript. After making changes, you must rebuild the packages:

```bash
npm run build
```

To run the local version of the CLI:
```bash
# In the root directory
npm run cli -- --help
```

### Documentation Site

The documentation site is built with Astro and React. It uses WebContainers to run the Rundown CLI in the browser.

1. Navigate to the site directory:
   ```bash
   cd site
   ```

2. Start the development server:
   ```bash
   pnpm run dev
   ```

#### WebContainer Snapshot

The site uses a pre-built binary snapshot to boot the Rundown environment quickly. If you modify any code in `packages/*`, you must rebuild the packages AND the snapshot for the browser demo to reflect those changes:

```bash
# From the root directory
npm run build
npm run build:snapshot -w site
```

## Testing

### Unit and Integration Tests (Packages)

We use Jest for testing the core packages and the CLI.

```bash
# Run all package tests from the root
npm run test
```

### Mutation Testing

We use [Stryker Mutator](https://stryker-mutator.io/) to assess test quality. Mutation testing introduces small code changes (mutants) and verifies that tests detect them. Surviving mutants indicate weak assertions.

```bash
# Run mutation tests for all packages (sequential, CPU-intensive)
npm run test:mutate

# Run for a single package
npm run test:mutate:parser
npm run test:mutate:core
npm run test:mutate:cli
npm run test:mutate:plugin

# Run directly in a package directory
cd packages/parser && npx stryker run
```

Reports are generated in each package's `reports/mutation/` directory. Stryker uses incremental mode, so subsequent runs are faster. Mutation testing is CPU-intensive (5-30 min per package) and is not part of the standard CI pipeline — it runs via a separate `mutation.yml` workflow on manual trigger or weekly schedule.

### End-to-End Tests (Site)

We use Playwright for testing the interactive runbook runner in the browser.

```bash
# Navigate to the site directory
cd site

# Run Playwright tests
pnpm run test

# Run Playwright tests with UI
pnpm run test:ui
```

Before running Playwright tests for the first time, you may need to install the browser binaries:
```bash
pnpm exec playwright install
```

## Formatting and Linting

We use Biome and ESLint to maintain code quality. Please ensure your code passes the linter before submitting a pull request.

```bash
# Run linters (biome + eslint)
npm run lint

# Automatically fix linting issues
npm run fix:lint
```

## Pull Request Process

1. Create a new branch for your feature or bugfix.
2. Run `npm run verify` before pushing (format, spell, lint, test).
3. Rebuild the snapshot if you've modified package code.
4. Submit a pull request with a clear description of your changes.

## Continuous Integration

GitHub Actions runs on all pull requests and pushes to `main`:

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `ci.yml` | PRs and pushes to main | Builds, lints, and tests across Node.js 18, 20, and 22 |
| `mutation.yml` | Manual dispatch or weekly schedule | Runs Stryker mutation testing per package |
| `release.yml` | Pushes to main | Handles npm publishing via Changesets |

### Dependency Management

[Dependabot](https://docs.github.com/en/code-security/dependabot) is configured in `.github/dependabot.yml` to keep dependencies current automatically:

| Ecosystem | Schedule | Grouping | PR Limit |
|-----------|----------|----------|----------|
| npm | Weekly | Minor + patch updates grouped | 10 |
| GitHub Actions | Weekly | None (majors are infrequent) | 5 |

The npm entry covers the entire monorepo workspace via the root `package-lock.json`. Minor and patch updates are grouped into a single PR to reduce noise; major version bumps arrive as individual PRs so breaking changes can be reviewed separately.

**Reviewing Dependabot PRs:**
- CI runs automatically on every Dependabot PR (build, lint, test)
- Check the changelog/release notes linked in the PR description for breaking changes
- Major bumps may require code changes — review carefully before merging

### Security Scanning

Two workflows scan for vulnerabilities and feed results into the GitHub Security tab:

| Workflow | Schedule | What it scans |
|----------|----------|---------------|
| `osv-scanner.yml` | Daily + on lockfile changes | Known vulnerabilities in npm dependencies (via [OSV](https://osv.dev/)) |
| `codeql.yml` | Weekly + on PRs to main | Static analysis of TypeScript/JavaScript source for security issues |

Both upload SARIF results, so findings appear under **Security > Code scanning alerts** on GitHub. No contributor action is needed unless an alert is assigned to you.

### CI Pipeline Steps

1. `npm ci` - Install dependencies
2. `npm run build` - Build all packages (parser → core → cli)
3. `npm run lint` - Run linters (biome + eslint)
4. `npm test` - Run Jest tests

## Releases

Releases are managed with [Changesets](https://github.com/changesets/changesets) and automated via GitHub Actions.

### How It Works

1. **Add a changeset** when making changes that should be released:
   ```bash
   npx changeset
   ```
   Follow the prompts to select packages and describe your changes.

2. **Merge your PR** - The changeset file (`.changeset/*.md`) is committed with your code.

3. **Version PR created** - After merge, the release workflow creates a "Version Packages" PR that bumps versions.

4. **Publish** - Merging the Version PR triggers npm publish for all affected packages.

### Package Versioning

All three npm packages use **fixed versioning** - they release together with the same version number:
- `@rundown-org/parser`
- `@rundown-org/core`
- `@rundown-org/cli`

The `site` package is private and never published to npm.

### Manual Release Commands

```bash
npx changeset           # Create a new changeset
npx changeset version   # Apply changesets and bump versions
npx changeset publish   # Publish to npm (usually done by CI)
```

Thank you for contributing!
