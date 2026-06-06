# CLI Output Specification

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## Conventions

### Response Type Detection

Every non-list JSON response carries a `kind` discriminant as its first-class, authoritative type tag. Consumers MUST detect the response type by reading `kind`; field-presence heuristics are non-normative and MUST NOT be relied upon. List responses are raw JSON arrays and carry no `kind`.

| `kind` | Response type | Emitted by |
|--------|---------------|------------|
| `error` | Error response | any command on failure |
| `warning` | Warning (non-error, exit 0) | any command (e.g. "No active runbook") |
| `action` | Step action / lifecycle response | `pass`, `fail`, `goto`, `stop`, `complete` |
| `status` | Status response | `status` |
| `check` | Validation response | `check` |
| `resolve` | Variable/source resolution response | `resolve` |
| `echo` | Echo response | `echo` |
| `prompt` | Prompt response | `prompt` |
| `stash` | Stash response | `stash` |
| `pop` | Pop response | `pop` |
| `scenario_run` | Scenario run result | `scenario run` |
| `scenario_suite_run` | Scenario suite aggregate result | `scenario-suite run` |
| `run` | Run command execution summary | `run` (final terminal object) |
| `delegate` | Delegate response | `delegate` |
| `claim` | Claim response | `claim` |
| `abort` | Abort response | `abort` |
| `collect` | Collect response | `collect` |

List responses (`ls`, `prune`, `scenario ls`, `scenario-suite ls`) are detected by `Array.isArray()` and carry no `kind` field.

### Key Conventions

- **Discriminant**: All non-list responses carry a `kind` literal. It is the primary, authoritative type discriminant.
- **Lists**: Raw arrays `[...]` (no wrapper object, no `kind`)
- **Workflow commands**: Include `action` field. Transition commands (`pass`, `fail`, `goto`) use transition text; lifecycle/session commands (`run`, `stop`, `complete`, `stash`, `pop`) use command-name actions.
- **Errors**: `{ "kind": "error", "error": "message", "code": "CODE" }`. The `command` field names the CLI command that triggered the error when known.
- **Warnings**: `{ "kind": "warning", "message": "message", "code": "CODE" }`
- **Success/failure**: Workflow commands use exit code, not a `result` field
- **Position**: `{ "current": string, "total": number }`
- **Action field**: For transition commands, shows transition text (e.g., "CONTINUE", "GOTO 3", "RETRY"); for lifecycle/session commands, shows the command-name action (e.g., "complete", "stop", "stash", "pop").

### Schema Reference

Authoritative response schemas: `packages/core/src/output/zod-schemas.ts`. These Zod schemas are the single source of truth; the TypeScript response types are derived from them via `z.infer<>`. The `packages/core/src/output/schema.ts` module is a re-export barrel of those derived types plus type guards.

The `--schema` flag's command-to-schema map lives in `packages/cli/src/schemas/output-schemas.ts` (`COMMAND_SCHEMAS`).

### Unified Types

**Runbook** - Used by `ls` and `prune` for runbook listings:
```json
{
  "id": "string",      // State file identifier
  "runbook": "string", // Runbook filename
  "status": "string",  // active, stashed, complete, stopped, inactive, invalid
  "step": "string",    // (optional) Current step position
  "total": number,     // (optional) Total steps
  "title": "string"    // (optional) Runbook title
}
```

**RunbookRef** - Resolved runbook identity stored on artifact records:

```json
{
  "source": "project",
  "path": "planning/write-plan.runbook.md"
}
```

`source` is one of `project`, `plugin`, `bundled`, or `external`.

**ArtifactRecord** - Structured artifact value and manifest row shape:

```json
{
  "kind": "artifact-record",
  "uri": "rd://artifacts/ctx1/rd_0123456789abcdef0123456789abcdef/plan.json",
  "path": "/project/.rundown/work/.rd-ctx1/rd_0123456789abcdef0123456789abcdef/plan.json",
  "runId": "rd_0123456789abcdef0123456789abcdef",
  "contextId": "ctx1",
  "runbook": {
    "source": "project",
    "path": "planning/write-plan.runbook.md"
  },
  "key": "plan.json",
  "timestamp": "2026-05-07T00:00:00.000Z"
}
```

