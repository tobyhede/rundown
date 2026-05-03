# CLI Output Specification

## Conventions

### Response Type Detection

| Type | Format | Detection |
|------|--------|-----------|
| **Error** | `{ "error": "msg", "code": "CODE" }` | `error` field exists |
| **Workflow** | `{ "action": "...", ... }` | `action` field exists |
| **List** | `[...]` | `Array.isArray()` |

### Key Conventions

- **Lists**: Raw arrays `[...]` (no wrapper object)
- **Workflow commands**: Include `action` field (pass, fail, stop, complete, stash, pop)
- **Errors**: `{ "error": "message", "code": "CODE" }`
- **Success/failure**: Workflow commands use exit code, not a `result` field
- **Position**: `{ "current": string, "total": number|string }`
- **Action field**: Shows transition (e.g., "CONTINUE", "GOTO 3", "RETRY"), not command name

### Schema Reference

Authoritative TypeScript types: `packages/core/src/output/schema.ts`

### Unified Types

**Runbook** - Used by `ls` and `prune` for runbook listings:
```json
{
  "id": "string",      // State file identifier
  "runbook": "string", // Runbook filename
  "status": "string",  // active, stashed, completed, stale, orphaned
  "step": "string",    // (optional) Current step position
  "total": number,     // (optional) Total steps
  "title": "string"    // (optional) Runbook title
}
```

---

## ls

### `rd ls`

**Text:**
```text
ID        STATUS   STEP  RUNBOOK                    TITLE
abc12345  active   1/3   deploy.runbook.md          Deploy to Production
def67890  stashed  2/5   onboarding.runbook.md      New Hire Setup
```

**JSON:**
```json
[
  {
    "id": "abc12345-...",
    "status": "active",
    "runbook": "deploy.runbook.md",
    "step": "1",
    "total": 3,
    "title": "Deploy to Production"
  }
]
```

### `rd ls --all`

**Text:**
```text
NAME              SOURCE   DESCRIPTION                    TAGS
deploy            project  Deploy to production           deploy, ci
onboarding        plugin   New hire setup                 hr, setup
```

**JSON:**
```json
[
  {
    "name": "deploy",
    "source": "project",
    "description": "Deploy to production",
    "tags": ["deploy", "ci"],
    "path": ".rundown/runbooks/deploy.runbook.md"
  }
]
```

---

## status

### `rd status` (active runbook)

**Text:**
```text
File:     runbooks/deploy.runbook.md
State:    .rundown/runs/wf-2026-01-26-abc123.json
Prompt:   Yes

## 1. First Step

Step description here.
```

**JSON:**
```json
{
  "active": true,
  "stashed": false,
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/runs/wf-2026-01-26-abc123.json",
  "prompted": true,
  "position": { "current": "1", "total": 3 },
  "step": { "name": "1", "description": "First Step" }
}
```

### `rd status` (no active runbook)

**Text:**
```text
No active runbook.
```

**JSON:**
```json
{
  "active": false,
  "stashed": false
}
```

### `rd status --claim-id <claim_id>`

Same output shape as active `rd status`, but resolves the delegated child identified by `claim_id` instead of the default stack. Invalid, missing, stale, terminal, or unlinked claim ids return an error response.

---

## run

### `rd run <file>`

**Text:**
```text
File:     runbooks/deploy.runbook.md
State:    .rundown/runs/wf-2026-01-26-abc123.json

Action:   START

## 1. First Step

Step description here.

$ echo "hello"
hello

Runbook:  COMPLETE
```

**JSON:**
```json
{
  "action": "complete",
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/runs/wf-2026-01-26-abc123.json",
  "position": { "current": "1", "total": 1 }
}
```

---

## claim

### `rd claim <token>`

Claims a delegation token, launches the delegated child runbook, and returns the `claim_id` used for subsequent child-targeting commands.

**Text:**
```text
CLAIMED: Claimed rdtk_abcd... -> child.runbook.md
```

**JSON:**
```json
{
  "action": "claimed",
  "token": "rdtk_abcd...",
  "claim_id": "rdclm_F3J3n3d_f8fo0a0b1B2c3Q",
  "run_id": "wf-2026-01-26-child",
  "runbook": "child.runbook.md",
  "parent_run_id": "wf-2026-01-26-parent",
  "parent_step": "1.1"
}
```

Use the returned `claim_id` with `rd status --claim-id <claim_id>`, `rd pass --claim-id <claim_id>`, or `rd fail --claim-id <claim_id>` for delegated child work.

---

## pass

### `rd pass`

The `action` field shows the transition (e.g., "CONTINUE" to next step, "GOTO 3" for jump).

