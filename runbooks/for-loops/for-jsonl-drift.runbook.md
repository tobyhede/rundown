---
name: for-jsonl-drift
description: JSONL source drift fails closed during FOR iteration
tags:
  - for-loops
  - security
scenarios:
  drift-detected:
    description: Mutating a file-backed source after the first item stops the run
    commands:
      - "! rd run --allow-all --input-file data/drift-sources.yaml for-jsonl-drift.runbook.md"
    result: STOP
---
# FOR JSONL Drift

## 1. Iterate source
- FOR item IN {{ items }}
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Mutate after first item
- PASS CONTINUE
- FAIL STOP

```sh
if [ "{{ Index }}" = "1" ]; then
  printf '"changed"\n"two"\n' > data/drift-items.jsonl
fi
rd echo item={{ item }}
```
