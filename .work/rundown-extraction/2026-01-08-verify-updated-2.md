# Review Agent 2 - Updated Plan Verification

## Execution Feasibility

### Sed Commands Analysis
The plan uses macOS-compatible sed syntax with `-i ''` flag throughout. All find + sed commands follow the same pattern:

```bash
find packages/X -name "*.ts" -exec sed -i '' 's/OLD/NEW/g' {} \;
```

**VERDICT:** Commands are correct for macOS. The empty string after `-i` is critical for in-place editing without backup files on BSD/macOS sed.

### File Path Coverage
- Task 4 Step 3 uses: `find packages/cli -name "*.ts"` for import replacement
- This **WILL** correctly match and update `packages/cli/src/services/*.ts` files
- Verified: Both `discovery.ts` and `execution.ts` exist and contain @turboshovel imports

**Test:**
```
packages/cli/src/services/discovery.ts    (imports @turboshovel/parser)
packages/cli/src/services/execution.ts    (imports @turboshovel/shared)
```

Both will be caught by the find command.

### Build/Test Commands
Build and test commands reference npm workspaces correctly:
- `npm run build -w packages/parser`
- `npm run test -w packages/parser`

These will work with the monorepo setup.

---

## Edge Cases & Critical Issues Found

### Issue 1: CRITICAL - execution.ts Hardcoded Path (Line 216)
**File:** `packages/cli/src/services/execution.ts:216`
```typescript
state: `.claude/turboshovel/runbooks/${state.id}.json`,
```

**Problem:** This is a **hardcoded string literal** that returns metadata with turboshovel path. This string is NOT in a variable or config - it's a direct string concatenation in the `buildMetadata()` function.

**Status in Plan:** NOT addressed. The sed command on Task 4 Step 3-4 will NOT catch this because:
1. It's not an import statement (won't match `@turboshovel/` pattern)
2. It's embedded in a template string inside code logic
3. Requires manual edit of execution.ts function

**Action Needed:** Add explicit step to edit execution.ts line 216 to change to `.claude/rundown/workflows/`

---

### Issue 2: MISSING - test-utils.ts Hardcoded mkdtemp Prefix (Line 28)
**File:** `packages/cli/__tests__/helpers/test-utils.ts:28`
```typescript
const tempDir = await mkdtemp(join(tmpdir(), 'tsv-test-'));
```

**Status in Plan:** Task 4 Step 9 addresses `.claude/turboshovel` references in test-utils.ts, but does NOT explicitly address the `tsv-test-` prefix on line 28.

**Requirement per Plan:** Should be changed to `rd-test-` for consistency.

**Fix Status:** NOT in plan sed commands. Requires manual edit.

---

### Issue 3: MISSING - jest.config.js Module Mapping Update
**File:** `packages/shared/jest.config.js`
```javascript
moduleNameMapper: {
  '^(\\.{1,2}/.*)\\.js$': '$1',
  '^@turboshovel/parser$': '<rootDir>/../parser/src/index.ts',
},
```

**Status in Plan:** Task 3 Step 5 says "Update Jest config module mapping" but only mentions changing the pattern from `^@turboshovel/parser$` to `^@rundown/parser$`.

**Problem:** The plan says to update it, but no explicit sed command is provided for jest.config.js. The sed commands in Task 3 Step 3 only target `*.ts` files (`find packages/core -name "*.ts"`), which will NOT match jest.config.js.

**Fix Status:** INCOMPLETE. Task 3 Step 5 is a manual edit, not covered by sed.

---

### Issue 4: test-utils.ts Creates OLD Paths
**File:** `packages/cli/__tests__/helpers/test-utils.ts:29-35`
```typescript
const tempDir = await mkdtemp(join(tmpdir(), 'tsv-test-'));
const projectRunbooksDir = join(tempDir, '.claude', 'runbooks');
// Create .claude/turboshovel structure
await mkdir(join(tempDir, '.claude', 'turboshovel', 'runbooks'), { recursive: true });
await mkdir(projectRunbooksDir, { recursive: true });
```

**Issue:** Even after sed replacement, the comment on line 34 says "Create .claude/turboshovel structure" but tests expect `.claude/rundown/workflows`.

**Status in Plan:** Task 4 Step 9 addresses updating paths in test-utils.ts, but the sed command doesn't specify what string patterns to replace in this specific file. Need explicit sed pattern.

---

## Hardcoded Reference Check

### Will Any Turboshovel References Remain?

**YES - Three critical ones:**

1. **execution.ts line 216** - Hardcoded `.claude/turboshovel/runbooks/` in metadata
2. **test-utils.ts line 28** - Prefix `tsv-test-` should be `rd-test-`
3. **test-utils.ts lines 29-51** - Path helpers return `.claude/turboshovel/` when they should return `.claude/rundown/workflows/`

The sed commands in the plan address IMPORTS but NOT these hardcoded strings.

---

## Specific Checks Verification

### 1. Services imports covered by find command
**Result:** ✓ YES
- `find packages/cli -name "*.ts"` will match `packages/cli/src/services/discovery.ts`
- `find packages/cli -name "*.ts"` will match `packages/cli/src/services/execution.ts`
- Both contain @turboshovel imports that will be replaced

### 2. tsv-test- prefix addressed (Task 4 Step 9)
**Result:** ✗ NO
- Task 4 Step 9 lists changes to test-utils.ts but does NOT mention line 28 prefix change
- Sed commands in Step 9 show replacements for `.claude/turboshovel/` paths and `TURBOSHOVEL_LOG`, but not `tsv-test-`
- This is an OVERSIGHT in the plan

