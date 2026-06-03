---
name: artifact-variable-write-plan
description: Fixture for artifact variable handoff scenarios.
tags: [test, artifacts]
scenarios:
  write-plan-produces-artifact:
    description: Write-plan completes and records the produced plan artifact.
    commands:
      - rd run artifact-variable-write-plan.runbook.md --allow-all
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"
          alias: Plan
          key: plan.json
          runbook: artifact-variable-write-plan.runbook.md
          exists: true

  review-plan-uri-input:
    description: Review-plan receives an exact rd:// Plan input and treats it as an artifact.
    commands:
      - rd run artifact-variable-write-plan.runbook.md --allow-all
      - >-
        node -e "const fs=require('fs'),p=require('path');const root=p.join('.rundown','work');const ctx=fs.readdirSync(root).find((d)=>d.startsWith('.rd-'));const mf=p.join(root,ctx,'manifest.jsonl');const row=fs.readFileSync(mf,'utf8').trim().split(/\n+/).map(JSON.parse).find((r)=>r.key==='plan.json');fs.writeFileSync('plan-input.yaml','Plan: '+JSON.stringify(row.uri)+'\n');"
      - rd run artifact-variable-review-plan.runbook.md --input-file plan-input.yaml --allow-all
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"
          alias: Plan
          key: plan.json
          runbook: artifact-variable-review-plan.runbook.md
          exists: true

  review-plan-cross-context-uri-input:
    description: Review-plan receives a producer-context exact rd:// Plan input and treats it as the producer artifact.
    commands:
      - rd run artifact-variable-write-plan.runbook.md --allow-all
      - >-
        node -e "const fs=require('fs'),p=require('path');const root=p.join('.rundown','work');const ctx=fs.readdirSync(root).find((d)=>d.startsWith('.rd-'));const mf=p.join(root,ctx,'manifest.jsonl');const row=fs.readFileSync(mf,'utf8').trim().split(/\n+/).map(JSON.parse).find((r)=>r.key==='plan.json');fs.writeFileSync('plan-input.yaml','Plan: '+JSON.stringify(row.uri)+'\n');"
      - rd run artifact-variable-review-plan.runbook.md --input-file plan-input.yaml --allow-all
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"
          alias: Plan
          key: plan.json
          runbook: artifact-variable-review-plan.runbook.md
          exists: true

  bundled-write-review-collate-artifacts:
    description: Write, review, and collate pass artifacts across runbook boundaries without RD-816.
    commands:
      - rd run artifact-variable-write-plan.runbook.md --allow-all
      - >-
        node -e "const fs=require('fs'),p=require('path');const root=p.join('.rundown','work');const ctx=fs.readdirSync(root).find((d)=>d.startsWith('.rd-'));const mf=p.join(root,ctx,'manifest.jsonl');const row=fs.readFileSync(mf,'utf8').trim().split(/\n+/).map(JSON.parse).find((r)=>r.key==='plan.json');fs.writeFileSync('plan-input.yaml','Plan: '+JSON.stringify(row.uri)+'\n');"
      - rd run artifact-variable-review-plan.runbook.md --input-file plan-input.yaml --allow-all
      - >-
        node -e "const fs=require('fs'),p=require('path');const root=p.join('.rundown','work');const ctxs=fs.readdirSync(root).filter((d)=>d.startsWith('.rd-'));const rows=ctxs.flatMap((ctx)=>{const mf=p.join(root,ctx,'manifest.jsonl');return fs.existsSync(mf)?fs.readFileSync(mf,'utf8').trim().split(/\n+/).filter(Boolean).map(JSON.parse):[]});const uris=rows.filter((r)=>r.key==='review.json').map((r)=>r.uri);fs.writeFileSync('reviews-input.yaml','Reviews: '+JSON.stringify(uris)+'\n');"
      - rd run artifact-variable-collate.runbook.md --input-file reviews-input.yaml --allow-all
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
# Artifact Variable Write Plan

## 1. Write plan

- ARTIFACTS
  - Plan "plan.json"
- PASS COMPLETE

```bash
printf '{"plan":"ok"}' > "{{ path Plan }}"
```
