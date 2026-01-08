# Updated Plan Issues Report

**Date:** 2026-01-08
**Verification:** Dual-agent consensus with cross-check
**Verdict:** **INCOMPLETE**

---

## Critical Issues (Must Fix)

### 1. TransitionObjectSchema Missing from Source
**Severity:** CRITICAL
**Consensus:** Agent 1 correct, Agent 2 incorrect
**Cross-check result:**
```
grep "TransitionObjectSchema" packages/parser/src/schemas.ts → NOT FOUND
grep "TransitionObjectSchema" packages/parser/src/index.ts → NOT FOUND
```

The schema does NOT exist in source code. The plan Step 2 Step 5 says "Ensure TransitionObjectSchema is exported" but there's nothing to export - it must be **created**.

**Fix:** Add to `packages/parser/src/schemas.ts`:
```typescript
export const TransitionObjectSchema = z.object({
  kind: z.enum(['pass', 'fail', 'yes', 'no']),
  action: ActionSchema,
});
```

### 2. execution.ts Hardcoded Path (Line 216)
**Severity:** CRITICAL
**Consensus:** Agent 2 only, but VALIDATED
**Cross-check result:**
```
execution.ts:216:    state: `.claude/turboshovel/runbooks/${state.id}.json`,
```

This is an embedded string in function logic - sed import commands won't catch it.

**Fix:** Add explicit step to Task 4:
```
Edit packages/cli/src/services/execution.ts line 216:
- Change `.claude/turboshovel/runbooks/` to `.claude/rundown/workflows/`
```

---

## Medium Issues (Should Fix)

### 3. test-utils.ts tsv-test- Prefix
**Severity:** Medium
**Consensus:** HIGH (2/2)

Line 28: `mkdtemp(join(tmpdir(), 'tsv-test-'))` not addressed.

**Fix:** Add sed command to Task 4 Step 9:
```bash
sed -i '' 's/tsv-test-/rd-test-/g' packages/cli/__tests__/helpers/test-utils.ts
```

### 4. test-utils.ts Hardcoded Paths
**Severity:** Medium
**Consensus:** HIGH (2/2)

Multiple `.claude/turboshovel/` paths in function logic won't be caught by import-targeting sed.

**Fix:** Add sed command to Task 4 Step 9:
```bash
sed -i '' 's/\.claude\/turboshovel/\.claude\/rundown/g' packages/cli/__tests__/helpers/test-utils.ts
```

---

## Low Issues (Clarification)

### 5. CLI Test File Count
**Finding:** Agent 1 said 28, actual is 18 `.test.ts` files
**Resolution:** Plan says 19 - close enough (may include helper file)
**Status:** Non-blocking

---

## Summary

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | TransitionObjectSchema missing | CRITICAL | Must create schema |
| 2 | execution.ts line 216 hardcoded path | CRITICAL | Must add edit step |
| 3 | tsv-test- prefix | Medium | Add sed command |
| 4 | test-utils.ts paths | Medium | Add sed command |
| 5 | Test file count | Low | Clarification only |

---

## Required Plan Updates

Before the plan can be executed:

1. **Task 2 Step 5** - Change from "ensure exported" to "create and export":
```typescript
// Add to packages/parser/src/schemas.ts
export const TransitionObjectSchema = z.object({
  kind: z.enum(['pass', 'fail', 'yes', 'no']),
  action: ActionSchema,
});
```

2. **Task 4** - Add new step after Step 7:
```
**Step 7.5: Update execution.ts hardcoded path**

Edit `packages/cli/src/services/execution.ts` line 216:
- Change `.claude/turboshovel/runbooks/` to `.claude/rundown/workflows/`
```

3. **Task 4 Step 9** - Add explicit sed commands:
```bash
# Add to Step 9
sed -i '' 's/tsv-test-/rd-test-/g' packages/cli/__tests__/helpers/test-utils.ts
sed -i '' 's/\.claude\/turboshovel/\.claude\/rundown/g' packages/cli/__tests__/helpers/test-utils.ts
```

---

## Verdict

**INCOMPLETE** - Plan has 2 critical issues and 2 medium issues remaining.

After applying the 3 updates above, the plan will be ready for execution.
