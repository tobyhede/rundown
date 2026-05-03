---
name: delegate-claim-corruption
description: Claim replay fails closed when persisted child state is missing or relinked
tags:
  - delegation
  - claim-id

scenarios:
  child-missing:
    description: Re-claiming fails with CHILD_RUN_MISSING when the claimed child state file is deleted
    commands:
      - true delegation-child-manual-three-step.runbook.md
      - rd run --prompted delegate-claim-corruption.runbook.md
      - rd claim ${TOKEN}
      - >-
        node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(".rundown/session.json","utf8")); const c=s.claims["${CLAIM_ID}"]; fs.unlinkSync(`.rundown/runs/${c.childRunId}.json`);'
      - "! rd claim ${TOKEN}"
    expect:
      errors:
        - code: CHILD_RUN_MISSING
          command: claim
  child-linkage-mismatch:
    description: Re-claiming fails with CHILD_LINKAGE_MISMATCH when child linkage diverges from the claim
    commands:
      - true delegation-child-manual-three-step.runbook.md
      - rd run --prompted delegate-claim-corruption.runbook.md
      - rd claim ${TOKEN}
      - >-
        node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(".rundown/session.json","utf8")); const c=s.claims["${CLAIM_ID}"]; const p=`.rundown/runs/${c.childRunId}.json`; const child=JSON.parse(fs.readFileSync(p,"utf8")); child.parentLinkage.tokenHash=`sha256:${"f".repeat(64)}`; fs.writeFileSync(p, JSON.stringify(child, null, 2));'
      - "! rd claim ${TOKEN}"
    expect:
      errors:
        - code: CHILD_LINKAGE_MISMATCH
          command: claim
---

# Claim Replay Fails Closed on Child State Corruption

Claim replay validates the existing child state before returning an idempotent
claim result.

## 1. Delegated child

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

- delegation-child-manual-three-step.runbook.md
