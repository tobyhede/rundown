---
name: end-to-end-test-runbook
description: Run an end-to-end workflow that mirrors planning with nested delegated reviews.
---

# End-to-End Test Runbook

Run a compact end-to-end workflow that mirrors the planning runbook structure.

## 1. Write
- PASS ALL CONTINUE
- FAIL ANY STOP

- end-to-end-test/write-file.runbook.md


## 2. Review
- PASS ALL CONTINUE
- FAIL ANY STOP

### 2.1 review-1
- DELEGATE
- end-to-end-test/review-file.runbook.md

### 2.2 review-2
- DELEGATE
- end-to-end-test/review-file.runbook.md


## 3. Collate
- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

- end-to-end-test/collate-files.runbook.md