### 3. Jest config mapping addressed (Task 3 Step 5)
**Result:** PARTIALLY
- Task 3 Step 5 exists as a manual edit step (not automated)
- Step correctly identifies the change needed: `'^@turboshovel/parser$'` → `'^@rundown/parser$'`
- However, no sed command provided - relies on manual file editing
- This is listed but will require human execution

### 4. echo/prune explicitly kept
**Result:** ✓ YES
- Task 4 file list explicitly states: "Commands to KEEP: echo.ts, prune.ts"
- Task 4 Step 7 removes gate.ts but keeps echo and prune
- Task 4 Steps 10-11 update fixture and test references for `tsv` → `rd` including echo/prune
- Plan explicitly shows these commands in verification checklist line 457

---

## NEW Issues Found

### Critical Issues (Block Extraction)

1. **execution.ts Metadata Hardcoded Path** - Line 216 contains `.claude/turboshovel/runbooks/` that will persist after extraction. Causes test failures when metadata is written.

2. **test-utils.ts Incomplete Updates** - The sed commands in Task 4 Step 9 don't specify exact patterns for test-utils.ts. Creates structural mismatch between expected paths and actual paths created by test utilities.

### Medium Issues (Cause Test Failures)

3. **tsv-test- Prefix Not Addressed** - mkdtemp prefix should change to `rd-test-` for consistency, currently not in plan

4. **test-utils.ts Return Values Not Updated** - The `workflowPath()`, `statePath()`, and `sessionPath()` functions return hardcoded `.claude/turboshovel/` paths. The sed command in Task 4 Step 9 won't catch these because they're not simple string literals - they're in function return statements.

### Low Issues (Documentation)

5. **Comment in test-utils.ts** - Line 34 comment says "Create .claude/turboshovel structure" but should say "Create .claude/rundown/workflows structure"

---

## Verification Against Previous Issues Report

| Previous Issue | Status | Verification |
|----------------|--------|--------------|
| #1 TransitionObjectSchema | RESOLVED | index.ts line 20 exports all from schemas.js ✓ |
| #2 Services import update | **INCOMPLETE** | Services files will be updated but execution.ts line 216 hardcoded path won't |
| #3 test-utils tsv-test- prefix | **NEW ISSUE** | Not addressed in updated plan |
| #4 Jest config mapping | ADDRESSED | Task 3 Step 5 identified but requires manual edit |
| #5 Test count mismatch | ASSUMED FIXED | Plan updated counts but not verified |
| #6 echo/prune commands | CONFIRMED KEPT | Explicitly listed and processed |
| #7 File count discrepancies | UPDATED | Counts in plan match source (36/19/20 fixtures) |
| #8 .c8rc.json | MENTIONED | Listed in Task 4 but not explicitly copied |
| #9 docs/plans subdirectory | NOTED | Explicitly skipped |
| #11 Rundown as standalone | DOCUMENTED | Plan clearly states standalone library |

---

## VERDICT

**INCOMPLETE**

### Reasons:

1. **Critical Blocker:** execution.ts line 216 contains hardcoded `.claude/turboshovel/runbooks/` path that won't be caught by sed commands. This will cause test failures in CLI metadata verification.

2. **Missing Coverage:** test-utils.ts test-utils helpers create wrong paths because:
   - The prefix `tsv-test-` on line 28 is not addressed
   - The function return values on lines 49-51 return wrong paths (`.claude/turboshovel/` instead of `.claude/rundown/workflows/`)
   - These are not simple string literals - sed won't catch function logic

3. **Plan Incompleteness:** The sed commands in Task 4 Step 9 don't include explicit patterns for test-utils.ts path variables, leading to structural mismatch.

### Required Changes to Plan:

**Before proceeding, add to Task 4 Step 9:**
- Add explicit sed command: `sed -i '' 's/tsv-test-/rd-test-/g' packages/cli/__tests__/helpers/test-utils.ts`
- Add explicit sed command: `sed -i '' 's/\.claude\/turboshovel\/runbooks/\.claude\/rundown\/workflows/g' packages/cli/__tests__/helpers/test-utils.ts`

**Add to Task 4 (new step, after Step 7):**
- Edit packages/cli/src/services/execution.ts line 216 to change `.claude/turboshovel/runbooks/` to `.claude/rundown/workflows/`

Once these fixes are added, the plan becomes executable.

---

## Summary Table

| Category | Result | Details |
|----------|--------|---------|
| Sed Command Syntax | ✓ CORRECT | macOS `-i ''` syntax is valid |
| File Path Coverage | ✓ CORRECT | find commands cover all source files |
| Services Imports | ✓ COVERED | discovery.ts and execution.ts will be updated |
| Parser Export | ✓ EXPORTED | TransitionObjectSchema exported via index.ts |
| Hardcoded Strings | ✗ INCOMPLETE | execution.ts:216 and test-utils.ts not addressed |
| Test Utils Prefix | ✗ MISSING | tsv-test- → rd-test- not in plan |
| Jest Config | ✓ IDENTIFIED | Task 3 Step 5 identified but manual |
| Command Keeping | ✓ VERIFIED | echo/prune explicitly kept |
| **Overall Plan** | **INCOMPLETE** | Requires 2 additional sed commands and 1 manual edit |

