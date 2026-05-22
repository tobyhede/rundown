---
name: End-to-End Test
description: Run multiple runbooks and test the end-to-end process.
---

# End-to-End Test

Run multiple runbooks, reviewing and testing the end-to-end process.


## 1. Read the output schema
- PASS CONTINUE
- FAIL STOP

```prompt
{{ CLAUDE_PLUGIN_ROOT }}/schemas/review.schema.json
```

## 2. Write Plan
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

- planning/write-plan.runbook.md


## 3. Review Plan
- PASS ALL CONTINUE
- FAIL ANY STOP

- planning/review-plan.runbook.md


## 4. Write the review of the end-to-end Rundown workflow
- PASS CONTINUE
- FAIL STOP

Write the review to the output path as JSON.
Follow the review output schema.

```bash
OUTPUT_PATH="$(rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file end-to-end-test-review.json)"
cat > "$OUTPUT_PATH" <<'JSON'
{
  "$schema": "https://rundown.org/schemas/review.schema.json",
  "meta": {
    "version": "1.0.0"
  },
  "items": []
}
JSON
```


## 5. Check Schema
- PASS COMPLETE
- FAIL GOTO 4

```bash
rdx "$(rdpath --dir {{ WorkPath }} --ctx {{ ContextId }} --file end-to-end-test-review.json)" --validate
```