**Text:**
```text
File:     runbooks/deploy.runbook.md
State:    .rundown/runs/wf-2026-01-26-abc123.json

─── 2 ──────────────────────────────────────────

Action:   CONTINUE
From:     1
At:       2/3

## 2. Second Step

Next step description.
```

**JSON:**
```json
{
  "action": "CONTINUE",
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/runs/wf-2026-01-26-abc123.json",
  "from": { "current": "1", "total": 3 },
  "to": { "current": "2", "total": 3 }
}
```

### `rd pass --claim-id <claim_id>`

Same output shape as `rd pass`, but targets the delegated child identified by `claim_id` instead of the default stack.

---

## fail

The `action` field shows the transition (e.g., "RETRY (1/3)" for retry, "STOP" for stopping).

### `rd fail` (retry)

**Text:**
```text
File:     runbooks/deploy.runbook.md
State:    .rundown/runs/wf-2026-01-26-abc123.json

Action:   RETRY (1/3)
At:       1/3

## 1. First Step

Step description.
```

**JSON:**
```json
{
  "action": "RETRY (1/3)",
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/runs/wf-2026-01-26-abc123.json",
  "to": { "current": "1", "total": 3 }
}
```

### `rd fail` (stop)

**Text:**
```text
File:     runbooks/deploy.runbook.md
State:    .rundown/runs/wf-2026-01-26-abc123.json

Runbook:  STOP
```

**JSON:**
```json
{
  "action": "STOP",
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/runs/wf-2026-01-26-abc123.json",
  "stopped": true
}
```

### `rd fail --claim-id <claim_id>`

Same output shape as `rd fail`, but targets the delegated child identified by `claim_id` instead of the default stack.

---

## goto

### `rd goto <step>`

The `action` field is combined (e.g., "GOTO 3"), not a separate `target` field.

**Text:**
```text
File:     runbooks/deploy.runbook.md
State:    .rundown/runs/wf-2026-01-26-abc123.json

─── 3 ──────────────────────────────────────────

Action:   GOTO 3
From:     1
At:       3/5

## 3. Target Step

Step description.
```

**JSON:**
```json
{
  "action": "GOTO 3",
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/runs/wf-2026-01-26-abc123.json",
  "from": { "current": "1", "total": 5 },
  "to": { "current": "3", "total": 5 }
}
```

---

## stop

### `rd stop [message]`

Uses `action: "stop"` (command name). Stopping sets a non-zero exit code.

**Text:**
```text
File:     runbooks/deploy.runbook.md
State:    .rundown/runs/wf-2026-01-26-abc123.json

Runbook:  STOP
```

**JSON:**
```json
{
  "action": "stop",
  "message": "User requested stop",
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/runs/wf-2026-01-26-abc123.json"
}
```

---

## complete

### `rd complete [message]`

**Text:**
```text
File:     runbooks/deploy.runbook.md
State:    .rundown/runs/wf-2026-01-26-abc123.json

Runbook:  COMPLETE
```

**JSON:**
```json
{
  "action": "complete",
  "message": "Deployment finished",
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/runs/wf-2026-01-26-abc123.json"
}
```

---

## stash

### `rd stash`

Uses `action: "stash"` (command name).

**Text:**
```text
File:     runbooks/deploy.runbook.md
State:    .rundown/runs/wf-2026-01-26-abc123.json
Prompt:   Yes

Step:     1/3

Runbook:  STASHED
```

**JSON:**
```json
{
  "action": "stash",
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/runs/wf-2026-01-26-abc123.json",
  "prompted": true,
  "position": { "current": "1", "total": 3 }
}
```

### `rd stash --claim-id <claim_id>`

Same output shape as `rd stash`, but stashes the delegated child identified by `claim_id`.

---

## pop

### `rd pop`

Uses `action: "pop"` (command name).

**Text:**
```text
File:     runbooks/deploy.runbook.md
State:    .rundown/runs/wf-2026-01-26-abc123.json
Prompt:   Yes

Action:   PASS
Result:   PASS

## 2. Second Step

Step description.
```

**JSON:**
```json
{
  "action": "pop",
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/runs/wf-2026-01-26-abc123.json",
  "prompted": true,
  "position": { "current": "2", "total": 3 },
  "step": { "name": "2", "description": "Second Step" }
}
```

### `rd pop --claim-id <claim_id>`

Same output shape as `rd pop`, but restores the stashed delegated child identified by `claim_id`.

### `rd pop` (nothing stashed)

**Text:**
```text
No stashed runbook to restore.
```

**JSON:**
```json
{
  "error": "No stashed runbook to restore",
  "code": "NO_STASHED_RUNBOOK"
}
```

---

## prune

