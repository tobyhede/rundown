# CLI Output Specification

## Conventions

- **Lists**: Raw arrays `[...]`
- **Status/Action**: Flat objects with `result` boolean
- **Errors**: `{ result: false, error: "message" }`
- **Position**: `{ current: string, total: number }`

---

## ls

### `rd ls`

**Text:**
```
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
```
NAME              DESCRIPTION                    TAGS
deploy            Deploy to production           deploy, ci
onboarding        New hire setup                 hr, setup
```

**JSON:**
```json
[
  {
    "name": "deploy",
    "source": "runbooks",
    "description": "Deploy to production",
    "tags": ["deploy", "ci"],
    "path": ".claude/rundown/runbooks/deploy.runbook.md"
  }
]
```

---

## status

### `rd status` (active runbook)

**Text:**
```
File:     runbooks/deploy.runbook.md
State:    .claude/rundown/runs/wf-2026-01-26-abc123.json
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
  "state": ".claude/rundown/runs/wf-2026-01-26-abc123.json",
  "prompted": true,
  "position": { "current": "1", "total": 3 },
  "step": { "name": "1", "description": "First Step" }
}
```

### `rd status` (no active runbook)

**Text:**
```
No active runbook.
```

**JSON:**
```json
{
  "active": false,
  "stashed": false
}
```

---

## run

### `rd run <file>`

**Text:**
```
File:     runbooks/deploy.runbook.md
State:    .claude/rundown/runs/wf-2026-01-26-abc123.json

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
  "result": true,
  "action": "complete",
  "file": "runbooks/deploy.runbook.md",
  "state": ".claude/rundown/runs/wf-2026-01-26-abc123.json",
  "position": { "current": "1", "total": 1 }
}
```

---

## pass

### `rd pass`

**Text:**
```
File:     runbooks/deploy.runbook.md
State:    .claude/rundown/runs/wf-2026-01-26-abc123.json

─── 2 ──────────────────────────────────────────

Action:   PASS
From:     1
Result:   PASS
At:       2/3

## 2. Second Step

Next step description.
```

**JSON:**
```json
{
  "result": true,
  "action": "PASS",
  "file": "runbooks/deploy.runbook.md",
  "state": ".claude/rundown/runs/wf-2026-01-26-abc123.json",
  "from": { "current": "1", "total": 3 },
  "to": { "current": "2", "total": 3 },
  "step": { "name": "2", "description": "Second Step" }
}
```

---

## fail

### `rd fail` (retry)

**Text:**
```
File:     runbooks/deploy.runbook.md
State:    .claude/rundown/runs/wf-2026-01-26-abc123.json

Action:   RETRY (1/3)
Result:   FAIL
At:       1/3

## 1. First Step

Step description.
```

**JSON:**
```json
{
  "result": false,
  "action": "RETRY",
  "retryCount": 1,
  "retryMax": 3,
  "file": "runbooks/deploy.runbook.md",
  "state": ".claude/rundown/runs/wf-2026-01-26-abc123.json",
  "position": { "current": "1", "total": 3 },
  "step": { "name": "1", "description": "First Step" }
}
```

### `rd fail` (stop)

**Text:**
```
File:     runbooks/deploy.runbook.md
State:    .claude/rundown/runs/wf-2026-01-26-abc123.json

Runbook:  STOP
```

**JSON:**
```json
{
  "result": false,
  "action": "STOP",
  "file": "runbooks/deploy.runbook.md",
  "state": ".claude/rundown/runs/wf-2026-01-26-abc123.json",
  "position": { "current": "1", "total": 3 }
}
```

---

## goto

### `rd goto <step>`

**Text:**
```
File:     runbooks/deploy.runbook.md
State:    .claude/rundown/runs/wf-2026-01-26-abc123.json

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
  "result": true,
  "action": "GOTO",
  "target": "3",
  "file": "runbooks/deploy.runbook.md",
  "state": ".claude/rundown/runs/wf-2026-01-26-abc123.json",
  "from": { "current": "1", "total": 5 },
  "to": { "current": "3", "total": 5 },
  "step": { "name": "3", "description": "Target Step" }
}
```

---

## stop

### `rd stop [message]`

**Text:**
```
File:     runbooks/deploy.runbook.md
State:    .claude/rundown/runs/wf-2026-01-26-abc123.json

