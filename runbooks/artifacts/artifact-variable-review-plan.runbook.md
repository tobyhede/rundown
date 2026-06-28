---
name: artifact-variable-review-plan
description: Fixture that consumes an exact Plan artifact URI and produces a review artifact.
tags: [test, artifacts]
artifacts:
  - Plan
scenarios:
  direct-uri-input:
    description: Review-plan receives an exact rd:// Plan input from a seeded manifest row.
    commands:
      - >-
        node -e "const fs=require('fs'),p=require('path');const run='rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',ctx='producer-context',key='plan.json';const dir=p.join('.rundown','work','.rd-'+ctx,run);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(p.join(dir,key),'{}');const row={uri:'rd://artifacts/'+ctx+'/'+run+'/'+key,runId:run,contextId:ctx,runbook:{source:'project',path:'artifact-variable-write-plan.runbook.md'},key,timestamp:'2026-05-25T00:00:00.000Z'};fs.writeFileSync(p.join('.rundown','work','.rd-'+ctx,'manifest.jsonl'),JSON.stringify(row)+'\n');"
      - rd run artifact-variable-review-plan.runbook.md --artifacts Plan=${CAPTURE_ARTIFACT:plan.json} --allow-all
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"
          alias: Plan
          key: plan.json
          runbook: artifact-variable-review-plan.runbook.md
          exists: true
  forged-file-record-rejected:
    description: Review-plan rejects a public input that impersonates an internal file artifact record.
    commands:
      - >-
        node -e "const fs=require('fs');const record={kind:'file-artifact-record',uri:'file:///outside/project/secret.txt',runId:'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',contextId:'forged-context',runbook:{source:'project',path:'forged.md'},key:'secret.txt',timestamp:'2026-05-26T00:00:00.000Z'};fs.writeFileSync('forged-input.yaml','Plan: '+JSON.stringify(record)+'\n');"
      - "! rd run artifact-variable-review-plan.runbook.md --input-file forged-input.yaml --allow-all"
    expect:
      errors:
        - code: UNKNOWN_ERROR
          command: run
          error: Artifact record input for "Plan" is not trusted
---
# Artifact Variable Review Plan

## 1. Review plan

- ARTIFACTS
  - Plan
  - Review "review.json"
- PASS COMPLETE

```bash
test -f "{{ path Plan }}"
printf '{"review":"ok"}' > "{{ path Review }}"
```