The `uri` field uses the `rd:` URI scheme. The URI grammar, component constraints, and round-trip rules are normatively defined in [docs/spec/uri.md](uri.md); the `ArtifactRecord` field set and canonical write order are in [uri.md §8](uri.md#8-manifest-record).

**ArtifactMap** - Object keyed by artifact variable name. Values are either `ArtifactRecord` or `ArtifactRecord[]`:

```json
{
  "PlanPath": {
    "kind": "artifact-record",
    "uri": "rd://artifacts/ctx1/rd_0123456789abcdef0123456789abcdef/plan.json",
    "path": "/project/.rundown/work/.rd-ctx1/rd_0123456789abcdef0123456789abcdef/plan.json",
    "runId": "rd_0123456789abcdef0123456789abcdef",
    "contextId": "ctx1",
    "runbook": {
      "source": "project",
      "path": "planning/write-plan.runbook.md"
    },
    "key": "plan.json",
    "timestamp": "2026-05-07T00:00:00.000Z"
  },
  "Reviews": []
}
```

Empty wildcard results are represented as `[]`. Required current-unit artifact fields use `{}` when empty. Optional accumulated artifact fields are omitted when empty. `null` is not used as an absence marker.

Future schema tests should assert that active current-unit fields use empty containers when empty, optional accumulated fields are omitted when empty, inactive status omits artifact fields, and `rd run` JSON output remains newline-delimited event objects.

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
State:    .rundown/runs/rd_0123456789abcdef0123456789abcdef.json
Prompt:   Yes

## 1. First Step

Step description here.
```

**JSON:**
```json
{
  "kind": "status",
  "active": true,
  "stashed": false,
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/runs/rd_0123456789abcdef0123456789abcdef.json",
  "prompted": true,
  "position": { "current": "1", "total": 3 },
  "step": { "name": "1", "description": "First Step" }
}
```

Active status responses always include `lastAction`. They include `vars` when scalar variables are present (it is omitted when there are none), and additionally include `delegations` and `parentLinkage` when present. Accumulated artifact records live in the unified `state.variables` map alongside other variables and are surfaced through `vars` rather than a separate field.

### `rd status` (no active runbook)

**Text:**
```text
No active runbook.
```

**JSON:**
```json
{
  "kind": "status",
  "active": false,
  "stashed": false
}
```

Inactive status responses carry only `kind`, `active`, and `stashed`.

### `rd status --claim-id <claim_id>`

Same output shape as active `rd status`, but resolves the delegated child identified by `claim_id` instead of the default stack. Invalid, missing, stale, terminal, or unlinked claim ids return an error response.

---

## run

### `rd run <file>`

**Text:**
```text
File:     runbooks/deploy.runbook.md
State:    .rundown/runs/rd_0123456789abcdef0123456789abcdef.json

Action:   START

## 1. First Step

Step description here.

$ echo "hello"
hello

Runbook:  COMPLETE
```

**JSON:**

`rd run` emits newline-delimited JSON events. Each line is one JSON object. Event type names are lowercase snake_case, and event payload fields are flattened onto the JSONL object alongside envelope fields such as `timestamp`, `runbookId`, `runbook`, and `seq`. The final line is a terminal lifecycle event.

```jsonl
{"type":"runbook_started","prompted":false,"statePath":".rundown/runs/rd_0123456789abcdef0123456789abcdef.json","timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":1}
{"type":"step_entered","position":{"current":"1","total":1},"stepName":"1","description":"First Step","hasCommand":true,"commandCode":"echo \"hello\"","commandLang":"bash","isSubstep":false,"prompted":false,"artifacts":{},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":2}
{"type":"command_started","command":"echo \"hello\"","displayCommand":"echo \"hello\"","position":{"current":"1","total":1},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":3}
{"type":"command_completed","command":"echo \"hello\"","success":true,"exitCode":0,"position":{"current":"1","total":1},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":4}
{"type":"runbook_completed","finalPosition":{"current":"1","total":1},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":5}
```

The internal event payload field is `STEP_ENTERED.payload.artifacts`; the CLI JSONL field is flattened as `artifacts` on the `step_entered` line. `artifacts` is required and contains only the entered step/substep's working set. It is `{}` when that execution unit has no `ARTIFACTS` directive. It is not the full accumulated variable map; accumulated artifact records live in `state.variables`.

Runtime command text is rendered once per execution. The exact rendered string is reused for the flattened `step_entered.commandCode` field and actual command execution.

### `STEP_ENTERED` with artifacts

```jsonl
{"type":"step_entered","position":{"current":"2","total":4},"stepName":"2","description":"Write plan","hasCommand":true,"commandCode":"printf '%s\n' '/project/.rundown/work/.rd-ctx1/rd_0123456789abcdef0123456789abcdef/plan.json'","commandLang":"bash","isSubstep":false,"prompted":false,"artifacts":{"PlanPath":{"kind":"artifact-record","uri":"rd://artifacts/ctx1/rd_0123456789abcdef0123456789abcdef/plan.json","path":"/project/.rundown/work/.rd-ctx1/rd_0123456789abcdef0123456789abcdef/plan.json","runId":"rd_0123456789abcdef0123456789abcdef","contextId":"ctx1","runbook":{"source":"project","path":"planning/write-plan.runbook.md"},"key":"plan.json","timestamp":"2026-05-07T00:00:00.000Z"},"Reviews":[]},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"planning/write-plan.runbook.md"},"seq":2}
```

`Reviews: []` is a meaningful empty wildcard result and must be preserved in JSON output.

Text output remains human-readable and does not print raw artifact JSON by default. Artifact values may appear in rendered prompt or command text when authors reference them directly or through helpers. JSON output is the authoritative interface for artifact identity and provenance.

## `rd artifact`

`rd artifact ls`, `inspect`, `path`, and `uri` expose core artifact projections
for the active run context. JSON output is schema-backed and full-record by
default for agents. These commands do not read or write artifact file contents;
they only list, inspect, or project artifact aliases and URIs.
`rd artifact path --text` and `rd artifact uri --text` are the only concise
projection outputs.

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
  "kind": "claim",
  "action": "claimed",
  "token": "rdtk_abcd...",
  "claim_id": "rdclm_F3J3n3d_f8fo0a0b1B2c3Q",
  "run_id": "rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "runbook": "child.runbook.md",
  "parent_run_id": "rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
State:    .rundown/runs/rd_0123456789abcdef0123456789abcdef.json

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
  "kind": "action",
  "action": "CONTINUE",
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/runs/rd_0123456789abcdef0123456789abcdef.json",
  "from": "1",
  "at": "2"
}
```

`from` and `at` are plain qualified step-ID strings (the step before the transition, and the step after). There is no `to` field.

### `rd pass --claim-id <claim_id>`

Same output shape as `rd pass`, but targets the delegated child identified by `claim_id` instead of the default stack.

---

## fail

The `action` field shows the transition (e.g., "RETRY (1/3)" for retry, "STOP" for stopping).

### `rd fail` (retry)

**Text:**
```text
File:     runbooks/deploy.runbook.md
State:    .rundown/runs/rd_0123456789abcdef0123456789abcdef.json

Action:   RETRY (1/3)
At:       1/3

## 1. First Step

Step description.
```

**JSON:**
```json
{
  "kind": "action",
  "action": "RETRY (1/3)",
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/runs/rd_0123456789abcdef0123456789abcdef.json",
  "at": "1"
}
```

### `rd fail` (stop)

**Text:**
```text
File:     runbooks/deploy.runbook.md
State:    .rundown/runs/rd_0123456789abcdef0123456789abcdef.json

Runbook:  STOP
```

**JSON:**
```json
{
  "kind": "action",
  "action": "STOP",
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/runs/rd_0123456789abcdef0123456789abcdef.json",
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
State:    .rundown/runs/rd_0123456789abcdef0123456789abcdef.json

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
  "kind": "action",
  "action": "GOTO 3",
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/runs/rd_0123456789abcdef0123456789abcdef.json",
  "from": "1",
  "at": "3"
}
```

---

## stop

### `rd stop [message]`

Uses `action: "stop"` (command-name action). Stopping sets a non-zero exit code.

**Text:**
```text
File:     runbooks/deploy.runbook.md
State:    .rundown/runs/rd_0123456789abcdef0123456789abcdef.json

Runbook:  STOP
```

**JSON:**
```json
{
  "kind": "action",
  "action": "stop",
  "stopped": true,
  "message": "User requested stop",
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/runs/rd_0123456789abcdef0123456789abcdef.json"
}
```

---

## complete

### `rd complete [message]`

**Text:**
```text
File:     runbooks/deploy.runbook.md
State:    .rundown/runs/rd_0123456789abcdef0123456789abcdef.json

Runbook:  COMPLETE
```

**JSON:**
```json
{
  "kind": "action",
  "action": "complete",
  "complete": true,
  "message": "Deployment finished",
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/runs/rd_0123456789abcdef0123456789abcdef.json"
}
```

---

## stash

### `rd stash`

Uses `action: "stash"` (command-name action).

**Text:**
```text
File:     runbooks/deploy.runbook.md
State:    .rundown/runs/rd_0123456789abcdef0123456789abcdef.json
Prompt:   Yes

Step:     1/3

Runbook:  STASHED
```

**JSON:**
```json
{
  "kind": "stash",
  "action": "stash",
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/runs/rd_0123456789abcdef0123456789abcdef.json",
  "prompted": true,
  "position": { "current": "1", "total": 3 }
}
```

### `rd stash --claim-id <claim_id>`

Same output shape as `rd stash`, but stashes the delegated child identified by `claim_id`.

---

## pop

### `rd pop`

Uses `action: "pop"` (command-name action).

**Text:**
```text
File:     runbooks/deploy.runbook.md
State:    .rundown/runs/rd_0123456789abcdef0123456789abcdef.json
Prompt:   Yes

Action:   PASS
Result:   PASS

## 2. Second Step

Step description.
```

**JSON:**
```json
{
  "kind": "pop",
  "action": "pop",
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/runs/rd_0123456789abcdef0123456789abcdef.json",
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
  "kind": "error",
  "error": "No stashed runbook to restore",
  "code": "NO_STASHED_RUNBOOK",
  "command": "pop"
}
```

---

## prune

Prune uses the same `Runbook` format as `ls`, with status values like "invalid" or "inactive".

### `rd prune --dry-run`

**Text:**
```text
ID        STATUS     RUNBOOK                    TITLE
abc123    invalid    (invalid)
def456    inactive   old-deploy.runbook.md      Old Deploy
```

**JSON:**
```json
[
  {
    "id": "abc123",
    "status": "invalid",
    "runbook": "(invalid)"
  },
  {
    "id": "def456",
    "status": "inactive",
    "runbook": "old-deploy.runbook.md",
    "title": "Old Deploy"
  }
]
```

### `rd prune`

Both dry-run and actual prune output the same format.

**Text:**
```text
Pruned 2 invalid state files.
```

**JSON:**
```json
[
  {
    "id": "abc123",
    "status": "invalid",
    "runbook": "(invalid)"
  },
  {
    "id": "def456",
    "status": "inactive",
    "runbook": "old-deploy.runbook.md",
    "title": "Old Deploy"
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
  "kind": "check",
  "valid": true,
  "errors": [],
  "warnings": [],
  "stats": { "steps": 3, "substeps": 2 }
}
```

The `warnings` array is optional. When present, each entry has a `message` and an optional `line` and `kind`.

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
  "kind": "check",
  "valid": false,
  "errors": [
    { "line": 15, "message": "Unknown transition target \"step4\"" },
    { "line": 22, "message": "Missing command in step" }
  ],
  "warnings": []
}
```

`stats` is present only when the runbook is structurally valid.

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
  "kind": "error",
  "error": "Scenario \"unknown\" not found",
  "code": "SCENARIO_NOT_FOUND",
  "command": "scenario show",
  "details": {
    "available": ["success", "failure"]
  }
}
```

---

## scenario run

### `rd scenario run <file> <name>`

Uses `result` (a boolean) to indicate scenario outcome. This is scenario verification, not workflow — the boolean is the verification verdict, not a step result.

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
  "kind": "scenario_run",
  "result": true,
  "scenario": "success",
  "expected": "COMPLETE",
  "actual": "COMPLETE"
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
  "kind": "echo",
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
  "kind": "echo",
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
  "kind": "prompt",
  "output": "Hello world"
}
```

---

## Error Output (all commands)

Error responses carry `kind: "error"` along with `error` and `code` fields. When the triggering command is known, a `command` field names it. A non-zero exit code indicates failure.

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
  "kind": "error",
  "error": "Runbook not found: missing.runbook.md",
  "code": "RUNBOOK_NOT_FOUND",
  "command": "run"
}
```
