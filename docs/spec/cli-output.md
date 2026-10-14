# CLI Output Specification

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be
interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## Conventions

### Response Type Detection

Every non-list JSON response carries a `kind` discriminant as its first-class,
authoritative type tag. Consumers MUST detect the response type by reading
`kind`; field-presence heuristics are non-normative and MUST NOT be relied upon.
List responses are raw JSON arrays and carry no `kind`.

| `kind`               | Response type                       | Emitted by                                 |
| -------------------- | ----------------------------------- | ------------------------------------------ |
| `error`              | Error response                      | any command on failure                     |
| `warning`            | Warning (non-error, exit 0)         | any command (e.g. "No active runbook")     |
| `action`             | Step action / lifecycle response    | `pass`, `fail`, `goto`, `stop`, `complete` |
| `status`             | Status response                     | `status`                                   |
| `check`              | Validation response                 | `check`                                    |
| `resolve`            | Variable/source resolution response | `resolve`                                  |
| `echo`               | Echo response                       | `echo`                                     |
| `prompt`             | Prompt response                     | `prompt`                                   |
| `scenario_run`       | Scenario run result                 | `scenario run`                             |
| `scenario_suite_run` | Scenario suite aggregate result     | `scenario-suite run`                       |

List responses (`ls`, `prune`, `scenario ls`, `scenario-suite ls`) are detected
by `Array.isArray()` and carry no `kind` field.

Streamed events (`rundown run`, and the observations a transition or terminal
command emits before its final object) are newline-delimited JSON objects
discriminated by `type`, not `kind`. When a command streams events, every line
of its stdout — including the final `kind`-tagged object — is compact,
single-line JSON; a command that streams nothing prints its one object
pretty-printed.

### Key Conventions

- **Discriminant**: All non-list responses carry a `kind` literal. It is the
  primary, authoritative type discriminant.
- **Lists**: Raw arrays `[...]` (no wrapper object, no `kind`)
- **Workflow commands**: Include `action` field. Transition commands (`pass`,
  `fail`, `goto`) use transition text; lifecycle commands (`stop`, `complete`)
  use command-name actions.
- **Errors**: `{ "kind": "error", "error": "message", "code": "CODE" }`. The
  `command` field names the CLI command that triggered the error when known.
- **Warnings**: `{ "kind": "warning", "message": "message", "code": "CODE" }`
- **Success/failure**: Workflow commands use exit code, not a `result` field
- **Position**: `{ "current": string, "total": number }`
- **Action field**: For transition commands, shows transition text (e.g.,
  "CONTINUE", "GOTO 1", "RETRY (1/3)"); for lifecycle commands and for a
  transition that ends the run, shows the command-name action (`"complete"`,
  `"stop"`).
