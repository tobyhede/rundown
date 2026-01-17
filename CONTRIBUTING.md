# Contributing to Rundown

Thank you for your interest in contributing to Rundown! This document provides guidelines and instructions for setting up your development environment and contributing to the project.

## Project Structure

Rundown is a monorepo managed with npm workspaces:

- `packages/parser`: Markdown runbook parser and validator.
- `packages/core`: Core runbook logic and CLI output formatting.
- `packages/cli`: The `rd` command-line interface.
- `site`: The Astro-based documentation and interactive demo site.
- `runbooks`: A collection of pattern and example runbooks.

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

We use ESLint to maintain code quality. Please ensure your code passes the linter before submitting a pull request.

```bash
# Run linter
npm run lint

# Automatically fix linting issues
npm run lint:fix
```

## Pull Request Process

1. Create a new branch for your feature or bugfix.
2. Ensure all tests pass (`npm run test` and site tests).
3. Ensure the linter passes (`npm run lint`).
4. Rebuild the snapshot if you've modified package code.
5. Submit a pull request with a clear description of your changes.

## Continuous Integration

GitHub Actions runs on all pull requests and pushes to `main`:

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `ci.yml` | PRs and pushes to main | Builds, lints, and tests across Node.js 18, 20, and 22 |
| `release.yml` | Pushes to main | Handles npm publishing via Changesets |

### CI Pipeline Steps

1. `npm ci` - Install dependencies
2. `npm run build` - Build all packages (parser → core → cli)
3. `npm run lint` - Run ESLint
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
- `@rundown/parser`
- `@rundown/core`
- `@rundown/cli`

The `site` package is private and never published to npm.

### Manual Release Commands

```bash
npx changeset           # Create a new changeset
npx changeset version   # Apply changesets and bump versions
npx changeset publish   # Publish to npm (usually done by CI)
```

Thank you for contributing!
