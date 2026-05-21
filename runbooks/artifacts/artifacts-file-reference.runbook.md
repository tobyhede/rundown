---
name: artifacts-file-reference
description: ARTIFACTS can reference existing project files.
tags: [test, artifacts]
scenarios:
  project-file-reference:
    description: ARTIFACTS resolves an existing project file as a file artifact record
    commands:
      - rd run --prompted artifacts-file-reference.runbook.md
      - rd pass
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"
          alias: ReviewSchemaPath
          kind: file-artifact-record
          key: schemas/review.schema.json
          runbook: artifacts-file-reference.runbook.md
          exists: true
---
# ARTIFACTS File References Resolve Existing Project Files

## 1. Reference existing schema

- ARTIFACTS
  - ReviewSchemaPath "schemas/review.schema.json"
- PASS COMPLETE

```bash
test -f "{{ path ReviewSchemaPath }}"
```
