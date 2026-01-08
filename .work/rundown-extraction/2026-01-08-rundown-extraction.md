# Rundown Extraction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use cipherpowers:executing-plans to implement this plan task-by-task.

**Goal:** Clean lift-and-shift extraction of rundown packages from turboshovel.

**Architecture:** Three npm packages (@rundown/parser, @rundown/core, @rundown/cli) extracted from turboshovel's packages/parser, packages/shared, and packages/cli respectively. Rundown is a **standalone library**.

**Tech Stack:** TypeScript 5.0, Node 18+, ESM modules, Jest, Zod, XState, Commander.js

**Source State:** All turboshovel tests passing (126 + 145 + 205 = 476 tests)

---

## Task 1: Clean Slate

**Step 1: Delete existing source and test files**

```bash
rm -rf packages/parser/src packages/parser/__tests__ packages/parser/fixtures
rm -rf packages/core/src packages/core/__tests__
rm -rf packages/cli/src packages/cli/__tests__
```

**Step 2: Commit clean slate**

```bash
git add -A
git commit -m "chore: clean slate for fresh extraction"
```

---

## Task 2: Extract Parser Package

**Step 1: Copy parser files**

```bash
cp -r ~/psrc/turboshovel/packages/parser/src packages/parser/
cp -r ~/psrc/turboshovel/packages/parser/__tests__ packages/parser/
cp -r ~/psrc/turboshovel/packages/parser/fixtures packages/parser/
```

**Step 2: Update package.json**

Edit `packages/parser/package.json`:
- Change `"name": "@turboshovel/parser"` to `"name": "@rundown/parser"`

**Step 3: Build and test**

```bash
npm run build -w packages/parser
npm run test -w packages/parser
```

Expected: 126 tests pass

**Step 4: Commit**

```bash
git add packages/parser/
git commit -m "feat(parser): extract parser package from turboshovel"
```

---

## Task 3: Extract Core Package

**Step 1: Copy shared files**

```bash
cp -r ~/psrc/turboshovel/packages/shared/src packages/core/
cp -r ~/psrc/turboshovel/packages/shared/__tests__ packages/core/
```

**Step 2: Update imports**

```bash
find packages/core -name "*.ts" -exec sed -i '' 's/@turboshovel\/parser/@rundown\/parser/g' {} \;
```

**Step 3: Update package.json**

Edit `packages/core/package.json`:
- Change `"name": "@turboshovel/shared"` to `"name": "@rundown/core"`
- Change dependency `"@turboshovel/parser"` to `"@rundown/parser"`

**Step 4: Update Jest config**

Edit `packages/core/jest.config.js`:
- Change `@turboshovel/parser` to `@rundown/parser` in moduleNameMapper

**Step 5: Update paths in source files**

```bash
# state.ts paths
sed -i '' 's/\.claude\/turboshovel\/runbooks/\.claude\/rundown\/workflows/g' packages/core/src/workflow/state.ts
sed -i '' 's/\.claude\/turboshovel\/session/\.claude\/rundown\/session/g' packages/core/src/workflow/state.ts

# logger.ts env vars
sed -i '' 's/TURBOSHOVEL_LOG/RUNDOWN_LOG/g' packages/core/src/logger.ts
sed -i '' 's/turboshovel/rundown/g' packages/core/src/logger.ts
```

**Step 6: Remove config.ts (turboshovel-specific)**

```bash
rm -f packages/core/src/config.ts
```

Update `packages/core/src/index.ts` to remove config export if present.

**Step 7: Build and test**

```bash
npm run build -w packages/core
npm run test -w packages/core
```

Expected: 145 tests pass

**Step 8: Commit**

```bash
git add packages/core/
git commit -m "feat(core): extract core package from turboshovel shared"
```

---

## Task 4: Extract CLI Package

**Step 1: Copy CLI files**

```bash
cp -r ~/psrc/turboshovel/packages/cli/src packages/cli/
cp -r ~/psrc/turboshovel/packages/cli/__tests__ packages/cli/
```

**Step 2: Update imports**

```bash
find packages/cli -name "*.ts" -exec sed -i '' 's/@turboshovel\/shared/@rundown\/core/g' {} \;
find packages/cli -name "*.ts" -exec sed -i '' 's/@turboshovel\/parser/@rundown\/parser/g' {} \;
```

