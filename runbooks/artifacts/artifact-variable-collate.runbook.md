---
name: artifact-variable-collate
description: Fixture that consumes a URI-array review artifact input.
tags: [test, artifacts]
artifacts:
  - Reviews
scenarios:
  direct-uri-array-input:
    description: Collate receives an exact rd:// review URI array from a seeded manifest row.
    commands:
      - >-
        node -e "const fs=require('fs'),p=require('path');const run='rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',ctx='reviewctx',key='review.json';const dir=p.join('.rundown','work','.rd-'+ctx,run);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(p.join(dir,key),'{}');const row={uri:'rd://artifacts/'+ctx+'/'+run+'/'+key,runId:run,contextId:ctx,runbook:{source:'project',path:'artifact-variable-review-plan.runbook.md'},key,timestamp:'2026-05-25T00:00:00.000Z'};fs.writeFileSync(p.join('.rundown','work','.rd-'+ctx,'manifest.jsonl'),JSON.stringify(row)+'\n');"
      - rd run artifact-variable-collate.runbook.md --artifacts-json 'Reviews=${CAPTURE_ARTIFACT_ARRAY:review.json}' --allow-all
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"
          alias: Reviews
          key: review.json
          count: 1
          runbook: artifact-variable-collate.runbook.md
          exists: true
---
# Artifact Variable Collate

## 1. Collate reviews

- ARTIFACTS
  - Reviews
- PASS COMPLETE

```bash
rd echo --result pass
```