Runbook:  STOP
```

**JSON:**
```json
{
  "result": true,
  "action": "stopped",
  "message": "User requested stop",
  "file": "runbooks/deploy.runbook.md",
  "state": ".claude/rundown/runs/wf-2026-01-26-abc123.json"
}
```

---

## complete

### `rd complete [message]`

**Text:**
```
File:     runbooks/deploy.runbook.md
State:    .claude/rundown/runs/wf-2026-01-26-abc123.json

Runbook:  COMPLETE
```

**JSON:**
```json
{
  "result": true,
  "action": "complete",
  "message": "Deployment finished",
  "file": "runbooks/deploy.runbook.md",
  "state": ".claude/rundown/runs/wf-2026-01-26-abc123.json"
}
```

---

## stash

### `rd stash`

**Text:**
```
File:     runbooks/deploy.runbook.md
State:    .claude/rundown/runs/wf-2026-01-26-abc123.json
Prompt:   Yes

Step:     1/3

Runbook:  STASHED
```

**JSON:**
```json
{
  "result": true,
  "action": "stashed",
  "file": "runbooks/deploy.runbook.md",
  "state": ".claude/rundown/runs/wf-2026-01-26-abc123.json",
  "prompted": true,
  "position": { "current": "1", "total": 3 }
}
```

---

## pop

### `rd pop`

**Text:**
```
File:     runbooks/deploy.runbook.md
State:    .claude/rundown/runs/wf-2026-01-26-abc123.json
Prompt:   Yes

Action:   PASS
Result:   PASS

## 2. Second Step

Step description.
```

**JSON:**
```json
{
  "result": true,
  "action": "restored",
  "file": "runbooks/deploy.runbook.md",
  "state": ".claude/rundown/runs/wf-2026-01-26-abc123.json",
  "prompted": true,
  "position": { "current": "2", "total": 3 },
  "step": { "name": "2", "description": "Second Step" },
  "lastAction": { "action": "PASS", "result": true }
}
```

### `rd pop` (nothing stashed)

**Text:**
```
No stashed runbook to restore.
```

**JSON:**
```json
{
  "result": false,
  "error": "No stashed runbook to restore"
}
```

---

## prune

### `rd prune --dry-run`

**Text:**
```
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
  }
]
```

### `rd prune`

**Text:**
```
Pruned 2 stale state files.
```

**JSON:**
```json
{
  "result": true,
  "action": "pruned",
  "count": 2
}
```

---

## check

### `rd check <file>` (valid)

**Text:**
```
PASS: 3 steps, 2 substeps
```

**JSON:**
```json
{
  "result": true,
  "valid": true,
  "errors": [],
  "stats": { "steps": 3, "substeps": 2 }
}
```

### `rd check <file>` (invalid)

**Text:**
```
FAIL
Line 15: Unknown transition target "step4"
Line 22: Missing command in step
```

**JSON:**
```json
{
  "result": false,
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
```
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
```
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
```
Error: Scenario "unknown" not found
Available: success, failure
```

**JSON:**
```json
{
  "result": false,
  "error": "Scenario \"unknown\" not found",
  "available": ["success", "failure"]
}
```

---

## scenario run

### `rd scenario run <file> <name>`

**Text:**
```
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
  "result": true,
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
```
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
```
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
```
```
Hello world
```
```

**JSON:**
```json
{
  "content": "Hello world"
}
```

---

## Error Output (all commands)

### No active runbook

**Text:**
```
No active runbook.
```

**JSON:**
```json
{
  "result": false,
  "error": "No active runbook"
}
```

### File not found

**Text:**
```
Error: Runbook file not found: missing.runbook.md
```

**JSON:**
```json
{
  "result": false,
  "error": "Runbook file not found: missing.runbook.md"
}
```
