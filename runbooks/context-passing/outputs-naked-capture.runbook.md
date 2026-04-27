---
name: outputs-naked-capture
description: Naked OUTPUTS entry lets the shell write a value; the captured value flows into the next step
tags:
  - context-passing
scenarios:
  completed:
    description: Shell writes to $RD_OUTPUTS_Version; step 2 asserts the value was captured
    commands:
      - rd run --allow-all outputs-naked-capture.runbook.md
    expect:
      result: COMPLETE
      steps:
        - from: "1"
          at: "2"
          result: PASS
          action: CONTINUE
        - from: "2"
          at: "2"
          result: PASS
          action: COMPLETE
---

# Naked OUTPUTS Capture

Shell writes a value to the file path provided via `$RD_OUTPUTS_<Name>`;
the runtime reads the file after the step completes and stores the value in
the runbook variable store. The next step verifies the value was captured
by asserting it matches the expected string.

## 1. Capture version
- OUTPUTS
  - Version
- PASS CONTINUE
- FAIL STOP

```sh
printf 'v1.0.0' > "$RD_OUTPUTS_Version"
```

## 2. Assert captured value
- PASS COMPLETE
- FAIL STOP

```sh
test "{{ Version }}" = "v1.0.0"
```