Prune uses the same `Runbook` format as `ls`, with status values like "stale" or "orphaned".

### `rd prune --dry-run`

**Text:**
```text
ID        STATUS     RUNBOOK                    TITLE
abc123    stale      old-deploy.runbook.md      Old Deploy
def456    orphaned   missing.runbook.md
```

**JSON:**
```json
[
  {
    "id": "abc123",
    "status": "stale",
    "runbook": "old-deploy.runbook.md",
    "title": "Old Deploy"
  },
  {
    "id": "def456",
    "status": "orphaned",
    "runbook": "missing.runbook.md"
  }
]
```

### `rd prune`

Both dry-run and actual prune output the same format.

**Text:**
```text
Pruned 2 stale state files.
```

**JSON:**
```json
[
  {
    "id": "abc123",
    "status": "stale",
    "runbook": "old-deploy.runbook.md",
    "title": "Old Deploy"
  },
  {
    "id": "def456",
    "status": "orphaned",
    "runbook": "missing.runbook.md"
  }
]
```

---

## check

Check uses `valid`/`errors`/`stats` fields (validation, not workflow).
No `result` field - the `valid` field indicates success.

### `rd check <file>` (valid)

**Text:**
```text
PASS: 3 steps, 2 substeps
```

**JSON:**
```json
{
  "valid": true,
  "errors": [],
  "stats": { "steps": 3, "substeps": 2 }
}
```

### `rd check <file>` (invalid)

**Text:**
```text
FAIL
Line 15: Unknown transition target "step4"
Line 22: Missing command in step
```

**JSON:**
```json
{
  "valid": false,
  "errors": [
    { "line": 15, "message": "Unknown transition target \"step4\"" },
    { "line": 22, "message": "Missing command in step" }
  ],
  "stats": { "steps": 3, "substeps": 0 }
}
```

---

## scenario ls

### `rd scenario ls <file>`

**Text:**
```text
NAME           EXPECTED   DESCRIPTION              TAGS
success        COMPLETE   Happy path test          smoke
failure        STOP       Error handling test      edge
```

**JSON:**
```json
[
  {
    "name": "success",
    "expected": "COMPLETE",
    "description": "Happy path test",
    "tags": ["smoke"]
  }
]
```

---

## scenario show

### `rd scenario show <file> <name>`

**Text:**
```text
Name:        success
Description: Happy path test
Expected:    COMPLETE
Commands:
  $ rd run test.runbook.md
  $ rd pass
```

**JSON:**
```json
{
  "name": "success",
  "description": "Happy path test",
  "expected": "COMPLETE",
  "commands": ["rd run test.runbook.md", "rd pass"],
  "tags": ["smoke"]
}
```

### `rd scenario show <file> <name>` (not found)

**Text:**
```text
Error: Scenario "unknown" not found
Available: success, failure
```

**JSON:**
```json
{
  "error": "Scenario \"unknown\" not found",
  "code": "SCENARIO_NOT_FOUND",
  "details": {
    "available": ["success", "failure"]
  }
}
```

---

## scenario run

### `rd scenario run <file> <name>`

Uses `passed` to indicate scenario outcome (not `result` - this is scenario verification, not workflow).

**Text:**
```text
Scenario:  success
──────────────────────────────────────────────────

$ rd run test.runbook.md
[command output]

$ rd pass
[command output]

Scenario: COMPLETE
```

**JSON:**
```json
{
  "scenario": "success",
  "expected": "COMPLETE",
  "actual": "COMPLETE",
  "passed": true
}
```

---

## echo

### `rd echo [command...]`

**Text:**
```text
npm install
```

**JSON:**
```json
{
  "result": true,
  "output": "npm install",
  "exitCode": 0
}
```

### `rd echo --result fail`

**Text:**
```text
(empty or error output)
```

**JSON:**
```json
{
  "result": false,
  "exitCode": 1
}
```

---

## prompt

### `rd prompt <content>`

**Text:**
```text
Hello world
```

**JSON:**
```json
{
  "output": "Hello world"
}
```

---

## Error Output (all commands)

Error responses include `error` and `code` fields. A non-zero exit code indicates failure.

### No active runbook

Exit code 0 — the condition is informational, not a failure.

**Text:**
```text
No active runbook.
```

**JSON:**
```json
{
  "kind": "warning",
  "message": "No active runbook",
  "code": "NO_ACTIVE_RUNBOOK"
}
```

### File not found

**Text:**
```text
Error: Runbook file not found: missing.runbook.md
```

**JSON:**
```json
{
  "error": "Runbook file not found: missing.runbook.md",
  "code": "RUNBOOK_NOT_FOUND"
}
```
