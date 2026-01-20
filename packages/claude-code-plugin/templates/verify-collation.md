# Verification Collation Report

**Date:** [YYYY-MM-DD HH:mm]
**Agent Count:** [N]
**Reviews Collated:** [List of review files]
**Cross-Check Status:** [PENDING | COMPLETE]

## Executive Summary

| Category | Count |
|----------|-------|
| Common (N/N) | X |
| Exclusive Total | X |

## Common (N/N)

Issues all agents independently found. Very high confidence - implement immediately.

### Issue 1: [Title]

**Found by:** All [N] agents
**Consensus:** N/N
**Location:** [file:line]
**Description:** [What's wrong]
**Action:** Implement fix

## Exclusive

Issues found by fewer than all agents. Requires cross-check validation.

### (N-1)/N

#### Issue X: [Title]

**Found by:** [Agent 1, Agent 2] (not Agent 3)
**Consensus:** 2/3
**Location:** [file:line]
**Description:** [What's wrong]
**Cross-Check Status:** [PENDING | VALIDATED | INVALIDATED | UNCERTAIN]

### 1/N

#### Issue Y: [Title]

**Found by:** [Agent 2 only]
**Consensus:** 1/3
**Location:** [file:line]
**Description:** [What's wrong]
**Cross-Check Status:** [PENDING | VALIDATED | INVALIDATED | UNCERTAIN]

## Recommendations

### Immediate (Common)
- [ ] Fix issue 1
- [ ] Fix issue 2

### Pending Cross-Check (Exclusive)
- [ ] Issue X (awaiting validation)
- [ ] Issue Y (awaiting validation)