- **Authority**: Mutating commands (`pass`, `fail`, `goto`, `stop`, `complete`,
  `collect`, and `prune --token`) name the run they mutate with
  `--token <owner_token>`. The Owner Token is printed once, as `owner_token` on
  the `runbook_started` event of `rundown run` — or, for a delegated child, of
  `rundown claim` — and appears in no other output. A Claim Ticket (`rdt_…`) is
  printed once, in the `children` of the `step_entered` event that issued it,
  and is `rundown claim`'s only authority. `--run <rd_…>` is a read-only
  selector (`status`, `artifact`) and is never mutation authority, except in the
  human escape hatch `rundown stop --run`, which requires a person at an
  interactive terminal ([Escape hatch](#escape-hatch-refusals)).

### Schema Reference

Authoritative response schemas: `packages/core/src/output/zod-schemas.ts`. These
Zod schemas are the single source of truth; the TypeScript response types are
derived from them via `z.infer<>`. The `packages/core/src/output/schema.ts`
module is a re-export barrel of those derived types plus type guards.

The `--schema` flag's command-to-schema map lives in
`packages/cli/src/schemas/output-schemas.ts` (`COMMAND_SCHEMAS`).

### Unified Types

**Runbook** - Used by `ls`, `prune`, and the bare `status` list for run
listings:

```json
{
  "id": "string",      // Run identifier (`rd_` + 32 hex)
  "runbook": "string", // Runbook filename
  "status": "string",  // running, complete, stopped, abandoned, invalid
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

The `uri` field uses the `rd:` URI scheme. The URI grammar, component
constraints, and round-trip rules are normatively defined in
[docs/spec/uri.md](uri.md); the `ArtifactRecord` field set and canonical write
order are in [uri.md §8](uri.md#8-manifest-record).

**ArtifactMap** - Object keyed by artifact variable name. Values are either
`ArtifactRecord` or `ArtifactRecord[]`:

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

Empty wildcard results are represented as `[]`. Required current-unit artifact
fields use `{}` when empty. Optional accumulated artifact fields are omitted
when empty. `null` is not used as an absence marker.

Future schema tests should assert that active current-unit fields use empty
containers when empty, optional accumulated fields are omitted when empty,
inactive status omits artifact fields, and `rundown run` JSON output remains
newline-delimited event objects.

---

## ls

### `rundown ls`

Lists every persisted run. The Owner Token is never listed.

**Text:**

Text mode truncates the run id to its first 8 characters; JSON carries it in
full.

```text
ID        STATUS   STEP  RUNBOOK                     TITLE
rd_01234  running  1/3   runbooks/deploy.runbook.md  Deploy to Production
```

**JSON:**

```json
[
  {
    "id": "rd_0123456789abcdef0123456789abcdef",
    "runbook": "runbooks/deploy.runbook.md",
    "step": "1",
    "status": "running",
    "total": 3,
    "title": "Deploy to Production"
  }
]
```

With no persisted runs, JSON is `[]` and text is:

```text
No runs.
Run "rundown ls --all" to see available runbooks.
```

### `rundown ls --all`

**Text:**

```text
NAME    SOURCE   DESCRIPTION           TAGS
deploy  project  Deploy to production  deploy, ci
```

**JSON:**

`path` is absolute.

```json
[
  {
    "name": "deploy",
    "source": "project",
    "description": "Deploy to production",
    "tags": ["deploy", "ci"],
    "path": "/project/.rundown/runbooks/deploy.runbook.md"
  }
]
```

---

## status

`status` is read-only and takes no `--token`. Bare, it lists every run; with
`--run <rd_…>` it describes one run in detail. No status response carries an
Owner Token.

### `rundown status` (run list)

**Text:**

```text
ID                                   STATUS   STEP  RUNBOOK                     TITLE
rd_0123456789abcdef0123456789abcdef  running  1/3   runbooks/deploy.runbook.md  Deploy to Production
```

**JSON:**

```json
{
  "active": false,
  "runs": [
    {
      "id": "rd_0123456789abcdef0123456789abcdef",
      "runbook": "runbooks/deploy.runbook.md",
      "status": "running",
      "step": "1",
      "total": 3,
      "title": "Deploy to Production"
    }
  ],
  "kind": "status"
}
```

The list form describes no run in particular, so `active` is always `false`;
each entry's `status` is that run's lifecycle (`running`, `complete`, `stopped`,
or `abandoned`). A run whose current step holds the execution lease also carries
`execution` (see [Execution condition](#execution-condition)), and its text
STATUS reads `running (in progress)` or `running (interrupted)`. A run whose
persisted state this build cannot read is left out of the list, and a
`[rundown] Warning: Invalid runbook state for …` line is written to stderr; see
[`RD-309`](#rd-309--invalid-persisted-run-state).

### `rundown status` (no runs)

**Text:**

```text
No runs.
```

**JSON:**

```json
{
  "active": false,
  "runs": [],
  "kind": "status"
}
```

### Execution condition

While a run's current step holds the execution lease — its command has started
and its finish has not committed — both status forms carry an `execution`
object. It is absent otherwise.

```json
{
  "execution": {
    "condition": "interrupted",
    "step": "1",
    "attempt": 2,
    "pid": 4242,
    "startedAt": "2026-10-13T12:00:00.000Z"
  }
}
```

| Field       | Meaning                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `condition` | `in_progress` — the process that started the command is alive; `interrupted` — it is gone and the outcome is unknown                             |
| `step`      | The step (`step` or `step.substep`) whose command holds the lease                                                                                |
| `attempt`   | The attempt holding the lease                                                                                                                    |
| `pid`       | The process that started the command. Liveness is decided by this pid together with that process's start identity, so a reused pid reads as gone |
| `startedAt` | ISO-8601 time the command started                                                                                                                |

The `--text` detail form adds one line:
`Execution: Interrupted (step 1, pid 4242, started 2026-10-13T12:00:00.000Z)`.
See [Execution in progress](#execution-in-progress) and
[Execution interrupted](#execution-interrupted) for the refusals each condition
produces.

### Child runs

An Inline Child (#903) or a Delegation (#904) is a run with its own id and its
own row, so it appears in the run list like any run. Each child carries `parent`
— in its list entry and in its `--run` detail. A run whose current step composes
an Inline Child carries `child` in its `--run` detail, and a run whose current
step delegates carries `children`. Following `parent` from an inline child
reaches the root, whose Owner Token drives the whole inline chain. No field ever
carries a token or a Claim Ticket.

```json
{
  "id": "rd_6d2c64e0c61fd41fb0a02f3a91c43f40",
  "runbook": ".rundown/runbooks/child.runbook.md",
  "status": "running",
  "step": "Check",
  "total": 0,
  "parent": {
    "runId": "rd_f9d07121b3784ffcefa3579c4e887f1f",
    "step": "1.2",
    "kind": "inline"
  }
}
```

```json
{
  "child": {
    "runId": "rd_6d2c64e0c61fd41fb0a02f3a91c43f40",
    "kind": "inline",
    "status": "running"
  }
}
```

| Field          | Meaning                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `parent.runId` | The parent run                                                                                                                |
| `parent.step`  | The parent substep (`step.substep`) the child runs for                                                                        |
| `parent.kind`  | `inline` — the parent's Owner Token drives the child; `delegation` — the child's own token, printed by `rundown claim`, does  |
| `child.runId`  | The child the run's current step counts; a child from an earlier entry into the step (a loop, `GOTO` or `RETRY`) is not shown |
| `child.status` | The child's lifecycle (`running`, `completed`, `stopped`), or `reserved` before its run exists                                |

A delegating step's Delegations of the current entry, by id, lifecycle and Child
Result only:

```json
{
  "children": [
    {
      "runId": "rd_1b63d698a4ca35c6fa2e8c5ad4a4f779",
      "step": "1.1",
      "status": "completed",
      "result": "pass"
    },
    { "runId": "rd_05cf2674816f973e6434760c30cb55bb", "step": "1.2", "status": "reserved" }
  ]
}
```

| Field               | Meaning                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `children[].step`   | The delegated substep (`step.substep`); `index` is added inside a FOR loop                                 |
| `children[].status` | The child's lifecycle (`running`, `completed`, `stopped`, `abandoned`), or `reserved` before it is claimed |
| `children[].result` | The Child Result once the child is terminal: `pass` for `completed`, `fail` otherwise                      |

The text forms add a `PARENT` column to the list and `Parent:` / `Child:` /
`Delegation:` lines to the detail.

### Human stop audit

A run stopped through the human escape hatch
([`rundown stop --run`](#escape-hatch-refusals)) carries the audit the stop
recorded, in the detail form:

```json
{
  "kind": "status",
  "active": false,
  "status": "stopped",
  "runId": "rd_0123456789abcdef0123456789abcdef",
  "humanStop": {
    "at": "2026-10-14T09:30:00.000Z",
    "user": "alice",
    "host": "build-07",
    "message": "Lost the owner token"
  }
}
```

| Field               | Meaning                                                  |
| ------------------- | -------------------------------------------------------- |
| `humanStop.at`      | ISO-8601 time the human confirmed the stop               |
| `humanStop.user`    | Login name of the user at the terminal                   |
| `humanStop.host`    | Host the terminal was on                                 |
| `humanStop.message` | The stop message, the human's reason; absent without one |

The text form adds a
`Stopped by <user> on <host> at <at>, without the owner token[: <message>]`
line.

### `rundown status --claimed-by <agent-id>`

The Delegations that still hold an agent: running, claimed under that agent id,
and still counted by their parent. The Claude Code plugin's `SubagentStop` hook
blocks a sub-agent while the list is not empty. Run ids and step labels only:

```json
{
  "kind": "claimed_delegations",
  "agentId": "a5a1f32a3ad196aa7",
  "delegations": [
    {
      "runId": "rd_7af1d92df90a405edbf718ca20012b3f",
      "runbook": "child.runbook.md",
      "parentRunId": "rd_46cbdd5f19324d3b91667e2ff0e96386",
      "step": "1.1"
    }
  ]
}
```

A finished, abandoned or cancelled child, one whose parent finished or was
pruned, and another agent's child are not listed; an agent holding nothing gets
`"delegations": []`. `--claimed-by` with `--run`, or empty, is refused
`INVALID_SYNTAX`.

### `rundown status --run <rd_…>`

**Text:**

```text
File:     runbooks/deploy.runbook.md
State:    .rundown/rundown.db
Run:      rd_0123456789abcdef0123456789abcdef
Action:   START

## 1. First Step

Entry: 1

Vars:
  Date: 2026-05-07
  DateTime: 2026-05-07T00:00:00.000Z
  Year: 2026
  Month: 05
  Day: 07
  Branch: main
  WorkPath: .rundown/work
  ContextId: ctx1
  context.vars.Date: 2026-05-07
  context.vars.DateTime: 2026-05-07T00:00:00.000Z
  context.vars.Year: 2026
  context.vars.Month: 05
  context.vars.Day: 07
  context.vars.Branch: main
  context.vars.WorkPath: .rundown/work
  context.vars.ContextId: ctx1
  RunId: rd_0123456789abcdef0123456789abcdef
```

**JSON:**

```json
{
  "active": true,
  "file": "runbooks/deploy.runbook.md",
  "state": ".rundown/rundown.db",
  "runId": "rd_0123456789abcdef0123456789abcdef",
  "prompted": false,
  "position": {
    "current": "1",
    "total": 3,
    "frameKey": "1|",
    "entry": 1
  },
  "step": {
    "name": "1",
    "description": "First Step"
  },
  "lastAction": {
    "action": "START"
  },
  "vars": {
    "Date": "2026-05-07",
    "DateTime": "2026-05-07T00:00:00.000Z",
    "Year": "2026",
    "Month": "05",
    "Day": "07",
    "Branch": "main",
    "WorkPath": ".rundown/work",
    "ContextId": "ctx1",
    "context.vars.Date": "2026-05-07",
    "context.vars.DateTime": "2026-05-07T00:00:00.000Z",
    "context.vars.Year": "2026",
    "context.vars.Month": "05",
    "context.vars.Day": "07",
    "context.vars.Branch": "main",
    "context.vars.WorkPath": ".rundown/work",
    "context.vars.ContextId": "ctx1",
    "RunId": "rd_0123456789abcdef0123456789abcdef"
  },
  "kind": "status"
}
```

Detail responses always include `lastAction`. They include `vars` when scalar
variables are present (it is omitted when there are none) and `artifacts` when
artifact variables are present. Accumulated artifact records live in the unified
`state.variables` map alongside other variables.

`state` names the SQLite authority and is the same constant for every run, so
`runId` is what identifies which run the response describes.

A **finished** run is an answer, not a refusal: the same body at exit `0`, with
`active: false` and a `status` of `completed`, `stopped`, or `abandoned`. Text
renders the outcome as `Runbook:  COMPLETE` / `Runbook:  STOP` in place of the
step block:

```text
File:     runbooks/deploy.runbook.md
State:    .rundown/rundown.db
Run:      rd_0123456789abcdef0123456789abcdef
Runbook:  COMPLETE
```

An id that names no run is refused `RUN_TARGET_UNAVAILABLE`, and a malformed id
`INVALID_RUN_ID`; see [Error Output](#error-output-all-commands).

---

## run

### `rundown run <file>`

`rundown run` is the only command that prints the run's Owner Token: once, as
`owner_token` on the `runbook_started` event (`Owner token:` in text). Every
later mutating command names the run with `--token <owner_token>`.

**Text:**

`--text` also writes a one-line notice to stderr reminding agents to use the
default JSON output.

```text
File:     runbooks/cmd.runbook.md
State:    .rundown/rundown.db
Run:      rd_0123456789abcdef0123456789abcdef
Owner token: rdo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
Action:   START

## 1. First Step
hello

$ echo "hello"


─── 1 ────────────────────────────────────────────
Action:   CONTINUE
From:     1
Command:  echo "hello"
Result:   PASS
At:       1
Runbook:  COMPLETE
```

**JSON:**

`rundown run` emits newline-delimited JSON events. Each line is one JSON object.
Event type names are lowercase snake_case, and event payload fields are
flattened onto the JSONL object alongside envelope fields such as `timestamp`,
`runbookId`, `runbook`, and `seq`. The stream ends either with a terminal
lifecycle event (`runbook_completed` or `runbook_stopped`) or, when the run
rests at a step that awaits `rundown pass` / `rundown fail`, with that step's
`step_entered` event.

In machine-readable mode, stdout is reserved for Rundown JSON/JSONL output. When
a command step executes as part of a Rundown command that emits structured
output, the child command's stdout and stderr are passed through on stderr so
arbitrary command bytes cannot corrupt the JSON stream. `--text` preserves the
human terminal behavior.

```jsonl
{"type":"runbook_started","title":"Command","prompted":false,"owner_token":"rdo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/cmd.runbook.md"},"seq":1}
{"type":"step_entered","position":{"current":"1","total":1},"stepName":"1","description":"First Step","hasCommand":true,"commandCode":"echo \"hello\"","commandLang":"bash","isSubstep":false,"prompted":false,"artifacts":{},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/cmd.runbook.md"},"seq":2}
{"type":"command_started","command":"echo \"hello\"","displayCommand":"echo \"hello\"","position":{"current":"1","total":1},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/cmd.runbook.md"},"seq":3}
{"type":"command_completed","command":"echo \"hello\"","success":true,"exitCode":0,"position":{"current":"1","total":1},"policyDenied":false,"sandboxed":true,"networkPolicy":"deny","networkSandboxed":true,"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/cmd.runbook.md"},"seq":4}
{"type":"step_transitioned","action":"CONTINUE","from":"1","at":"1","result":"PASS","command":"echo \"hello\"","timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/cmd.runbook.md"},"seq":5}
{"type":"runbook_completed","finalPosition":{"current":"1","total":1},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/cmd.runbook.md"},"seq":6}
```

The Owner Token appears on `runbook_started` and on no other event, status
response, or listing, so reading output other than that one line grants no
authority over the run.

The internal event payload field is `STEP_ENTERED.payload.artifacts`; the CLI
JSONL field is flattened as `artifacts` on the `step_entered` line. `artifacts`
is required and contains only the entered step/substep's working set. It is `{}`
when that execution unit has no `ARTIFACTS` directive. It is not the full
accumulated variable map; accumulated artifact records live in
`state.variables`.

Runtime command text is rendered once per execution. The exact rendered string
is reused for the flattened `step_entered.commandCode` field and actual command
execution.

#### Inline children

A runbook-list substep without `DELEGATE` launches an Inline Child (#903). The
stream then carries several runs' events, each under its own `runbookId` and
`runbook`, in order: the parent's `step_entered` for the substep, the child's
`runbook_started` — which carries **no** `owner_token`, because the parent's
token drives the child — and the child's own events. When the child reaches a
terminal, its `runbook_completed` / `runbook_stopped` is followed by the
parent's `step_transitioned` for the substep, and the parent's progression
continues. A child's terminal is not the command's exit status: where the run
the token belongs to rests is. A `stop` / `complete` aimed at the child still
ends with its action object naming the child (see [stop](#stop)). If the stream
rests at a child's `step_entered`, the next `pass` / `fail --step` names that
child's step.

```jsonl
{"type":"step_entered","position":{"current":"1","total":2,"substep":"1"},"stepName":"1","description":"Runbook: child.runbook.md","hasCommand":false,"isSubstep":true,"prompted":false,"artifacts":{},"runbookId":"rd_f9d07121b3784ffcefa3579c4e887f1f","runbook":{"source":"project","path":"parent.runbook.md"},"seq":2}
{"type":"runbook_started","title":"Child","prompted":false,"runbookId":"rd_aab57a8fba1dd497f707f9a216cf2caf","runbook":{"source":"project","path":".rundown/runbooks/child.runbook.md"},"seq":1}
{"type":"runbook_completed","finalPosition":{"current":"1","total":1},"runbookId":"rd_aab57a8fba1dd497f707f9a216cf2caf","runbook":{"source":"project","path":".rundown/runbooks/child.runbook.md"},"seq":6}
{"type":"step_transitioned","action":"CONTINUE","from":"1.1","at":"2","result":"PASS","aggregated":true,"runbookId":"rd_f9d07121b3784ffcefa3579c4e887f1f","runbook":{"source":"project","path":"parent.runbook.md"},"seq":3}
```

(`timestamp` omitted, and the child's step events elided, for brevity.)

An inline child that cannot be launched leaves the parent resting on the
substep, with an `error_occurred` on the parent carrying the reason's code — the
child preparation's own (`RUNBOOK_NOT_FOUND`, `MISSING_REQUIRED_VARS`, …),
`RUNBOOK_COMPOSITION_UNSUPPORTED` for a child with a substep listing more than
one runbook, or `INLINE_CHILD_LAUNCH_FAILED` — and the command exits non-zero.

A runbook with a substep listing more than one runbook is refused before any run
is created; see
[Runbook composition unsupported](#runbook-composition-unsupported).

#### Delegations

A `DELEGATE` runbook-list substep's `step_entered` lists the Delegations its
entry counts — the substep's own and every later delegated substep's — in
`children`. Each carries its Claim Ticket only on the entry that issued it; an
entry announced again (the run moving on to the next delegated substep of the
same entry) lists them without tickets, and no other output ever carries one.

```jsonl
{"type":"step_entered","position":{"current":"1","total":2,"substep":"1"},"stepName":"1","description":"Runbook: child.runbook.md","hasCommand":false,"isSubstep":true,"prompted":false,"artifacts":{},"children":[{"step":"1.1","runId":"rd_7af1d92df90a405edbf718ca20012b3f","runbook":"child.runbook.md","ticket":"rdt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},{"step":"1.2","runId":"rd_fb058ba87b6b900bd1646f7ea3f6175c","runbook":"child.runbook.md","ticket":"rdt_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}],"runbookId":"rd_46cbdd5f19324d3b91667e2ff0e96386","runbook":{"source":"project","path":"parent.runbook.md"},"seq":2}
```

| Field                | Meaning                                                                  |
| -------------------- | ------------------------------------------------------------------------ |
| `children[].step`    | The delegated substep (`step.substep`)                                   |
| `children[].index`   | The FOR iteration the child was reserved in, inside a loop               |
| `children[].runId`   | The child's preallocated run id                                          |
| `children[].runbook` | The runbook the child runs                                               |
| `children[].ticket`  | The Claim Ticket `rundown claim` takes; present only where it was issued |

The text form prints `Delegation <step>: <runbook> (<runId>) ticket <ticket>`
per child.

### `STEP_ENTERED` with artifacts

```jsonl
{"type":"step_entered","position":{"current":"2","total":2},"stepName":"2","description":"Write plan","hasCommand":true,"commandCode":"printf '%s\\n' '/project/.rundown/work/.rd-ctx1/rd_0123456789abcdef0123456789abcdef/plan.json'","commandLang":"bash","isSubstep":false,"prompted":true,"artifacts":{"PlanPath":{"runId":"rd_0123456789abcdef0123456789abcdef","contextId":"ctx1","runbook":{"source":"project","path":".rundown/runbooks/write-plan.runbook.md"},"key":"plan.json","timestamp":"2026-05-07T00:00:00.000Z","kind":"artifact-record","uri":"rd://artifacts/ctx1/rd_0123456789abcdef0123456789abcdef/plan.json","path":"/project/.rundown/work/.rd-ctx1/rd_0123456789abcdef0123456789abcdef/plan.json"},"Reviews":[]},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":".rundown/runbooks/write-plan.runbook.md"},"seq":1}
```

`Reviews: []` is a meaningful empty wildcard result and must be preserved in
JSON output.

Text output remains human-readable and does not print raw artifact JSON by
default. Artifact values may appear in rendered prompt or command text when
authors reference them directly or through helpers. JSON output is the
authoritative interface for artifact identity and provenance.

## claim

### `rundown claim <ticket> [--agent-id <id>]`

The child's event stream, exactly as `rundown run`'s. Its `runbook_started`
carries the child's own `owner_token` (printed nowhere else) and its `parent`:

```jsonl
{"type":"runbook_started","title":"Child","prompted":false,"parent":{"runId":"rd_46cbdd5f19324d3b91667e2ff0e96386","step":"1.1"},"owner_token":"rdo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","runbookId":"rd_7af1d92df90a405edbf718ca20012b3f","runbook":{"source":"project","path":"child.runbook.md"},"seq":1}
{"type":"step_entered","position":{"current":"1","total":1},"stepName":"1","description":"Work","prompt":"Do it.","hasCommand":false,"isSubstep":false,"prompted":false,"artifacts":{},"runbookId":"rd_7af1d92df90a405edbf718ca20012b3f","runbook":{"source":"project","path":"child.runbook.md"},"seq":2}
```

Refusals are error envelopes with `command: "claim"`: `INVALID_SYNTAX` (not a
Claim Ticket, whose value is never echoed; an empty `--agent-id`; or
`--agent-id` given more than once), `AGENT_ID_REQUIRED` (inside Claude Code,
`CLAUDECODE=1`, with no `--agent-id`), `UNKNOWN_TICKET`, `ALREADY_CLAIMED`,
`DELEGATION_CANCELLED`, `PARENT_RUN_FINISHED`, and the child runbook's own
preparation codes. Nothing is created on any of them.

## collect

### `rundown collect --token <owner_token>`

One `children_collected` event for the run the token targets, then — when a
result moved the run — its `step_transitioned` and continuation, as for
[pass](#pass):

```jsonl
{"type":"children_collected","children":[{"step":"1.1","runId":"rd_1b63d698a4ca35c6fa2e8c5ad4a4f779","result":"pass","status":"collected"},{"step":"1.2","runId":"rd_05cf2674816f973e6434760c30cb55bb","status":"pending"}],"runbookId":"rd_844d1d8e050f8f8fff2deb5a1063f57b","runbook":{"source":"project","path":"parent.runbook.md"},"seq":1}
{"type":"step_transitioned","action":"DEFER","from":"1.1","at":"1.2","result":"PASS","runbookId":"rd_844d1d8e050f8f8fff2deb5a1063f57b","runbook":{"source":"project","path":"parent.runbook.md"},"seq":2}
```

| `children[].status` | Meaning                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collected`         | Terminal; this collect applied its Child Result (`result`)                                                                                                       |
| `already_collected` | An earlier collect applied it                                                                                                                                    |
| `pending`           | Claimed and still running; nothing applied                                                                                                                       |
| `unclaimed`         | Reserved, but not yet claimed; nothing applied                                                                                                                   |
| `cancelled`         | The run no longer counts it (its substep was decided by hand, the run left the step, or an earlier result in the same collect finished the run); nothing applied |

Pending and unclaimed children exit 0. Refusals are error envelopes with
`command: "collect"`: `TOKEN_REQUIRED`, `INVALID_SYNTAX`, `UNKNOWN_TOKEN`,
`RD-303` / `RD-304`, `EXECUTION_IN_PROGRESS` / `EXECUTION_INTERRUPTED`,
`CONCURRENT_MODIFICATION` (results applied before it stand), and
`NOTHING_TO_COLLECT`. The text form prints `Child <step> <runId>: <status>` per
child.

## retry

### `rundown retry --token <owner_token> --step <substep> [--index <n>]`

One `delegation_retried` event for the run the token targets:

```jsonl
{"type":"delegation_retried","step":"1.1","cancelledRunId":"rd_7af1d92df90a405edbf718ca20012b3f","children":[{"step":"1.1","runId":"rd_3c0e5a4b2f6d48d1a9e07c51b2f8d6e4","runbook":"child.runbook.md","ticket":"rdt_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"}],"runbookId":"rd_46cbdd5f19324d3b91667e2ff0e96386","runbook":{"source":"project","path":"parent.runbook.md"},"seq":1}
```

| Field               | Meaning                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| `step`              | The delegated substep retried (`step.substep`)                                 |
| `index`             | The FOR iteration, inside a loop                                               |
| `cancelledRunId`    | The child the retry cancelled; its commands and ticket are refused from now on |
| `children`          | The fresh child, in the shape of `step_entered`'s `children`                   |
| `children[].ticket` | Its new Claim Ticket, printed here once and nowhere else                       |

Refusals are error envelopes with `command: "retry"`: `TOKEN_REQUIRED`,
`INVALID_SYNTAX`, `UNKNOWN_TOKEN`, `RD-303` / `RD-304`, `EXECUTION_IN_PROGRESS`
/ `EXECUTION_INTERRUPTED`, `INVALID_STEP`, `NOTHING_TO_RETRY` and
`CONCURRENT_MODIFICATION`. The text form prints
`Retried <step>: cancelled <runId>`, then the fresh child as `step_entered`'s
text form does.

## release

### `rundown release <child-id> [--agent-id <id>]`

The released child's `runbook_abandoned` event. `parent` names the parent unit
the child ran for and its `standing` — whether anything will Collect the
abandoned child: `current` (the parent's next `collect` applies it as a fail),
`cancelled` (the parent no longer counts it), `parent_finished`, or
`parent_pruned` (no `runId`). `abandonedInline` lists the running Inline
Children the child composed, abandoned with it in the same write:

```jsonl
{"type":"runbook_abandoned","parent":{"standing":"current","runId":"rd_46cbdd5f19324d3b91667e2ff0e96386","step":"1.1"},"abandonedInline":[],"runbookId":"rd_7af1d92df90a405edbf718ca20012b3f","runbook":{"source":"project","path":"child.runbook.md"},"seq":1}
```

Refusals are error envelopes with `command: "release"`: `INVALID_RUN_ID`,
`INVALID_SYNTAX` (an empty `--agent-id`, or `--agent-id` given more than once),
`RUN_TARGET_UNAVAILABLE`, `NOT_A_DELEGATION`, `AGENT_MISMATCH`, `RD-303` /
`RD-304`, `EXECUTION_IN_PROGRESS` and `CONCURRENT_MODIFICATION`. Nothing is
written on any of them. The text form prints one line per standing —
`Run <runId> abandoned; run <parent> collects it at <step> as a fail`,
`…; run <parent> no longer counts it at <step>, so nothing collects it`,
`…; run <parent> has finished, so nothing collects it at <step>`, or
`…; its parent run was pruned, so nothing collects it at <step>` — then
`Inline child <runId> abandoned with it` for each abandoned Inline Child.

## `rundown artifact`

`rundown artifact ls`, `inspect`, `path`, and `uri` expose core artifact
projections for one run. They are read-only: `--run <rd_…>` selects the run, and
without it they use the single running run (several running runs are refused
`INVALID_SYNTAX`; none is the `NO_ACTIVE_RUNBOOK` warning). JSON output is
schema-backed and full-record by default for agents. These commands do not read
or write artifact file contents; they only list, inspect, or project artifact
aliases and URIs. `rundown artifact path --text` and
`rundown artifact uri --text` are the only concise projection outputs.

Non-list artifact responses (`path`, `uri`, `inspect`) carry a `kind`
discriminant: scalar entries reuse the record's own `kind` (`artifact-record` /
`file-artifact-record`), while an alias bound to multiple records is tagged
`artifact-array`. `ls` returns a raw array whose elements carry the same
discriminants. Authoritative shapes live in
`packages/core/src/output/zod-schemas.ts`.

---

## pass

`pass` requires `--token <owner_token>` and `--step <position>`, where the
position names the run's current step exactly (add `--index` inside a FOR
frame). A missing or wrong `--step` is refused `INVALID_STEP` and nothing is
written; see [Error Output](#invalid-step).

### `rundown pass --token <owner_token> --step <position>`

The `action` field shows the transition (e.g., "CONTINUE" to next step, "GOTO 3"
for jump).

**Text:**

```text

─── 3 ────────────────────────────────────────────
Action:   CONTINUE
From:     2
Result:   PASS
At:       3

## 3. Target Step

Step description.
```

**JSON:**

A transition that enters another step streams that step's `step_entered` event
first; the action object is the last line.

```jsonl
{"type":"step_entered","position":{"current":"2","total":3},"stepName":"2","description":"Second Step","prompt":"Next step description.","hasCommand":false,"isSubstep":false,"prompted":false,"artifacts":{},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":1}
{"action":"CONTINUE","stepResult":"PASS","from":"1","at":"2","kind":"action"}
```

`from` and `at` are plain qualified step-ID strings (the step before the
transition, and the step after). There is no `to` field.

A `pass` that ends the run streams nothing and prints the command-name action:

```json
{
  "action": "complete",
  "stepResult": "PASS",
  "from": "2",
  "at": "2",
  "kind": "action",
  "complete": true,
  "position": {
    "current": "2",
    "total": 2,
    "at": "2"
  }
}
```

Transition responses (`pass`, `fail`, `goto`) carry no metadata block: no
`file`, `state`, or `runId` in JSON, and no `File:`/`State:`/`Run:` header in
text — on terminal and non-terminal transitions alike. `rundown run` and the
lifecycle commands (`stop`, `complete`) do emit that metadata, including
`runId`. Correlate a transition with its run through the `runbookId` of its
streamed events or of the `runbook_started` event emitted by `rundown run`.

---

## fail

`fail` takes the same `--token` and `--step` as `pass`.

The `action` field shows the transition (e.g., "RETRY (1/3)" for retry, "stop"
when the failure ends the run).

### `rundown fail --token <owner_token> --step <position>` (retry)

**Text:**

```text

─── 1 ────────────────────────────────────────────
Action:   RETRY (2/3)
From:     1
Result:   FAIL
At:       1

## 1. First Step

Step description.
```

**JSON:**

```jsonl
{"type":"step_entered","position":{"current":"1","total":2},"stepName":"1","description":"First Step","prompt":"Step description.","hasCommand":false,"isSubstep":false,"prompted":false,"artifacts":{},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/retry.runbook.md"},"seq":1}
{"action":"RETRY (1/3)","stepResult":"FAIL","from":"1","at":"1","kind":"action"}
```

### `rundown fail --token <owner_token> --step <position>` (stop)

A `fail` that stops the run streams nothing and exits non-zero.

**Text:**

```text

─── 1 ────────────────────────────────────────────
Action:   STOP
From:     1
Result:   FAIL
At:       1
Runbook:  STOP
```

**JSON:**

```json
{
  "action": "stop",
  "stepResult": "FAIL",
  "from": "1",
  "at": "1",
  "kind": "action",
  "stopped": true,
  "position": {
    "current": "1",
    "total": 3,
    "at": "1"
  }
}
```

---

## goto

`goto` requires `--token <owner_token>` and takes no `--step`.

### `rundown goto <step> --token <owner_token>`

The `action` field is combined (e.g., "GOTO 3"), not a separate `target` field.

**Text:**

```text

─── 3 ────────────────────────────────────────────
Action:   GOTO 3
From:     1
At:       3

## 3. Target Step

Step description.
```

**JSON:**

```jsonl
{"type":"step_entered","position":{"current":"1","total":3},"stepName":"1","description":"First Step","prompt":"Step description here.","hasCommand":false,"isSubstep":false,"prompted":false,"artifacts":{},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":1}
{"action":"GOTO 1","from":"3","at":"1","kind":"action"}
```

A target that does not exist is refused:

```json
{
  "error": "Step \"9\" does not exist",
  "kind": "error",
  "code": "STEP_NOT_FOUND",
  "command": "goto",
  "details": {
    "requested": "9",
    "available": ["1", "2", "3"]
  }
}
```

---

## stop

`stop` requires `--token <owner_token>`, except for the human escape hatch,
[`stop --run`](#escape-hatch-refusals).

### `rundown stop [message] --token <owner_token>`

Uses `action: "stop"` (command-name action). Stopping is a failure terminal: it
exits non-zero after successfully stopping the run.

While an inline child runs, the token targets the deepest running child, so
`stop` and `complete` act on it: the child's `runbook_stopped` /
`runbook_completed` streams under the child's `runbookId`, the parent's
progression events follow (see [Inline children](#inline-children)), and the
action object is still the last line, with `runId` naming the child and
`message` the operator's message. The exit code follows where the parent's
progression rests, not the child's terminal: a stopped child the parent Collects
as FAIL and continues past exits 0; one whose parent stops exits non-zero.

Force-terminal commands emit the same terminal observation events as non-force
transitions: `runbook_completed` for complete and `runbook_stopped` for stop.
The streamed observations precede the final command-name action object, so parse
newline-delimited JSON (the action object is the last line).

**Text:**

```text
File:     runbooks/deploy.runbook.md
State:    .rundown/rundown.db
Run:      rd_0123456789abcdef0123456789abcdef

─── 1 ────────────────────────────────────────────
Action:   STOP
From:     1
Result:   FAIL
At:       1
Runbook:  STOP
Runbook:  STOP
```

**JSON:**

```jsonl
{"type":"step_transitioned","action":"STOP","from":"1","at":"1","result":"FAIL","timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":1}
{"type":"runbook_stopped","message":"User requested stop","position":{"current":"1","total":3},"reason":"fail_transition","timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":2}
{"file":"runbooks/deploy.runbook.md","state":".rundown/rundown.db","runId":"rd_0123456789abcdef0123456789abcdef","action":"stop","stopped":true,"kind":"action","message":"User requested stop"}
```

<a id="escape-hatch-refusals"></a>

### `rundown stop [message] --run <run-id>` (human escape hatch)

The one mutation a run id drives: a person at an interactive terminal stops a
top-level run whose Owner Token was lost, with every running inline child it
composes. On an explicit yes to the prompt (written to stderr, so stdout stays
JSON), the output is that of `stop --token` above: the named run's observation
events, then each stopped inline child's (each attributed to its own
`runbookId`), then the action object naming the named run, which adds
`stoppedInline` — the stopped inline children's run ids, nearest first — when
there are any. The text output adds one `Inline:   <run-id> STOP` line per
child. The named run records `humanStop` (see
[Human stop audit](#human-stop-audit)); the children are stopped by the same
all-or-nothing write. Every refusal writes nothing and exits 1:

| Code                      | When                                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INTERACTIVE_REQUIRED`    | No human at an interactive terminal (stdin and stderr are not both a TTY), or `--non-interactive`; nobody is asked                                                                                                |
| `INVALID_RUN_ID`          | The id is malformed; nobody is asked                                                                                                                                                                              |
| `RUN_TARGET_UNAVAILABLE`  | No run carries the id; nobody is asked                                                                                                                                                                            |
| `RD-303` / `RD-304`       | The run already finished; nobody is asked                                                                                                                                                                         |
| `NOT_A_TOP_LEVEL_RUN`     | The id names a child run; the message names only the recoveries that reach it (an inline child's root, or a delegation's own `stop --token` / `release`, and `retry` while its parent counts it); nobody is asked |
| `EXECUTION_IN_PROGRESS`   | An attempt is In Progress on the run or a running inline child it composes; nobody is asked                                                                                                                       |
| `NOT_CONFIRMED`           | The human answered anything but `y` / `yes`, including end of input (Ctrl-D) or Ctrl-C                                                                                                                            |
| `CONCURRENT_MODIFICATION` | The run or one of its running inline children changed while the human decided; nothing is stopped, never retried                                                                                                  |
| `INVALID_SYNTAX`          | `--run` was combined with `--token`                                                                                                                                                                               |

```json
{
  "error": "rundown stop --run is the human escape hatch for a lost owner token: it asks for confirmation at an interactive terminal and records who stopped the run. There is no terminal here, so nothing was stopped. An agent must not use it: stop the run with --token <owner_token>, or ask the user to run `rundown stop --run <id>` themselves.",
  "kind": "error",
  "code": "INTERACTIVE_REQUIRED",
  "command": "stop",
  "details": { "runId": "rd_0123456789abcdef0123456789abcdef" }
}
```

---

## complete

`complete` requires `--token <owner_token>`.

### `rundown complete [message] --token <owner_token>`

**Text:**

```text
File:     runbooks/deploy.runbook.md
State:    .rundown/rundown.db
Run:      rd_0123456789abcdef0123456789abcdef

─── 1 ────────────────────────────────────────────
Action:   COMPLETE
From:     1
Result:   PASS
At:       1
Runbook:  COMPLETE
Runbook:  COMPLETE
```

**JSON:**

The streamed `step_transitioned` and `runbook_completed` observation events
precede the final `complete` action object, which is the last line.

```jsonl
{"type":"step_transitioned","action":"COMPLETE","from":"3","at":"3","result":"PASS","timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":1}
{"type":"runbook_completed","message":"Deployment finished","finalPosition":{"current":"3","total":3},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":2}
{"file":"runbooks/deploy.runbook.md","state":".rundown/rundown.db","runId":"rd_0123456789abcdef0123456789abcdef","action":"complete","complete":true,"kind":"action","message":"Deployment finished"}
```

---

## prune

Prune uses the same `Runbook` format as `ls`. Ids are run ids (`rd_` + 32 hex)
in both modes — prune reads them from the store as `RunId`s, and unlike `ls`,
its text `ID` column is not truncated. Dry-run and actual prune print the same
rows: the runs selected for removal.

The lifecycle filters (`--completed`, `--stopped`, `--inactive`, `--active`,
`--all`) select finished and invalid runs. A **running** run is deleted when
`--token <owner_token>` names it, one run per invocation, or — a top-level run
selected by `--active` / `--all` — when a human at an interactive terminal
confirms it. Without one (and always under `--dry-run`) it is kept and reported
with `retained: "token required"`; one the human declines with
`retained: "not confirmed"`. A running child run is never offered for
confirmation: it is kept with `retained: "child run"` and a `detail` naming the
recoveries that reach it.

Each row a human-confirmed delete removes carries the audit the deleted row can
no longer hold — `confirmedBy: { at, user, host }` (ISO-8601 time of the
confirmation, login name, host name) — and the text `NOTE` column shows
`confirmed by <user>@<host> at <time>`.

A current child its running parent still counts is never deleted on its own:
`"uncollected"` for a finished one whose result the parent has not collected,
`"current child"` for a running one
([Child Result retention](../reference/cli.md#prune-retention)). When the same
prune deletes the parent, a finished child the filters select is deleted after
it, and a running one is kept as `"child run"`. A delegation whose running
parent's runbook cannot be parsed is kept as `"parent unreadable"`, with a
`detail` saying why. A deleted run's inline children are deleted with it and
listed as rows of their own. The last reason, `"execution in progress"`, is a
run with an attempt In Progress anywhere in its inline chain. `retained` is one
of exactly these seven strings; `detail` appears only with `"child run"` and
`"parent unreadable"`.

`rundown prune --token` naming a protected current child is refused, with
nothing deleted:

```json
{
  "error": "Run rd_fedcba9876543210fedcba9876543210 is the current child of run rd_0123456789abcdef0123456789abcdef at 1.1 and holds a result it has not collected, so nothing was deleted. It becomes prunable once the parent collects it, cancels it with `rundown retry`, finishes, or is pruned.",
  "kind": "error",
  "code": "CURRENT_CHILD_PROTECTED",
  "command": "prune",
  "details": {
    "runId": "rd_fedcba9876543210fedcba9876543210",
    "parentRunId": "rd_0123456789abcdef0123456789abcdef",
    "parentStep": "1.1"
  }
}
```

### `rundown prune --dry-run`

**Text:**

```text
ID                                   STATUS    RUNBOOK                     TITLE                   RETAINED  NOTE
rd_0123456789abcdef0123456789abcdef  stopped   runbooks/deploy.runbook.md  [Deploy to Production]
rd_fedcba9876543210fedcba9876543210  complete  runbooks/retry.runbook.md   [Retry]
```

**JSON:**

```json
[
  {
    "id": "rd_0123456789abcdef0123456789abcdef",
    "runbook": "runbooks/deploy.runbook.md",
    "status": "stopped",
    "title": "Deploy to Production"
  },
  {
    "id": "rd_fedcba9876543210fedcba9876543210",
    "runbook": "runbooks/retry.runbook.md",
    "status": "complete",
    "title": "Retry"
  }
]
```

### `rundown prune --active --dry-run`

**Text:**

```text
ID                                   STATUS   RUNBOOK                     TITLE                   RETAINED        NOTE
rd_0123456789abcdef0123456789abcdef  running  runbooks/deploy.runbook.md  [Deploy to Production]  token required
```

**JSON:**

```json
[
  {
    "id": "rd_0123456789abcdef0123456789abcdef",
    "runbook": "runbooks/deploy.runbook.md",
    "status": "running",
    "title": "Deploy to Production",
    "retained": "token required"
  }
]
```

### `rundown prune --all` at an interactive terminal

The human confirmed deleting the running top-level run; its running delegation
is kept.

**Text:**

```text
ID                                   STATUS   RUNBOOK                     TITLE                   RETAINED   NOTE
rd_0123456789abcdef0123456789abcdef  running  runbooks/deploy.runbook.md  [Deploy to Production]             confirmed by ada@desk at 2026-05-07T00:00:00.000Z
rd_fedcba9876543210fedcba9876543210  running  runbooks/verify.runbook.md  [Verify]                child run  Run rd_fedcba9876543210fedcba9876543210 is a running child run, …
```

**JSON:**

```json
[
  {
    "id": "rd_0123456789abcdef0123456789abcdef",
    "runbook": "runbooks/deploy.runbook.md",
    "status": "running",
    "title": "Deploy to Production",
    "confirmedBy": {
      "at": "2026-05-07T00:00:00.000Z",
      "user": "ada",
      "host": "desk"
    }
  },
  {
    "id": "rd_fedcba9876543210fedcba9876543210",
    "runbook": "runbooks/verify.runbook.md",
    "status": "running",
    "title": "Verify",
    "retained": "child run",
    "detail": "Run rd_fedcba9876543210fedcba9876543210 is a running child run, which prune deletes only with its own token or its root; its owner stops it with `rundown stop --token <owner_token>`, or its claiming agent ends it with `rundown release rd_fedcba9876543210fedcba9876543210` (with the `--agent-id` it claimed with, if any)."
  }
]
```

### `rundown prune --inactive`

A run whose persisted state this build cannot read is listed with
`status: "invalid"` and runbook `(invalid)`:

```json
[
  {
    "id": "rd_0123456789abcdef0123456789abcdef",
    "runbook": "(invalid)",
    "status": "invalid"
  }
]
```

---

## check

Check uses `valid`/`errors`/`stats` fields (validation, not workflow). No
`result` field - the `valid` field indicates success.

### `rundown check <file>` (valid)

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

The `warnings` array is optional. When present, each entry has a `message` and
an optional `line` and `kind`.

### `rundown check <file>` (invalid)

Exit code 1.

**Text:**

```text
FAIL: 1 error
  Line 3: Step 1: GOTO target step "4" does not exist.
```

**JSON:**

```json
{
  "kind": "check",
  "valid": false,
  "errors": [
    {
      "line": 3,
      "message": "Step 1: GOTO target step \"4\" does not exist."
    }
  ],
  "warnings": []
}
```

`stats` is present only when the runbook is structurally valid.

---

## scenario ls

### `rundown scenario ls <file>`

**Text:**

```text
NAME     EXPECTED  DESCRIPTION      TAGS
success  COMPLETE  Happy path test  smoke
```

**JSON:**

`tags` is a comma-separated string here, not an array.

```json
[
  {
    "name": "success",
    "expected": "COMPLETE",
    "description": "Happy path test",
    "tags": "smoke"
  }
]
```

---

## scenario show

### `rundown scenario show <file> <name>`

Scenario commands name the run's Owner Token with the `${TOKEN}` placeholder,
which the scenario runner fills from the `runbook_started` event.

**Text:**

```text
Name:        success
Description: Happy path test
Expected:    COMPLETE
Tags:        smoke
Commands:
  $ rundown run --prompted test.runbook.md
  $ rundown pass --token ${TOKEN} --step 1
```

**JSON:**

```json
{
  "name": "success",
  "description": "Happy path test",
  "expected": "COMPLETE",
  "commands": [
    "rundown run --prompted test.runbook.md",
    "rundown pass --token ${TOKEN} --step 1"
  ],
  "tags": ["smoke"]
}
```

### `rundown scenario show <file> <name>` (not found)

**Text:**

```text
Error: Scenario "unknown" not found
Code: SCENARIO_NOT_FOUND
```

**JSON:**

```json
{
  "error": "Scenario \"unknown\" not found",
  "kind": "error",
  "code": "SCENARIO_NOT_FOUND",
  "command": "scenario show",
  "details": {
    "available": ["success"]
  }
}
```

---

## scenario run

### `rundown scenario run <file> <name>`

Uses `result` (a boolean) to indicate scenario outcome. This is scenario
verification, not workflow — the boolean is the verification verdict, not a step
result.

Scenario `expect.entered` entries, represented internally as
`enteredAssertions`, match captured `step_entered` events. Supported fields are
`at`, `description`, and `runbook`; `runbook` matches the suffix of the event's
canonical `runbook.path`. Use these assertions for entry-only behavior that does
not necessarily emit a transition.

**Text:**

The text transcript echoes each command with `${TOKEN}` substituted, followed by
that command's own (JSON) output:

```text

Scenario:  success
──────────────────────────────────────────────────


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
$ rundown run --prompted test.runbook.md

{"type":"runbook_started","title":"Test","prompted":true,"owner_token":"rdo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":".rundown/runbooks/test.runbook.md"},"seq":1}
{"type":"step_entered","position":{"current":"1","total":1},"stepName":"1","description":"Step","prompt":"Do it.","hasCommand":false,"isSubstep":false,"prompted":true,"artifacts":{},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":".rundown/runbooks/test.runbook.md"},"seq":2}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
$ rundown pass --token rdo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA --step 1

{
  "action": "complete",
  "stepResult": "PASS",
  "from": "1",
  "at": "1",
  "kind": "action",
  "complete": true,
  "position": {
    "current": "1",
    "total": 1,
    "at": "1"
  }
}

Scenario: COMPLETE
```

**JSON:**

```json
{
  "result": true,
  "scenario": "success",
  "expected": "COMPLETE",
  "actual": "COMPLETE",
  "kind": "scenario_run"
}
```

---

## echo

`rundown echo` runs inside a step's command, where the executing run injects
`RD_RUN_ID`; the run's retry count indexes the `--result` sequence. Outside a
step command it fails with
`Error: No run context. rundown echo runs inside a step command, where RD_RUN_ID is set.`

### `rundown echo [command...]`

**Text:**

```text
npm install
```

**JSON:**

```json
{
  "result": true,
  "output": "npm install",
  "exitCode": 0,
  "kind": "echo"
}
```

### `rundown echo --result fail`

Exit code 1. Text prints the echoed command, if any, and nothing else.

**JSON:**

```json
{
  "result": false,
  "exitCode": 1,
  "kind": "echo"
}
```

---

## prompt

### `rundown prompt <content>`

**Text:**

````text
```
Hello world
```
````

**JSON:**

```json
{
  "output": "Hello world",
  "kind": "prompt"
}
```

---

## Error Output (all commands)

Error responses carry `kind: "error"` along with `error` and `code` fields. When
the triggering command is known, a `command` field names it. A non-zero exit
code indicates failure. Text renders the pair `Error: <message>` /
`Code: <code>`.

Mutating commands check their arguments in a fixed order, and the first refusal
wins: `--run` alongside `--token` (`INVALID_SYNTAX`), then a missing `--token`
(`TOKEN_REQUIRED`), then a malformed token (`INVALID_SYNTAX`), then a token no
run carries (`UNKNOWN_TOKEN`), then a finished run (`RD-303` / `RD-304`), then
the execution lease (`EXECUTION_IN_PROGRESS` / `EXECUTION_INTERRUPTED`), then —
for `pass` and `fail` — the step (`INVALID_STEP`), then — for `pass` — a step
whose command has not run (`EXECUTION_PENDING`), and last the conditional save
(`CONCURRENT_MODIFICATION`). Nothing is written on any of these refusals.

### Token required

A mutating command (`pass`, `fail`, `goto`, `stop`, `complete`) issued without
`--token`. The remedy names where the token comes from.

**Text:**

```text
Error: rundown pass requires --token <owner_token>; copy owner_token from the runbook_started event printed by rundown run.
Code: TOKEN_REQUIRED
```

**JSON:**

```json
{
  "error": "rundown pass requires --token <owner_token>; copy owner_token from the runbook_started event printed by rundown run.",
  "kind": "error",
  "code": "TOKEN_REQUIRED",
  "command": "pass"
}
```

### Invalid token or `--run` on a mutating command

Both are `INVALID_SYNTAX`. A malformed token is never echoed — it may be a
near-miss of a real secret:

```json
{
  "error": "Invalid --token: expected an owner token of the form rdo_<43 base64url characters>.",
  "kind": "error",
  "code": "INVALID_SYNTAX",
  "command": "pass"
}
```

`--run` is a read-only selector and never mutation authority, so combining it
with `--token` is refused rather than letting a run id stand in for proof of
ownership:

```json
{
  "error": "--run is a read-only selector and cannot authorize rundown pass; pass --token <owner_token> alone.",
  "kind": "error",
  "code": "INVALID_SYNTAX",
  "command": "pass"
}
```

### Unknown token

A well-formed token that no run carries — a mistyped token, or the token of a
run that has been pruned.

**Text:**

```text
Error: No run matches this token. Copy owner_token from the runbook_started event of the run you mean to drive.
Code: UNKNOWN_TOKEN
```

**JSON:**

```json
{
  "error": "No run matches this token. Copy owner_token from the runbook_started event of the run you mean to drive.",
  "kind": "error",
  "code": "UNKNOWN_TOKEN",
  "command": "pass"
}
```

### Run finished (`RD-303`, `RD-304`)

The token names a run that has already finished, so the mutation cannot be
applied. `RD-303` means the run completed; `RD-304` means it ended without
completing (`stopped` or `abandoned`). `details` names the run and its
lifecycle.

**Text:**

```text
Error: Run rd_0123456789abcdef0123456789abcdef has finished (completed); rundown complete cannot be applied. Start a new run with rundown run.
Code: RD-303
```

**JSON:**

```json
{
  "error": "Run rd_0123456789abcdef0123456789abcdef has finished (completed); rundown complete cannot be applied. Start a new run with rundown run.",
  "kind": "error",
  "code": "RD-303",
  "command": "complete",
  "details": {
    "runId": "rd_0123456789abcdef0123456789abcdef",
    "lifecycle": "completed"
  }
}
```

```json
{
  "error": "Run rd_0123456789abcdef0123456789abcdef has finished (stopped); rundown fail cannot be applied. Start a new run with rundown run.",
  "kind": "error",
  "code": "RD-304",
  "command": "fail",
  "details": {
    "runId": "rd_0123456789abcdef0123456789abcdef",
    "lifecycle": "stopped"
  }
}
```

### Invalid step

`pass` and `fail` require `--step` naming the run's current position. A bare
command, or a `--step` that names any other position, is refused and the message
names the current position. While an inline child runs, the position is the
deepest running child's: a `--step` naming the parent's step is refused, and the
message names the child
(`… The Owner Token is driving inline child rd_… (child.runbook.md) of run rd_… at 1.1; while it runs, --step names a step of the child`).

**Text:**

```text
Error: --step 2 targets step "2" but the active step is "1"
Code: INVALID_STEP
```

**JSON:**

```json
{
  "error": "--step 2 targets step \"2\" but the active step is \"1\"",
  "kind": "error",
  "code": "INVALID_STEP",
  "command": "pass"
}
```

```json
{
  "error": "--step is required; the current position is 1",
  "kind": "error",
  "code": "INVALID_STEP",
  "command": "pass"
}
```

### Runbook composition unsupported

`rundown run` refuses a runbook with a substep listing more than one runbook:
each substep composes one child. No run is created. `details.substeps` names
every such substep. A single-runbook inline or `DELEGATE` substep runs (see
[Inline children](#inline-children) and [Delegations](#delegations)).

**Text:**

```text
Error: Runbook composes other runbooks at 1.1 in a form this build does not run (a substep listing more than one runbook: each substep composes one child).
Code: RUNBOOK_COMPOSITION_UNSUPPORTED
```

**JSON:**

```json
{
  "error": "Runbook composes other runbooks at 1.1 in a form this build does not run (a substep listing more than one runbook: each substep composes one child).",
  "kind": "error",
  "code": "RUNBOOK_COMPOSITION_UNSUPPORTED",
  "command": "run",
  "details": {
    "runbook": "runbooks/parent.runbook.md",
    "substeps": ["1.1"]
  }
}
```

### Artifact input required

A name the runbook requires to be an artifact — asserted by a naked `ARTIFACTS`
declaration (language spec §10.1.2), or rendered with `{{ path Name }}` — is
bound to a value that is not one: a plain path, a number, an empty or malformed
URI array. The artifact channel, `--artifacts <name>=<rd:// URI>`, is the only
way to supply an artifact at launch; `--input` never carries one.

- **At launch.** When the value comes from the launch inputs and no step can
  rebind the name before the assertion or render reads it, `rundown run` refuses
  it with this error envelope and exit 1 before any run is created. A name in
  the produced set (§8.2) can be rebound, and so can every name in a runbook
  that composes a child (an inline runbook-list entry or a `DELEGATE`), whose
  frontmatter `outputs:` are forwarded into the parent (§10.3); those are left
  to step entry. `details.variable` names the input; `details.step` names the
  first asserting step or substep (absent for a `{{ path … }}` render).
  `rundown resolve` lists the message under `errors`.
- **At child preparation.** An inline child's launch or a `rundown claim`
  reports the same code when the value the child inherited from its parent is
  not an artifact. Its message says the value came from the parent and must be
  an artifact there; it does not name `--artifacts`, which the child's command
  cannot take.
- **At step entry.** A value an earlier step binds is refused when the asserting
  step is entered: an `error_occurred` event with `code` set, then
  `runbook_stopped` with reason `artifact_resolution_failed`. The message says
  the run stops and that the step binding the name must bind an artifact before
  a new run. A `{{ path Name }}` render over such a value is an `error_occurred`
  with this code; nothing is committed and the run keeps its position, so the
  message names the owner's recovery: `rundown goto` a step that rebinds the
  name, or `rundown stop`. Run Progression reports it with
  `recovery: "permanent"` — a re-render cannot succeed, and the owner must act.

The message never contains the bound value, which may be a secret supplied
through `--input KEY` or `RD_INPUT_*`. It names the variable and the value's
kind, such as "a plain string that is not an rd:// URI", "a number", or "a JSON
array string with an entry that is not an rd:// URI". For an assertion it begins
with the §10.1.2 failure name: `unresolvable-uri` for a string that is not a
URI, `partial-resolve` for a URI[] or JSON URI[] string with an entry that is
not one, and `not-an-artifact` for anything else, including an artifact-shaped
record that did not come through the artifact channel.

**JSON:**

```json
{
  "error": "unresolvable-uri: ARTIFACTS naked declaration \"SkillPath\" at step 2 requires an artifact, but it is bound to a plain string that is not an rd:// URI. Supply it with --artifacts SkillPath=<rd:// URI> (or --artifacts-json SkillPath='[\"<rd:// URI>\", …]'); `rundown artifact ls --run <producer_run_id>` lists the producing run's artifacts, each with its `uri`.",
  "kind": "error",
  "code": "ARTIFACT_INPUT_REQUIRED",
  "command": "run",
  "details": {
    "runbook": "convert-skill.runbook.md",
    "variable": "SkillPath",
    "step": "2"
  }
}
```

### Delegation refusals

Delegation and its recovery have eight refusals. Each writes nothing, exits 1
and carries `details` only where shown.

| Code                   | Command                                          | When                                                                                                                                                           |
| ---------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNKNOWN_TICKET`       | `claim`                                          | A well-formed Claim Ticket no reservation carries                                                                                                              |
| `ALREADY_CLAIMED`      | `claim`                                          | The ticket's child was already claimed                                                                                                                         |
| `DELEGATION_CANCELLED` | `claim`, and any command on the child but `stop` | The parent no longer counts the child (its substep was decided by hand or retried, or the step re-entered); `details.runId` names the child on a child command |
| `PARENT_RUN_FINISHED`  | `claim`, and any command on the child but `stop` | The parent reached a terminal or was pruned; `details.runId` names the child on a child command                                                                |
| `NOTHING_TO_COLLECT`   | `collect`                                        | The run's current step delegates nothing                                                                                                                       |
| `NOTHING_TO_RETRY`     | `retry`                                          | The substep delegates nothing, or its child was already collected or decided by hand                                                                           |
| `AGENT_ID_REQUIRED`    | `claim`                                          | Inside Claude Code (`CLAUDECODE=1`) with no `--agent-id`: a claim the plugin's Bash hook did not stamp                                                         |
| `AGENT_MISMATCH`       | `release`                                        | The agent id differs from the one the claim recorded (both absent match)                                                                                       |
| `NOT_A_DELEGATION`     | `release`                                        | The run is not a delegated child                                                                                                                               |

```json
{
  "error": "Run rd_7af1d92df90a405edbf718ca20012b3f is a delegation that run rd_46cbdd5f19324d3b91667e2ff0e96386 no longer counts at 1.1 (the substep was decided, retried or entered again); its result would never be collected, so nothing was written. Stop working on it, and end it with `rundown stop --token <owner_token>`.",
  "kind": "error",
  "code": "DELEGATION_CANCELLED",
  "command": "pass",
  "details": { "runId": "rd_7af1d92df90a405edbf718ca20012b3f" }
}
```

### No active runbook

Emitted by `rundown artifact` when no run is running and no `--run` was given.
Exit code 0 — the condition is informational, not a failure.

**Text:**

```text
No active runbook.
```

**JSON:**

```json
{
  "message": "No active runbook",
  "kind": "warning",
  "command": "artifact",
  "code": "NO_ACTIVE_RUNBOOK"
}
```

### File not found

**Text:**

```text
Error: Runbook not found: runbooks/missing.runbook.md. Try 'rundown ls --all' to list available runbooks.
Code: RUNBOOK_NOT_FOUND
```

**JSON:**

```json
{
  "error": "Runbook not found: runbooks/missing.runbook.md. Try 'rundown ls --all' to list available runbooks.",
  "kind": "error",
  "code": "RUNBOOK_NOT_FOUND",
  "command": "run",
  "details": {
    "runbook": "runbooks/missing.runbook.md"
  }
}
```

### Concurrent modification

One run, one writer: a mutating command reads the run, derives its change, and
commits with one conditional write. If another write landed on the run in
between, the commit is refused, never retried, and nothing is written.
`details.runId` names the run. Re-read the run (`rundown status --run`) and
re-issue the command if it still applies.

**Text:**

```text
Error: Run rd_0123456789abcdef0123456789abcdef was modified by another writer since it was read; nothing was written. Re-read the run and re-issue the command.
Code: CONCURRENT_MODIFICATION
```

**JSON:**

```json
{
  "error": "Run rd_0123456789abcdef0123456789abcdef was modified by another writer since it was read; nothing was written. Re-read the run and re-issue the command.",
  "kind": "error",
  "code": "CONCURRENT_MODIFICATION",
  "command": "pass",
  "details": {
    "runId": "rd_0123456789abcdef0123456789abcdef"
  }
}
```

### Execution in progress

The run's current step holds the execution lease and the process that started
its command is still running. Every mutating command (`pass`, `fail`, `goto`,
`stop`, `complete`) is refused, and so is a second Run Progression attempt at
the step, so the command never runs twice. Nothing is written. `details` names
the step and the attempt holding the lease. Wait for the command to finish, then
re-read the run.

**Text:**

```text
Error: Step 1 of run rd_0123456789abcdef0123456789abcdef is In Progress: its command started at 2026-10-13T12:00:00.000Z in process 4242 and is still running. Nothing was written. Wait for it to finish, then re-read the run.
Code: EXECUTION_IN_PROGRESS
```

**JSON:**

```json
{
  "error": "Step 1 of run rd_0123456789abcdef0123456789abcdef is In Progress: its command started at 2026-10-13T12:00:00.000Z in process 4242 and is still running. Nothing was written. Wait for it to finish, then re-read the run.",
  "kind": "error",
  "code": "EXECUTION_IN_PROGRESS",
  "command": "pass",
  "details": {
    "runId": "rd_0123456789abcdef0123456789abcdef",
    "step": "1",
    "attempt": 2,
    "pid": 4242,
    "startedAt": "2026-10-13T12:00:00.000Z"
  }
}
```

### Execution interrupted

The run's current step holds the execution lease, but the process that started
its command is gone (killed, crashed, or its pid reused by another process), so
the command's outcome is unknown. Rundown never repeats the command. `pass` and
`complete` — which would treat it as having succeeded — are refused, and so is
Run Progression. Nothing is written. The owner decides explicitly: `fail --step`
(the step's FAIL handler, including an authored `RETRY`), `goto`, or `stop`
commits and clears the lease. `rundown status` shows the step Interrupted until
then.

**Text:**

```text
Error: Step 1 of run rd_0123456789abcdef0123456789abcdef is Interrupted: the process 4242 that started its command at 2026-10-13T12:00:00.000Z is gone, so the command's outcome is unknown. Rundown never repeats it. Decide explicitly: `rundown fail --step 1 --token <owner_token>` (the step's FAIL handler, including an authored RETRY), `rundown goto <step> --token <owner_token>`, or `rundown stop --token <owner_token>`.
Code: EXECUTION_INTERRUPTED
```

**JSON:**

```json
{
  "error": "Step 1 of run rd_0123456789abcdef0123456789abcdef is Interrupted: the process 4242 that started its command at 2026-10-13T12:00:00.000Z is gone, so the command's outcome is unknown. Rundown never repeats it. Decide explicitly: `rundown fail --step 1 --token <owner_token>` (the step's FAIL handler, including an authored RETRY), `rundown goto <step> --token <owner_token>`, or `rundown stop --token <owner_token>`.",
  "kind": "error",
  "code": "EXECUTION_INTERRUPTED",
  "command": "pass",
  "details": {
    "runId": "rd_0123456789abcdef0123456789abcdef",
    "step": "1",
    "attempt": 2,
    "pid": 4242,
    "startedAt": "2026-10-13T12:00:00.000Z"
  }
}
```

### Execution pending

`pass` named a step whose command Run Progression owes but never ran: the
command that entered the step ended before running it (the process died after
its commit, or the step was reached by Collecting an inline child a crashed
command left uncollected). No lease is held, so nothing is in flight. Rundown
does not pass a command that never ran, and nothing is written. `goto` onto the
step re-enters it and runs the command; `fail --step` (the step's FAIL handler)
or `stop` decides it without running it.

**Text:**

```text
Error: Step 2 of run rd_0123456789abcdef0123456789abcdef has a command that has not run: the command that entered the step ended before running it. Rundown does not pass a command that never ran, and nothing was written. Run it with `rundown goto 2 --token <owner_token>`, or decide explicitly with `rundown fail --step 2 --token <owner_token>` or `rundown stop --token <owner_token>`.
Code: EXECUTION_PENDING
```

**JSON:**

```json
{
  "error": "Step 2 of run rd_0123456789abcdef0123456789abcdef has a command that has not run: the command that entered the step ended before running it. Rundown does not pass a command that never ran, and nothing was written. Run it with `rundown goto 2 --token <owner_token>`, or decide explicitly with `rundown fail --step 2 --token <owner_token>` or `rundown stop --token <owner_token>`.",
  "kind": "error",
  "code": "EXECUTION_PENDING",
  "command": "pass",
  "details": {
    "runId": "rd_0123456789abcdef0123456789abcdef",
    "step": "2"
  }
}
```

### Run target unavailable

The `--run` id supplied to a read-only command (`status`, `artifact`) is well
formed but names no run. The message names only the caller-supplied id.

**Text:**

```text
Error: Run rd_0123456789abcdef0123456789abcdef not found.
Code: RUN_TARGET_UNAVAILABLE
```

**JSON:**

```json
{
  "error": "Run rd_0123456789abcdef0123456789abcdef not found.",
  "kind": "error",
  "code": "RUN_TARGET_UNAVAILABLE",
  "command": "status",
  "details": {
    "runId": "rd_0123456789abcdef0123456789abcdef"
  }
}
```

### Invalid run id

The `--run` value is malformed. A run id is `rd_` followed by 32 hexadecimal
characters.

**Text:**

```text
Error: Invalid run id. Expected rd_<32 hex characters>.
Code: INVALID_RUN_ID
```

**JSON:**

```json
{
  "error": "Invalid run id. Expected rd_<32 hex characters>.",
  "kind": "error",
  "code": "INVALID_RUN_ID",
  "command": "status"
}
```

### Runbook database and persisted state (`RD-306`…`RD-309`)

Four `STATE`-category errors describe the state store itself rather than any one
command's arguments. They are **thrown**, not returned as command outcomes, so
they reach output through the top-level error wrapper rather than through
`OutputEmitter`. That gives them two shapes distinct from every envelope above:

- **Text** is `Error <code>: <message>` on one line, written to stderr — not the
  `Error: …` / `Code: …` pair the symbolic codes render.
- **JSON** carries an extra `details` object holding `category`, `title`, and
  the error's structured `context`, and carries **no** `command` field.

The registered `description` never reaches the CLI output, so each of these
codes deliberately spells its diagnosis and its recovery into `error` itself.

**No documentation URL is emitted, by any code.** Errors carry no `docsUrl`
field. The per-code `docSlug` still exists in the registry as the durable
identifier a future `/docs/errors/` route would key on, but no such route has
ever been served, so nothing renders it.

Every one of these four contexts also carries a `message` key holding the same
diagnosis already rendered into `error`. It is **elided from the fences below**
for readability; expect it on the wire.

Two are open-time faults on the database as a whole, two concern one run.

| Code     | Symbolic name                   | Scope    | Nature                    |
| -------- | ------------------------------- | -------- | ------------------------- |
| `RD-306` | `WAL_JOURNAL_MODE_UNAVAILABLE`  | Database | Refusal — establish WAL   |
| `RD-307` | `STATE_STORE_UNAVAILABLE`       | Database | Retry lock; else repair   |
| `RD-308` | `CONCURRENT_STATE_MODIFICATION` | One run  | **Transient — re-run it** |
| `RD-309` | `INVALID_PERSISTED_RUN_STATE`   | One run  | Refusal — prune the run   |

`RD-305` (`INCOMPATIBLE_STATE_SCHEMA`) is the fifth member of this family and
governs the database's own schema version; it is not repeated here.

#### `RD-306` — database is not in WAL journal mode

WAL is Rundown's required and validated journal mode. SQLite also serializes
cross-process writers in rollback-journal modes through file locking, but those
modes do not provide WAL's reader/writer concurrency. SQLite either returned a
non-WAL effective mode or no readable mode. The candidate causes are enumerated
in the message because a temporary database and an in-transaction connection
reach the same refusal — naming a network filesystem as _the_ cause would send
an operator on local disk looking in the wrong place. A read-only file or
directory is explicitly **not** among them: that fails the pragma outright and
surfaces as `RD-307`.

**Text:**

```text
Error RD-306: Runbook database is not in WAL journal mode - effective mode: delete. WAL mode is required for supported multi-process operation. SQLite still serializes cross-process writers using file locks in rollback-journal mode, but rollback-journal mode does not provide WAL's reader/writer concurrency and is not a validated Rundown deployment mode. SQLite returned the non-WAL mode it kept instead of failing. This narrows the cause to one of: a filesystem whose VFS provides no shared memory (a network mount such as NFS or SMB is the common one), a temporary database opened with no filename, or a connection already inside a write transaction. A read-only database file or directory is NOT among them — that fails the pragma outright and surfaces as RD-307
```

**JSON:**

```json
{
  "kind": "error",
  "error": "Runbook database is not in WAL journal mode - effective mode: delete. WAL mode is required for supported multi-process operation. SQLite still serializes cross-process writers using file locks in rollback-journal mode, but rollback-journal mode does not provide WAL's reader/writer concurrency and is not a validated Rundown deployment mode. SQLite returned the non-WAL mode it kept instead of failing. This narrows the cause to one of: a filesystem whose VFS provides no shared memory (a network mount such as NFS or SMB is the common one), a temporary database opened with no filename, or a connection already inside a write transaction. A read-only database file or directory is NOT among them — that fails the pragma outright and surfaces as RD-307",
  "code": "RD-306",
  "details": {
    "category": "STATE",
    "title": "Runbook database is not in WAL journal mode",
    "context": { "effectiveMode": "delete" }
  }
}
```

#### `RD-307` — database unavailable

`.rundown/rundown.db` could not be opened, so commands that access persisted run
state cannot continue. This includes read-only state commands, but not commands
that never open the store, such as `rundown check`. The driver's own message
rides in `error` because it is the only thing that distinguishes a read-only
file from a file that is not a database from lock contention that outlasted the
driver's bounded timeout and retries from a host with no working SQLite adapter.
Rundown never downgrades to the single-writer sql.js adapter outside
WebContainer. Retry after transient lock contention; repair the host or file for
persistent failures.

**Text:**

```text
Error RD-307: Runbook database unavailable - Native SQLite (node:sqlite) is unavailable on this multi-process host: file is not a database. Rundown does not downgrade to the single-writer sql.js adapter outside WebContainer.
```

**JSON:**

```json
{
  "kind": "error",
  "error": "Runbook database unavailable - Native SQLite (node:sqlite) is unavailable on this multi-process host: file is not a database. Rundown does not downgrade to the single-writer sql.js adapter outside WebContainer.",
  "code": "RD-307",
  "details": {
    "category": "STATE",
    "title": "Runbook database unavailable",
    "context": { "driverCode": "ERR_SQLITE_ERROR" }
  }
}
```

#### `RD-308` — run state lost to a concurrent writer

A run-state read-modify-write made its one conditional save and found that
another write had landed on the same run first. It is refused, not retried;
nothing was written and the persisted state is intact.

This is the **thrown face** of the same condition the symbolic
`CONCURRENT_MODIFICATION` code renders when a command returns it as an outcome.
The two are not duplicates and must not be merged: the symbolic code is a
command result, while `RD-308` is what escapes the throwing state-manager seam
to the top-level wrapper, which speaks only `RD-NNN`.

Alone among the `3xx` state errors this is **transient, not a refusal of the
run**: re-read the run and re-run the command.

**Text:**

```text
Error RD-308: Runbook state lost to a concurrent writer - Run rd_0123456789abcdef0123456789abcdef was modified concurrently by another writer.
```

**JSON:**

```json
{
  "kind": "error",
  "error": "Runbook state lost to a concurrent writer - Run rd_0123456789abcdef0123456789abcdef was modified concurrently by another writer.",
  "code": "RD-308",
  "details": {
    "category": "STATE",
    "title": "Runbook state lost to a concurrent writer",
    "context": { "runId": "rd_0123456789abcdef0123456789abcdef" }
  }
}
```

#### `RD-309` — invalid persisted run state

A run in the database does not match the state contract this build reads:
unparseable persisted state, a `RunbookState.schemaVersion` other than the
build's own `CURRENT_SCHEMA_VERSION`, a missing required field such as
`templateVars` or `prompted`, a cursor naming a step the runbook no longer
declares, or a deprecated dynamic-step snapshot. Rundown never migrates
persisted state, so the run cannot be resumed and is never silently repaired.

Scope is deliberately narrow and is the reason this is not `RD-305`: **only that
run is affected**, and the database and every other run in it are intact. The
store's own diagnosis is preserved verbatim ahead of the recovery, because it is
what identifies which run and why.

Any command that loads the run refuses with `RD-309`, including `complete` and
`stop`. `rundown status` and `rundown ls` skip the run and write a
`[rundown] Warning: Invalid runbook state for …` line to stderr. The recovery
that clears it is `rundown prune --inactive` (or `--all`), which reaches the run
through prune's invalid-id path and lists it with `status: "invalid"`; an
unfiltered `rundown prune` selects completed and stopped runs only, so it never
sees the invalid row.

Being scoped to one run is also why `context` names it. `runId` is the affected
run, `reason` is a closed set naming which refusal fired (`unparseable_json`,
`invalid_schema_version`, `missing_template_vars`, `missing_prompted`,
`schema_validation_failed`, `legacy_dynamic_step_snapshot`,
`missing_render_context`, `unsupported_snapshot_state_value`,
`snapshot_step_not_in_runbook`, `cursor_step_not_in_runbook`,
`missing_frontmatter_outputs`), and `schemaVersion` — present only for
`invalid_schema_version` — is the version the row claims, reported exactly as
persisted and deliberately not narrowed to a number. That last field appears
**nowhere** in the message prose, so structured context is the only way to read
it.

**Text:**

```text
Error RD-309: Invalid persisted run state - Invalid runbook state for "rd_0123456789abcdef0123456789abcdef": invalid schemaVersion; expected schema version 4. Rundown never migrates persisted state, so this run cannot be resumed, completed or stopped: discard it with "rundown prune --inactive", then re-run the runbook from source.
```

**JSON:**

```json
{
  "kind": "error",
  "error": "Invalid persisted run state - Invalid runbook state for \"rd_0123456789abcdef0123456789abcdef\": invalid schemaVersion; expected schema version 4. Rundown never migrates persisted state, so this run cannot be resumed, completed or stopped: discard it with \"rundown prune --inactive\", then re-run the runbook from source.",
  "code": "RD-309",
  "details": {
    "category": "STATE",
    "title": "Invalid persisted run state",
    "context": {
      "runId": "rd_0123456789abcdef0123456789abcdef",
      "reason": "invalid_schema_version",
      "schemaVersion": 1
    }
  }
}
```
