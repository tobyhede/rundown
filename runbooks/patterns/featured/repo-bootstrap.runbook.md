---
name: Repo Bootstrap
description: Bootstrap a new TypeScript/Node.js project with common tooling.
tags:
  - featured
scenarios:
  full-setup:
    description: Complete setup including CI with a fresh repository
    commands:
      - rd run --prompted repo-bootstrap.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
      - rd pass
      - rd pass
      - rd yes
      - rd pass
      - rd pass
    result: COMPLETE
  existing-git-repo:
    description: Setup in an existing git repository (git init fails gracefully)
    commands:
      - rd run --prompted repo-bootstrap.runbook.md
      - rd fail
      - rd pass
      - rd pass
      - rd pass
      - rd pass
      - rd pass
      - rd no
      - rd pass
    result: COMPLETE
  ci-optional:
    description: Setup without GitHub Actions
    commands:
      - rd run --prompted repo-bootstrap.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
      - rd pass
      - rd pass
      - rd no
      - rd pass
    result: COMPLETE
---

# Repo Bootstrap

Bootstrap a new TypeScript/Node.js project with common tooling.

## 1. Initialize Git

- PASS: CONTINUE
- FAIL: CONTINUE

Initialize a new git repository. Continues even if already initialized.

```bash
git init
```

## 2. Create package.json

- PASS: CONTINUE
- FAIL: STOP "Failed to create package.json"

Create the initial package.json with npm defaults.

```bash
npm init -y
```

## 3. Install TypeScript

- PASS: CONTINUE
- FAIL: RETRY 2

Install TypeScript and create initial configuration.

```bash
npm install --save-dev typescript @types/node
npx tsc --init --target ES2022 --module NodeNext --moduleResolution NodeNext --outDir dist --rootDir src --strict true
```

## 4. Create Structure

- PASS: CONTINUE
- FAIL: STOP "Failed to create directory structure"

Create the standard project directory structure.

```bash
mkdir -p src tests
echo 'export const main = () => console.log("Hello, TypeScript!");' > src/index.ts
```

## 5. ESLint and Prettier

- PASS: CONTINUE
- FAIL: RETRY 1

Install and configure ESLint with Prettier integration.

```bash
npm install --save-dev eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin prettier eslint-config-prettier
```

## 6. Setup Jest

- PASS: CONTINUE
- FAIL: RETRY 1

Install Jest with TypeScript support.

```bash
npm install --save-dev jest ts-jest @types/jest
npx ts-jest config:init
```

## 7. GitHub Actions

- YES: CONTINUE
- NO: GOTO FinalCommit

Would you like to add GitHub Actions CI workflow?

## 8. Create CI Workflow

- PASS: CONTINUE
- FAIL: CONTINUE

Create GitHub Actions workflow for CI.

```bash
mkdir -p .github/workflows
cat > .github/workflows/ci.yml << 'EOF'
name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run lint
      - run: npm test
EOF
```

## FinalCommit

- PASS: COMPLETE "Repository bootstrapped successfully!"
- FAIL: GOTO CommitFailed

Create the initial commit with all generated files.

```bash
git add -A && git commit -m "chore: initial project setup with TypeScript, ESLint, Prettier, and Jest"
```

## CommitFailed

- PASS: COMPLETE "Repository bootstrapped (commit skipped)."

Initial commit failed. This may be due to git configuration issues.

```bash
echo "Commit failed - please configure git user.name and user.email, then run:"
echo "  git add -A && git commit -m 'chore: initial project setup'"
```
