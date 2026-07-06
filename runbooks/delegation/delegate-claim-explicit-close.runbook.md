---
name: delegate-claim-explicit-close
description: Explicit --claim-capability write commands target claimed children
tags:
  - delegation
  - claim-id

scenarios:
  explicit-pass:
    description: pass --claim-capability advances the claimed child and propagates completion
    commands:
      - true delegation-child-manual-three-step.runbook.md
      - rd run --prompted delegate-claim-explicit-close.runbook.md
      - rd claim ${TOKEN}
      - rd pass --claim-capability ${CLAIM_CAPABILITY}
      - rd pass --claim-capability ${CLAIM_CAPABILITY}
      - rd pass --claim-capability ${CLAIM_CAPABILITY}
      - rd collect --run-capability ${RUN_CAPABILITY}
    expect:
      result: COMPLETE
      steps:
        - action: COMPLETE
          result: PASS
  explicit-fail:
    description: fail --claim-capability stops the claimed child and propagates failure
    commands:
      - true delegation-child-manual-three-step.runbook.md
      - rd run --prompted delegate-claim-explicit-close.runbook.md
      - rd claim ${TOKEN}
      - rd fail --claim-capability ${CLAIM_CAPABILITY}
      - rd collect --run-capability ${RUN_CAPABILITY}
    expect:
      result: STOP
      steps:
        - action: STOP
          result: FAIL
  explicit-stop:
    description: stop --claim-capability stops the claimed child and propagates failure
    commands:
      - true delegation-child-manual-three-step.runbook.md
      - rd run --prompted delegate-claim-explicit-close.runbook.md
      - rd claim ${TOKEN}
      - rd stop --claim-capability ${CLAIM_CAPABILITY}
      - rd collect --run-capability ${RUN_CAPABILITY}
    expect:
      result: STOP
      steps:
        - action: STOP
          result: FAIL
  explicit-complete:
    description: complete --claim-capability completes the claimed child and propagates success
    commands:
      - true delegation-child-manual-three-step.runbook.md
      - rd run --prompted delegate-claim-explicit-close.runbook.md
      - rd claim ${TOKEN}
      - rd complete --claim-capability ${CLAIM_CAPABILITY}
      - rd collect --run-capability ${RUN_CAPABILITY}
    expect:
      result: COMPLETE
      steps:
        - action: COMPLETE
          result: PASS
  explicit-goto:
    description: goto --claim-capability moves the claimed child cursor without moving the parent
    commands:
      - true delegation-child-manual-three-step.runbook.md
      - rd run --prompted delegate-claim-explicit-close.runbook.md
      - rd claim ${TOKEN}
      - rd goto 3 --claim-capability ${CLAIM_CAPABILITY}
      - >-
        node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(".rundown/session.json","utf8")); const c=s.claims["${CLAIM_ID}"]; const child=JSON.parse(fs.readFileSync(`.rundown/runs/${c.childRunId}.json`,"utf8")); const parent=JSON.parse(fs.readFileSync(`.rundown/runs/${c.parentRunId}.json`,"utf8")); if (child.step !== "3") throw new Error(`child step=${child.step}`); if (parent.step !== "1") throw new Error(`parent step=${parent.step}`);'
      - rd pass --claim-capability ${CLAIM_CAPABILITY}
      - rd collect --run-capability ${RUN_CAPABILITY}
    expect:
      result: COMPLETE
      steps:
        - action: COMPLETE
          result: PASS
---

# Explicit Claim ID Write Commands Target Claimed Children

Write commands with `--claim-capability` operate on the claimed child instead of the
default active parent.

## 1. Delegated child

- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child task

- delegation-child-manual-three-step.runbook.md
