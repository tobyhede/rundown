---
name: delegation-child-fail-once
description: Stateful delegation target that fails on first claim and passes on retry
tags:
  - delegation

scenarios:
  fail-once:
    description: Standalone run — no parent marker yet, so the child fails and stops
    commands:
      - rd run --allow-all delegation-child-fail-once.runbook.md
    result: STOP
---

# Delegation Child (Fail Once)

Stateful child runbook used as a delegation target for RETRY scenarios.

The child fails on the first claim within a given parent run and passes on
every subsequent claim. State lives in a filesystem marker at
`{{ WorkPath }}/retry-markers/{{ context.parent.vars.RunId }}-{{ context.parent.at }}`,
scoped by the parent's `RunId` and `at` (substep path). This scoping means
two substeps of the same parent each get their own independent marker, and
reruns from separate parent executions never collide.

When run standalone, `{{context.parent.vars.RunId}}` and `{{context.parent.at}}`
are undefined and stay as literal `{{...}}` text, so the standalone scenario
simply fails once and stops (no retry context available).

**Marker lifetime.** Markers are not explicitly cleaned up by this runbook
or by `rd prune` (which only touches `.rundown/` state). They persist under
`{{ WorkPath }}/retry-markers/` until the work directory is cleared (for
example, when a scratch worktree is refreshed or the user deletes the
directory). Because markers are keyed by `RunId` + `at`, stale markers from
previous runs do not affect new executions.

## 1. Execute child task

- PASS COMPLETE
- FAIL STOP

```bash
MARKER_DIR="{{WorkPath}}/retry-markers"
MARKER="$MARKER_DIR/{{context.parent.vars.RunId}}-{{context.parent.at}}"
mkdir -p "$MARKER_DIR"
if [ -f "$MARKER" ]; then
  echo "retry attempt — marker present, passing"
  exit 0
else
  touch "$MARKER"
  echo "first attempt — marker created, failing to trigger retry"
  exit 1
fi
```