**Step 3: Update package.json**

Edit `packages/cli/package.json`:
- Change `"name": "@turboshovel/cli"` to `"name": "@rundown/cli"`
- Change dependency `"@turboshovel/shared"` to `"@rundown/core"`
- Change dependency `"@turboshovel/parser"` to `"@rundown/parser"`
- Change bin `"turboshovel"` to `"rundown"`
- Change bin `"tsv"` to `"rd"`

**Step 4: Update Jest config**

Edit `packages/cli/jest.config.js`:
- Change `@turboshovel/shared` to `@rundown/core`
- Change `@turboshovel/parser` to `@rundown/parser`

**Step 5: Update CLI name**

Edit `packages/cli/src/cli.ts`:
- Change `.name('turboshovel')` to `.name('rundown')`

**Step 6: Remove gate command (turboshovel-specific)**

```bash
rm -f packages/cli/src/commands/gate.ts
rm -f packages/cli/__tests__/commands/gate.test.ts
```

Edit `packages/cli/src/cli.ts`:
- Remove gate command import and registration

**Step 7: Update paths and env vars**

```bash
# execution.ts
sed -i '' 's/\.claude\/turboshovel\/runbooks/\.claude\/rundown\/workflows/g' packages/cli/src/services/execution.ts

# test-utils.ts
sed -i '' 's/\.claude\/turboshovel/\.claude\/rundown/g' packages/cli/__tests__/helpers/test-utils.ts
sed -i '' 's/tsv-test-/rd-test-/g' packages/cli/__tests__/helpers/test-utils.ts
sed -i '' 's/TURBOSHOVEL_LOG/RUNDOWN_LOG/g' packages/cli/__tests__/helpers/test-utils.ts
```

**Step 8: Update fixtures and tests - tsv to rd**

```bash
find packages/cli/__tests__/fixtures -name "*.md" -exec sed -i '' 's/tsv /rd /g' {} \;
find packages/cli/__tests__ -name "*.ts" -exec sed -i '' 's/tsv /rd /g' {} \;
```

**Step 9: Build and test**

```bash
npm run build -w packages/cli
npm run test -w packages/cli
```

Expected: ~200 tests pass (gate tests removed)

**Step 10: Commit**

```bash
git add packages/cli/
git commit -m "feat(cli): extract CLI package from turboshovel"
```

---

## Task 5: Extract Documentation

**Step 1: Copy docs**

```bash
mkdir -p docs
cp ~/psrc/turboshovel/docs/SPEC.md docs/ 2>/dev/null || true
```

**Step 2: Update references**

```bash
find docs -name "*.md" -exec sed -i '' 's/turboshovel/rundown/g' {} \;
find docs -name "*.md" -exec sed -i '' 's/tsv /rd /g' {} \;
find docs -name "*.md" -exec sed -i '' 's/@turboshovel/@rundown/g' {} \;
```

**Step 3: Commit**

```bash
git add docs/
git commit -m "docs: extract documentation from turboshovel"
```

---

## Task 6: Final Verification

**Step 1: Clean install**

```bash
rm -rf node_modules packages/*/node_modules
npm install
```

**Step 2: Full build**

```bash
npm run build
```

**Step 3: Full test suite**

```bash
npm test
```

Expected: All tests pass (126 + 145 + ~200 = ~470 tests)

**Step 4: Smoke test**

```bash
npm run cli -- --help
```

Expected: Shows `rundown` command

**Step 5: Verify no turboshovel references**

```bash
grep -r "turboshovel" packages/ --include="*.ts" --include="*.json"
grep -r "@turboshovel" packages/
```

Expected: No matches

**Step 6: Final commit**

```bash
git add -A
git commit -m "feat: complete rundown extraction from turboshovel"
```

---

## Verification Checklist

- [ ] Parser: 126 tests passing
- [ ] Core: 145 tests passing
- [ ] CLI: ~200 tests passing
- [ ] CLI shows `rundown` not `turboshovel`
- [ ] Binaries: `rundown` and `rd`
- [ ] State persists to `.claude/rundown/`
- [ ] Logs use `RUNDOWN_LOG` env var
- [ ] No `turboshovel` references in source
