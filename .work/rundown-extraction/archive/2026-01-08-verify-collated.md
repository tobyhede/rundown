# Collation Report: Rundown Extraction Plan Verification

**Date:** 2026-01-08
**Agents:** 2 (Explore agents with different perspectives)
**Subject:** Extraction plan completeness for rundown packages

---

## Common Findings (2/2) - High Confidence

Both agents independently identified these issues:

### 1. File Count Discrepancies in Plan
**Confidence: HIGH (2/2)**
- Parser fixtures: Plan says 32, actual is 36 (4 missing)
- Shared source files: Plan says 16, actual is 19 (3 missing)
- CLI source files: Plan says 18, actual is 20 (2 missing)

**Impact:** Misleading counts, though `cp -r` commands will still copy all files.

### 2. CLI Commands Not Addressed: echo and prune
**Confidence: HIGH (2/2)**
- `echo.ts` - Test utility command exists but not mentioned
- `prune.ts` - Cleanup command exists but not mentioned
- Plan only explicitly removes `gate.ts`

**Impact:** Unclear whether these commands should be extracted, renamed, or removed.

### 3. Services Subdirectory Missing from Import Updates
**Confidence: HIGH (2/2)**
- CLI package has `services/discovery.ts` and `services/execution.ts`
- These files are not mentioned in the sed import update commands
- May have `@turboshovel/shared` imports that need updating

**Impact:** Potential build failures after extraction.

### 4. Plan Verdict: INCOMPLETE (~85% Complete)
**Confidence: HIGH (2/2)**
Both agents independently concluded the plan is approximately 85% complete.

---

## Exclusive Findings (1/2) - Require Cross-Check

### Agent 1 Only:

#### E1.1 Documentation Plans Subdirectory
- `docs/plans/e2e-test.md` exists but not addressed in plan
- **Status:** Needs verification

#### E1.2 Workflow Renderer Subdirectory
- `workflow/renderer/renderer.ts` is in nested subdirectory
- Plan may not account for this depth
- **Status:** Needs verification

### Agent 2 Only:

#### E2.1 Parser Tests Currently Failing
- Parser tests fail with schema export errors
- `TransitionObjectSchema` export missing
- Pre-flight check requirement violated
- **Status:** CRITICAL - needs verification

#### E2.2 Test Count Mismatch
- Plan claims: 130 parser, 120 core, 198 CLI = 448 total
- Actual: 112 parser, 145 core, 205 CLI = 462 total
- **Status:** Needs verification

#### E2.3 Test Utilities Incomplete Replacement
- `test-utils.ts` line 28: `tsv-test-` temp prefix not in plan
- Plan misses this hardcoded string
- **Status:** Needs verification

#### E2.4 Configuration Files Missing
- `.c8rc.json` (CLI code coverage config) not mentioned
- Package-level `README.md` files not addressed
- **Status:** Needs verification

#### E2.5 Jest Configuration Module Mapping
- `shared/jest.config.js` has hardcoded parser path
- Will need adjustment in rundown structure
- **Status:** Needs verification

#### E2.6 Plugin Architecture Ambiguity
- Turboshovel is currently a Claude Code plugin
- Unclear if rundown should be standalone or plugin
- **Status:** Needs clarification from user

---

## Summary

| Category | Count | Action |
|----------|-------|--------|
| Common (2/2) | 4 | Act immediately |
| Agent 1 Exclusive | 2 | Cross-check required |
| Agent 2 Exclusive | 6 | Cross-check required |

**Overall Verdict:** INCOMPLETE

**Critical Blockers:**
1. Parser tests may be failing (needs verification)
2. Test count assumptions may be wrong
3. Several files/configs not addressed in plan

**Cross-check starting for exclusive findings...**
