# N-Verification Workflow

Orchestrate N independent reviews, collation, and cross-check.

## 1. Dispatch review agents

Dispatch $count review agents in parallel. Each agent independently reviews
the subject using verify-review.md template.

### 1.{n}
 - workflow.one.md
 - workflow.two.md

Dispatch review agent.

**Prompt:** Review the subject independently. Write findings to
`.work/{date}-verify-{agentId}.md` using the template.

- PASS: CONTINUE
- FAIL: RETRY 1

## 2. Collate findings

Compare all agent reviews. Categorize by consensus ratio:
- Common (N/N): All agents found
- Exclusive: (N-1)/N, (N-2)/N, ... 1/N

**Prompt:** Read all review files from step 1. Use verify-collation.md template.
Write collation to `.work/{date}-verify-collated.md`.

Present Common findings to user immediately.

- PASS: CONTINUE
- FAIL: STOP "Collation failed"

## 3. Cross-check exclusive findings

Validate ALL exclusive findings against ground truth.
Mark each as VALIDATED, INVALIDATED, or UNCERTAIN.

**Prompt:** For each exclusive finding, verify against the actual implementation/docs/plan.
Write results to `.work/{date}-verify-crosscheck.md`.

- PASS: CONTINUE
- FAIL: CONTINUE

## 4. Present summary

Present final verification summary with all findings and their status.

**Prompt:** Summarize:
- Common (N/N): Ready to implement
- Exclusive VALIDATED: Should implement
- Exclusive INVALIDATED: Can skip
- Exclusive UNCERTAIN: User decides

- PASS: COMPLETE
