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
| `stash`              | Stash response                      | `stash`                                    |
| `pop`                | Pop response                        | `pop`                                      |
| `scenario_run`       | Scenario run result                 | `scenario run`                             |
| `scenario_suite_run` | Scenario suite aggregate result     | `scenario-suite run`                       |
| `run`                | Run command execution summary       | `run` (final terminal object)              |
| `delegate`           | Delegate response                   | `delegate`                                 |
| `claim`              | Claim response                      | `claim`                                    |
| `abort`              | Abort response                      | `abort`                                    |
| `collect`            | Collect response                    | `collect`                                  |

List responses (`ls`, `prune`, `scenario ls`, `scenario-suite ls`) are detected
by `Array.isArray()` and carry no `kind` field.

### Key Conventions

- **Discriminant**: All non-list responses carry a `kind` literal. It is the
  primary, authoritative type discriminant.
- **Lists**: Raw arrays `[...]` (no wrapper object, no `kind`)
- **Workflow commands**: Include `action` field. Transition commands (`pass`,
  `fail`, `goto`) use transition text; lifecycle/session commands (`run`,
  `stop`, `complete`, `stash`, `pop`) use command-name actions.
- **Errors**: `{ "kind": "error", "error": "message", "code": "CODE" }`. The
  `command` field names the CLI command that triggered the error when known.
- **Warnings**: `{ "kind": "warning", "message": "message", "code": "CODE" }`
- **Success/failure**: Workflow commands use exit code, not a `result` field
- **Position**: `{ "current": string, "total": number }`
- **Action field**: For transition commands, shows transition text (e.g.,
  "CONTINUE", "GOTO 3", "RETRY"); for lifecycle/session commands, shows the
  command-name action (e.g., "complete", "stop", "stash", "pop").

### Schema Reference

Authoritative response schemas: `packages/core/src/output/zod-schemas.ts`. These
Zod schemas are the single source of truth; the TypeScript response types are
derived from them via `z.infer<>`. The `packages/core/src/output/schema.ts`
module is a re-export barrel of those derived types plus type guards.

The `--schema` flag's command-to-schema map lives in
`packages/cli/src/schemas/output-schemas.ts` (`COMMAND_SCHEMAS`).

### Unified Types

**Runbook** - Used by `ls` and `prune` for runbook listings:

```json
{
  "id": "string",      // Run identifier (`rd_` + 32 hex)
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

**Text:**

Text mode truncates the run id to its first 8 characters; JSON carries it in
full.

```text
ID        STATUS   STEP  RUNBOOK                    TITLE
rd_01234  active   1/3   deploy.runbook.md          Deploy to Production
rd_56789  stashed  2/5   onboarding.runbook.md      New Hire Setup
```

**JSON:**

```json
[
  {
    "id": "rd_0123456789abcdef0123456789abcdef",
    "status": "active",
    "runbook": "deploy.runbook.md",
    "step": "1",
    "total": 3,
    "title": "Deploy to Production"
  }
]
```

### `rundown ls --all`

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

### `rundown status` (active runbook)

**Text:**

```text
File:     runbooks/deploy.runbook.md
State:    .rundown/rundown.db
Run:      rd_0123456789abcdef0123456789abcdef
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
  "state": ".rundown/rundown.db",
  "runId": "rd_0123456789abcdef0123456789abcdef",
  "prompted": true,
  "position": { "current": "1", "total": 3 },
  "step": { "name": "1", "description": "First Step" }
}
```

Active status responses always include `lastAction`. They include `vars` when
scalar variables are present (it is omitted when there are none), and
additionally include `delegations` and `parentLinkage` when present. Accumulated
artifact records live in the unified `state.variables` map alongside other
variables and are surfaced through `vars` rather than a separate field.

`state` names the SQLite authority and is the same constant for every run, so
`runId` is what identifies which run the response describes. It is not
caller-scoped: a caller without `--claim-id` sees it on a claimed child's
stashed status, just as it already sees that child's `file`, `position`, and
`parentLinkage` (which carries `parentRunId` and `tokenHash`). Caller scoping
withholds variable _contents_ — `vars` and `artifacts` — not identity, and a run
id cannot be exchanged for them because no read command accepts one as a
selector. `runId` appears on successful responses only; refusal envelopes never
echo the target run id (see [Actor context required](#actor-context-required)).

Claimed `delegations` entries MAY carry an optional non-secret `claimKey`
(pattern `rdclk_...`, present only when the entry's `state` is `claimed`) for
correlation. Delegation entries expose the non-secret `tokenHash` but never the
raw delegation token. Bearer `claim_id` values are only returned by
`rundown claim` and the `runbook_started` event emitted by `rundown run`; they
are never reconstructed from status output. The Zod
`DelegationStatusEntrySchema` in `@rundown-org/core` remains the single source
of truth for the exact per-entry shape.

### `rundown status` (no active runbook)

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

### `rundown status --claim-id <claim_id>`

Same output shape as active `rundown status`, but resolves the delegated child
identified by `claim_id` instead of the default stack. Invalid, missing, stale,
terminal, or unlinked claim ids return an error response.

---

## run

### `rundown run <file>`

**Text:**

```text
File:     runbooks/deploy.runbook.md
State:    .rundown/rundown.db
Run:      rd_0123456789abcdef0123456789abcdef

Action:   START

## 1. First Step

Step description here.

$ echo "hello"
hello

Runbook:  COMPLETE
```

**JSON:**

`rundown run` emits newline-delimited JSON events. Each line is one JSON object.
Event type names are lowercase snake_case, and event payload fields are
flattened onto the JSONL object alongside envelope fields such as `timestamp`,
`runbookId`, `runbook`, and `seq`. The final line is a terminal lifecycle event.

In machine-readable mode, stdout is reserved for Rundown JSON/JSONL output. When
a command step executes as part of a Rundown command that emits structured
output, the child command's stdout and stderr are passed through on stderr so
arbitrary command bytes cannot corrupt the JSON stream. `--text` preserves the
human terminal behavior.

```jsonl
{"type":"runbook_started","prompted":false,"claim_id":"rdclm_0123456789abcdef0123456789abcdef_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":1}
{"type":"step_entered","position":{"current":"1","total":1},"stepName":"1","description":"First Step","hasCommand":true,"commandCode":"echo \"hello\"","commandLang":"bash","isSubstep":false,"prompted":false,"artifacts":{},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":2}
{"type":"command_started","command":"echo \"hello\"","displayCommand":"echo \"hello\"","position":{"current":"1","total":1},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":3}
{"type":"command_completed","command":"echo \"hello\"","success":true,"exitCode":0,"position":{"current":"1","total":1},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":4}
{"type":"runbook_completed","finalPosition":{"current":"1","total":1},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":5}
```

The internal event payload field is `STEP_ENTERED.payload.artifacts`; the CLI
JSONL field is flattened as `artifacts` on the `step_entered` line. `artifacts`
is required and contains only the entered step/substep's working set. It is `{}`
when that execution unit has no `ARTIFACTS` directive. It is not the full
accumulated variable map; accumulated artifact records live in
`state.variables`.

Runtime command text is rendered once per execution. The exact rendered string
is reused for the flattened `step_entered.commandCode` field and actual command
execution.

### `STEP_ENTERED` with inline launch

Non-DELEGATE runbook-list substeps launch child runbooks inline. The entered
parent substep emits `inlineLaunch` so front ends can attribute the upcoming
child runbook start to the parent substep.

```jsonl
{"type":"step_entered","position":{"current":"2","total":3,"substep":"1","at":"2.1","frameKey":"2|","entry":1},"stepName":"2","description":"Runbook: child.runbook.md","hasCommand":false,"isSubstep":true,"prompted":false,"artifacts":{},"inlineLaunch":{"parentRunId":"rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parentStepId":"1","parentStep":"2","parentFrameKey":"2|","parentEntry":1,"childRunId":"rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","childRunbookPath":"child.runbook.md","childRunbookRef":{"source":"project","path":"child.runbook.md"}},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runbook":{"source":"project","path":"runbooks/parent.runbook.md"},"seq":4}
```

The internal `STEP_ENTERED.payload.inlineLaunch.contextSnapshot` is used to
inherit variables and artifacts into the inline child. It MUST NOT appear in
public CLI JSON output; the public `inlineLaunch` object is the same intent with
`contextSnapshot` redacted.

Inline launch failure stops the active runbook instead of silently falling back
to local substep execution. The stopped reason is `inline_launch_failed` for
ordinary launch failures such as unresolved or ambiguous child runbooks, and
`inline_launch_forbidden` when an inline launch is attempted inside a claimed
delegated child scope. The corresponding JSON error/action output uses codes
such as `INLINE_CHILD_LAUNCH_FAILED`, `INLINE_CHILD_LINKAGE_MISMATCH`,
`INLINE_CHILD_FRAME_SUPERSEDED`, or `INLINE_LAUNCH_FORBIDDEN`; consumers should
treat these as terminal workflow failures for the active runbook.

The two linkage refusals are registered error codes —
`INLINE_CHILD_FRAME_SUPERSEDED` is **RD-830** and
`INLINE_CHILD_LINKAGE_MISMATCH` is **RD-831** — so each carries a title,
remediation description, and doc slug in the registry, and the emitting switch
is typed against `ErrorCodeKey` rather than against bare strings. The emitted
`code` value remains the symbolic name, which is what consumers match on.
`INLINE_CHILD_LAUNCH_FAILED` and `INLINE_LAUNCH_FORBIDDEN` are not yet
registered.

`INLINE_CHILD_FRAME_SUPERSEDED` is the one refusal in that set an ordinary
gesture reaches. A self-targeting `GOTO` or `RETRY` re-enters the parent's frame
and advances its entry counter, so an inline child launched at an earlier entry
belongs to an earlier visit and is never adopted by the new one — the same
judgement delegation makes when it closes a child `cursor-advanced`. The message
names both entries and the frame; the remedy is to finish, stop, or prune the
superseded child run, after which the same re-entry launches a fresh child under
the current entry. `INLINE_CHILD_LINKAGE_MISMATCH` is a different condition: the
persisted child names a different parent run, step, substep, or frame, which is
inconsistent state rather than a superseded generation.

### `STEP_ENTERED` with artifacts

```jsonl
{"type":"step_entered","position":{"current":"2","total":4},"stepName":"2","description":"Write plan","hasCommand":true,"commandCode":"printf '%s\n' '/project/.rundown/work/.rd-ctx1/rd_0123456789abcdef0123456789abcdef/plan.json'","commandLang":"bash","isSubstep":false,"prompted":false,"artifacts":{"PlanPath":{"kind":"artifact-record","uri":"rd://artifacts/ctx1/rd_0123456789abcdef0123456789abcdef/plan.json","path":"/project/.rundown/work/.rd-ctx1/rd_0123456789abcdef0123456789abcdef/plan.json","runId":"rd_0123456789abcdef0123456789abcdef","contextId":"ctx1","runbook":{"source":"project","path":"planning/write-plan.runbook.md"},"key":"plan.json","timestamp":"2026-05-07T00:00:00.000Z"},"Reviews":[]},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"planning/write-plan.runbook.md"},"seq":2}
```

`Reviews: []` is a meaningful empty wildcard result and must be preserved in
JSON output.

Text output remains human-readable and does not print raw artifact JSON by
default. Artifact values may appear in rendered prompt or command text when
authors reference them directly or through helpers. JSON output is the
authoritative interface for artifact identity and provenance.

## `rundown artifact`

`rundown artifact ls`, `inspect`, `path`, and `uri` expose core artifact
projections for the active run context. JSON output is schema-backed and
full-record by default for agents. These commands do not read or write artifact
file contents; they only list, inspect, or project artifact aliases and URIs.
`rundown artifact path --text` and `rundown artifact uri --text` are the only
concise projection outputs.

Non-list artifact responses (`path`, `uri`, `inspect`) carry a `kind`
discriminant: scalar entries reuse the record's own `kind` (`artifact-record` /
`file-artifact-record`), while an alias bound to multiple records is tagged
`artifact-array`. `ls` returns a raw array whose elements carry the same
discriminants. Authoritative shapes live in
`packages/core/src/output/zod-schemas.ts`.

---

## claim

### `rundown claim <token>`

Claims a delegation token, launches the delegated child runbook, and returns the
`claim_id` used for subsequent child-targeting commands.

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
  "claim_id": "rdclm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "run_id": "rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "runbook": "child.runbook.md",
  "parent_run_id": "rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "parent_step": "1.1"
}
```

Use the returned `claim_id` with `rundown status --claim-id <claim_id>`,
`rundown pass --claim-id <claim_id>`, or `rundown fail --claim-id <claim_id>`
for delegated child work.

---

### `rundown abort <token> --claim-id <claim_id>`

Cancels a delegation. `status` is `cancelled` on the first abort and
`already_cancelled` on a repeat.

**JSON:**

```json
{
  "kind": "abort",
  "action": "abort",
  "status": "cancelled",
  "token": "rdtk_abcd...",
  "substep": "1.1",
  "runbook": "child.runbook.md",
  "parent_run_id": "rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "cleanup": "terminal_child_cleaned",
  "force": true
}
```

`cleanup` reports which linked-child branch core actually ran, and is present on
`status: "cancelled"` only:

| `cleanup`                | Meaning                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `none`                   | No child was ever linked — a pending delegation was cancelled        |
| `active_child_failed`    | A live claimed child was torn down and recorded as failed            |
| `terminal_child_cleaned` | An already-terminal linked child was cleaned up                      |
| `missing_child_cleaned`  | A stale delegated outcome was superseded; the child run has vanished |

`force` is emitted **only when a linked-child teardown actually ran** — that is,
for the three non-`none` branches. It is derived from `cleanup`, not echoed from
the caller's `--force` argument, so it never claims a teardown that did not
happen. A pending delegation therefore reports `"cleanup": "none"` with **no**
`force` field, even when `--force` was passed:

```json
{
  "kind": "abort",
  "action": "abort",
  "status": "cancelled",
  "token": "rdtk_abcd...",
  "substep": "1.1",
  "runbook": "child.runbook.md",
  "parent_run_id": "rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "cleanup": "none"
}
```

`childRunId` is present when a claimed delegation was force-cancelled.

---

## pass

On a delegation-exposed run the bare form fails with `ACTOR_CONTEXT_REQUIRED` —
see [Error Output](#actor-context-required). Name your lane with
`--claim-id <claimId>` — the bearer claim is the only mutation authority. `pass`
has no `--run` selector.

### `rundown pass`

The `action` field shows the transition (e.g., "CONTINUE" to next step, "GOTO 3"
for jump).

**Text:**

```text
─── 2 ──────────────────────────────────────────

Action:   CONTINUE
From:     1
Result:   PASS
At:       2

## 2. Second Step

Next step description.
```

**JSON:**

```json
{
  "kind": "action",
  "action": "CONTINUE",
  "stepResult": "PASS",
  "from": "1",
  "at": "2"
}
```

`from` and `at` are plain qualified step-ID strings (the step before the
transition, and the step after). There is no `to` field.

Transition responses (`pass`, `fail`, `goto`) carry no metadata block: no
`file`, `state`, or `runId` in JSON, and no `File:`/`State:`/`Run:` header in
text — on terminal and non-terminal transitions alike. `rundown run` and the
session and lifecycle commands (`status`, `stop`, `complete`, `stash`, `pop`) do
emit that metadata, including `runId`. Correlate a transition with its run
through the `runbook_started` event's `runbookId` emitted by `rundown run`, or
by calling `rundown status`.

### `rundown pass --claim-id <claim_id>`

Same output shape as `rundown pass`, but targets the delegated child identified
by `claim_id` instead of the default stack.

---

## fail

On a delegation-exposed run the bare form fails with `ACTOR_CONTEXT_REQUIRED` —
see [Error Output](#actor-context-required). Name your lane with
`--claim-id <claimId>` — the bearer claim is the only mutation authority. `fail`
has no `--run` selector.

The `action` field shows the transition (e.g., "RETRY (1/3)" for retry, "STOP"
for stopping).

### `rundown fail` (retry)

**Text:**

```text
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
  "at": "1"
}
```

### `rundown fail` (stop)

**Text:**

```text
Runbook:  STOP
```

**JSON:**

```json
{
  "kind": "action",
  "action": "stop",
  "stepResult": "FAIL",
  "from": "1",
  "at": "1",
  "stopped": true
}
```

### `rundown fail --claim-id <claim_id>`

Same output shape as `rundown fail`, but targets the delegated child identified
by `claim_id` instead of the default stack.

---

## goto

On a delegation-exposed run the bare form fails with `ACTOR_CONTEXT_REQUIRED` —
see [Error Output](#actor-context-required). Name your lane with
`--claim-id <claimId>` — the bearer claim is the only mutation authority.
`--run <rd_…>` selects a target but never satisfies the `ACTOR_CONTEXT_REQUIRED`
refusal on a delegation-exposed run, and must not be combined with `--claim-id`.
`goto` is additionally gated behind the `run-navigation` policy intent.

### `rundown goto <step>`

The `action` field is combined (e.g., "GOTO 3"), not a separate `target` field.

**Text:**

```text
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
  "from": "1",
  "at": "3"
}
```

---

## stop

On a delegation-exposed run the bare form fails with `ACTOR_CONTEXT_REQUIRED` —
see [Error Output](#actor-context-required). Name your lane with
`--claim-id <claimId>` — the bearer claim is the only mutation authority.
`--run <rd_…>` selects a target but never satisfies the `ACTOR_CONTEXT_REQUIRED`
refusal on a delegation-exposed run, and must not be combined with `--claim-id`.

### `rundown stop [message]`

Uses `action: "stop"` (command-name action). Stopping sets a non-zero exit code.

Bare `rundown stop` is a failure terminal and exits non-zero after successfully
stopping the workflow. `rundown stop --claim-id` preserves delegated report-only
close semantics and exits zero unless the claim is unavailable or another
command error occurs.

Force-terminal commands emit the same terminal observation events as non-force
transitions: `runbook_completed` for complete and `runbook_stopped` for stop.
For inline composition, events are emitted for each forced terminal state in the
active inline chain, ordered descendant-to-root with monotonically increasing
`seq`; the root terminal event is last. The streamed observation precedes the
final command-name action object, so parse newline-delimited JSON (the action
object is the last line).

**Text:**

```text
File:     runbooks/deploy.runbook.md
State:    .rundown/rundown.db
Run:      rd_0123456789abcdef0123456789abcdef

Runbook:  STOP
```

**JSON:**

Bare `rundown stop` emits newline-delimited JSON: the streamed
`step_transitioned` and `runbook_stopped` observation events precede the final
`stop` action object, which is the last line.

```jsonl
{"type":"step_transitioned","action":"STOP","from":"1","at":"1","result":"FAIL","command":"stop","timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":1}
{"type":"runbook_stopped","message":"User requested stop","position":{"current":"1","total":1},"reason":"fail_transition","timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":2}
{"file":"runbooks/deploy.runbook.md","state":".rundown/rundown.db","runId":"rd_0123456789abcdef0123456789abcdef","action":"stop","stopped":true,"kind":"action","message":"User requested stop"}
```

---

## complete

On a delegation-exposed run the bare form fails with `ACTOR_CONTEXT_REQUIRED` —
see [Error Output](#actor-context-required). Name your lane with
`--claim-id <claimId>` — the bearer claim is the only mutation authority.
`--run <rd_…>` selects a target but never satisfies the `ACTOR_CONTEXT_REQUIRED`
refusal on a delegation-exposed run, and must not be combined with `--claim-id`.

### `rundown complete [message]`

**Text:**

```text
File:     runbooks/deploy.runbook.md
State:    .rundown/rundown.db
Run:      rd_0123456789abcdef0123456789abcdef

Runbook:  COMPLETE
```

**JSON:**

Bare `rundown complete` emits newline-delimited JSON: the streamed
`step_transitioned` and `runbook_completed` observation events precede the final
`complete` action object, which is the last line.

```jsonl
{"type":"step_transitioned","action":"COMPLETE","from":"1","at":"1","result":"PASS","command":"complete","timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":1}
{"type":"runbook_completed","message":"Deployment finished","finalPosition":{"current":"1","total":1},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/deploy.runbook.md"},"seq":2}
{"file":"runbooks/deploy.runbook.md","state":".rundown/rundown.db","runId":"rd_0123456789abcdef0123456789abcdef","action":"complete","complete":true,"kind":"action","message":"Deployment finished"}
```

---

## stash

### `rundown stash`

Uses `action: "stash"` (command-name action).

**Text:**

```text
File:     runbooks/deploy.runbook.md
State:    .rundown/rundown.db
Run:      rd_0123456789abcdef0123456789abcdef
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
  "state": ".rundown/rundown.db",
  "runId": "rd_0123456789abcdef0123456789abcdef",
  "prompted": true,
  "position": { "current": "1", "total": 3 }
}
```

### `rundown stash --claim-id <claim_id>`

Same output shape as `rundown stash`, but stashes the runbook identified by
`claim_id`. The bearer is verified inside the transaction that writes the stash
slot, so a rotated, released, or superseded bearer refuses and the slot is left
unchanged.

**JSON (rotated or released bearer):**

```json
{
  "kind": "error",
  "error": "Claim id rdclk_3668bda31850ba84c2c1bb9a991a2d33 was released or replaced and is no longer authority. Claim the parent's current delegation instead of reusing this id.",
  "code": "CLAIMED_RUNBOOK_UNAVAILABLE",
  "command": "stash"
}
```

---

## pop

### `rundown pop`

Uses `action: "pop"` (command-name action).

**Text:**

```text
File:     runbooks/deploy.runbook.md
State:    .rundown/rundown.db
Run:      rd_0123456789abcdef0123456789abcdef
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
  "state": ".rundown/rundown.db",
  "runId": "rd_0123456789abcdef0123456789abcdef",
  "prompted": true,
  "position": { "current": "2", "total": 3 },
  "step": { "name": "2", "description": "Second Step" }
}
```

### `rundown pop --claim-id <claim_id>`

Same output shape as `rundown pop`, but restores the stashed delegated child
identified by `claim_id`.

### `rundown pop` (nothing stashed)

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

Prune uses the same `Runbook` format as `ls`, with status values like "invalid"
or "inactive". Ids are run ids (`rd_` + 32 hex) in both modes — prune reads them
from the store as `RunId`s, and unlike `ls`, its text `ID` column is not
truncated.

### `rundown prune --dry-run`

**Text:**

```text
ID                                   STATUS    RUNBOOK                TITLE
rd_0123456789abcdef0123456789abcdef  invalid   (invalid)
rd_fedcba9876543210fedcba9876543210  inactive  old-deploy.runbook.md  [Old Deploy]
```

**JSON:**

```json
[
  {
    "id": "rd_0123456789abcdef0123456789abcdef",
    "status": "invalid",
    "runbook": "(invalid)"
  },
  {
    "id": "rd_fedcba9876543210fedcba9876543210",
    "status": "inactive",
    "runbook": "old-deploy.runbook.md",
    "title": "Old Deploy"
  }
]
```

### `rundown prune`

Both dry-run and actual prune output the same format.

**Text:**

```text
Pruned 2 invalid state files.
```

**JSON:**

```json
[
  {
    "id": "rd_0123456789abcdef0123456789abcdef",
    "status": "invalid",
    "runbook": "(invalid)"
  },
  {
    "id": "rd_fedcba9876543210fedcba9876543210",
    "status": "inactive",
    "runbook": "old-deploy.runbook.md",
    "title": "Old Deploy"
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

### `rundown scenario ls <file>`

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

### `rundown scenario show <file> <name>`

**Text:**

```text
Name:        success
Description: Happy path test
Expected:    COMPLETE
Commands:
  $ rundown run test.runbook.md
  $ rundown pass
```

**JSON:**

```json
{
  "name": "success",
  "description": "Happy path test",
  "expected": "COMPLETE",
  "commands": ["rundown run test.runbook.md", "rundown pass"],
  "tags": ["smoke"]
}
```

### `rundown scenario show <file> <name>` (not found)

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

### `rundown scenario run <file> <name>`

Uses `result` (a boolean) to indicate scenario outcome. This is scenario
verification, not workflow — the boolean is the verification verdict, not a step
result.

Scenario `expect.entered` entries, represented internally as
`enteredAssertions`, match captured `step_entered` events. Supported fields are
`at`, `description`, and `runbook`; `runbook` matches the suffix of the event's
canonical `runbook.path`. Use these assertions for entry-only behavior that does
not necessarily emit a transition, especially inline runbook-list launches whose
generated parent substep description is `Runbook: <child>`.

**Text:**

```text
Scenario:  success
──────────────────────────────────────────────────

$ rundown run test.runbook.md
[command output]

$ rundown pass
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

### `rundown echo [command...]`

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

### `rundown echo --result fail`

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

### `rundown prompt <content>`

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

Error responses carry `kind: "error"` along with `error` and `code` fields. When
the triggering command is known, a `command` field names it. A non-zero exit
code indicates failure.

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

### Actor context required

A bare mutating command (`pass`, `fail`, `goto`, `collect`, `complete`, `stop`,
`delegate`) issued without bearer claim authority. Exposure is sticky, so
refusal may persist after claims close and after `rundown prune`. The
remediation names the bearer lane and **never echoes the target run id**
(accident-proofing, not id secrecy — run ids are natively available from
`rundown run` output and every event's `runbookId`).

**Text:**

```text
Error: This run has delegation activity, so a bare `rundown pass` is refused. Pass `--claim-id <claimId>` if you are completing delegated work.
Code: ACTOR_CONTEXT_REQUIRED
```

**JSON:**

```json
{
  "kind": "error",
  "error": "This run has delegation activity, so a bare `rundown pass` is refused. Pass `--claim-id <claimId>` if you are completing delegated work.",
  "code": "ACTOR_CONTEXT_REQUIRED",
  "command": "pass"
}
```

### Claim bearer mismatch

The presented bearer claim is not the claim the command targeted, so the command
is refused rather than run under the target's authority. Deliberately distinct
from `ACTOR_CONTEXT_REQUIRED`: authority _was_ named, so that refusal's "pass
`--claim-id`" remediation would misdiagnose it.

**Unreachable from the `rundown` CLI** — `--claim-id` supplies both the evidence
and the target, so the two cannot disagree. Only a programmatic front end that
populates them independently can provoke it. It is documented and registered
because `ErrorCodeSchema` is a closed enum: a consumer validating against the
published schema must accept the code rather than reject the envelope.

The envelope names neither claim. The seam refuses before resolving either one,
so there is no verified claim record to reduce to a non-secret `claimKey`, and
echoing a raw `claimId` would write a bearer secret to output and logs.

**Text:**

```text
Error: The presented claim id is not the claim `rundown pass` targeted, so the command is refused rather than run under the target's authority. Present the bearer for the claim you are targeting.
Code: CLAIM_BEARER_MISMATCH
```

**JSON:**

```json
{
  "kind": "error",
  "error": "The presented claim id is not the claim `rundown pass` targeted, so the command is refused rather than run under the target's authority. Present the bearer for the claim you are targeting.",
  "code": "CLAIM_BEARER_MISMATCH",
  "command": "pass"
}
```

### Execution in progress

The command needed to change session targeting (the default stack, the stash
slot, or a claim) for a run another process is currently executing. Execution
ownership is exclusive, so the mutation is refused rather than applied under the
owner — a refusal, not a failure: nothing was written, and the command is safe
to retry once the owner finishes.

The envelope names the blocked run inside the message. There is no top-level
`runbookId` field on an error envelope, and the owning process is deliberately
not identified.

**Text:**

```text
Error: Run rd_9e725b142d81dabcefb9e04919568fcd has an execution in progress.
Code: EXECUTION_IN_PROGRESS
```

**JSON:**

```json
{
  "kind": "error",
  "error": "Run rd_9e725b142d81dabcefb9e04919568fcd has an execution in progress.",
  "code": "EXECUTION_IN_PROGRESS",
  "command": "pass"
}
```

### Recovery required

The command needed to change session targeting for a run whose last execution
attempt ended without recording an outcome, so whether its effect ran is
unknown. Distinct from `EXECUTION_IN_PROGRESS`: no live process is advancing the
run, so waiting will not clear it. That is not the same as the run being free —
it stays execution-owned, because the interrupted attempt is abandoned without
releasing ownership. The interrupted attempt must be recovered first.

**There is no `rundown recover` command**, and never has been. But do not read
that as "recovery happens by itself here" — `RECOVERY_REQUIRED` is emitted from
two different places, and only one of them recovers anything:

| Origin                                                                                                         | Message                                                       | Recovers?                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Execution fence** — the effect-boundary refusal on a run you are executing                                   | `Run … needs recovery: …`                                     | **Yes.** `EffectfulActorMutationRunner` recovers the exact epoch inline, in the same call, then still reports the refusal so the command is not retried |
| **Session-targeting write** — `stash`, `pop`, `prune`, `delegate`, `abort`, and the run/terminal release paths | `Run … ended execution with an unknown outcome at epoch N; …` | **No.** Detection only. Nothing is written and no recovery is started, so the attempt is still pending afterwards                                       |

The envelope below is the **session-targeting** one, and its message says so:
retrying the same command cannot make progress, because nothing about the run
changed. The interrupted attempt leaves the run execution-owned, so what clears
it depends on the owner: while that process is still alive, a later
execution-owning command refuses `EXECUTION_IN_PROGRESS` rather than recovering
it. Once the owner is gone — the SIGKILL case — the next execution-owning
command's dead-owner probe recovers the exact epoch inline and unblocks the run,
still reporting the refusal so the command is not retried. See
[docs/internal/architecture.md § Owner-identity recovery](../internal/architecture.md#owner-identity-recovery).

The message names the run and the recovery epoch of the unresolved attempt.

**Text:**

```text
Error: Run rd_9e725b142d81dabcefb9e04919568fcd ended execution with an unknown outcome at epoch 7; its recovery has not completed. Nothing was written and no recovery was started here, so retrying this command will not clear it.
Code: RECOVERY_REQUIRED
```

**JSON:**

```json
{
  "kind": "error",
  "error": "Run rd_9e725b142d81dabcefb9e04919568fcd ended execution with an unknown outcome at epoch 7; its recovery has not completed. Nothing was written and no recovery was started here, so retrying this command will not clear it.",
  "code": "RECOVERY_REQUIRED",
  "command": "pass"
}
```

### Aggregate recovery required

The multi-run form of the refusal above. A command that mutates several runs
atomically (a forced inline terminal cascade, an aggregate delegation abort)
crossed its effect boundary without recording an outcome for every member, so
more than one run needs recovery.

It is a **distinct code**, not a plural spelling of `RECOVERY_REQUIRED`: only
this envelope carries `details.runs`, the exact `(runId, epoch)` set that must
be recovered before the workflow can resume. A consumer routing on `code` alone
must be able to tell the two envelope shapes apart.

**Text:**

```text
Error: The aggregate execution outcome is unknown and requires recovery.
Code: AGGREGATE_RECOVERY_REQUIRED
```

**JSON:**

```json
{
  "kind": "error",
  "error": "The aggregate execution outcome is unknown and requires recovery.",
  "code": "AGGREGATE_RECOVERY_REQUIRED",
  "command": "stop",
  "details": {
    "runs": [
      { "runId": "rd_9e725b142d81dabcefb9e04919568fcd", "epoch": 4 },
      { "runId": "rd_3f0c1a7b28d94ef5a6b0c9d3e81f2a47", "epoch": 1 }
    ]
  }
}
```

### Stale claim

The presented bearer claim stopped being the target run's controlling authority
between the moment the mutation captured that authority and the moment it tried
to commit — the claim was released, rotated, or re-issued, its generation
advanced, or the delegated parent went terminal or was relinked underneath it.
The transaction refuses atomically: nothing was written, and the mutation is
**not** safe to retry with the same claim.

Deliberately distinct from the two resolution-time refusals that describe a
claim that was _already_ not authority when the command resolved its target —
`DELEGATION_SUPERSEDED` (the parent moved past the delegation) and
`CLAIMED_RUNBOOK_UNAVAILABLE` (the claim was released or its parent row is
gone). `STALE_CLAIM` is the compare-and-swap loss: authority held at capture,
gone at commit. Three codes for three causes, because the remediation differs —
a resolution-time refusal means "the claim was never going to work";
`STALE_CLAIM` means "something raced you".

The envelope names the blocked run inside the message and carries **no
`details`**: unlike `AGGREGATE_RECOVERY_REQUIRED`, this arm has no structured
payload. The claim itself is never echoed — it is a bearer secret.

**Text:**

```text
Error: Run rd_9e725b142d81dabcefb9e04919568fcd claim generation advanced since it was captured.
Code: STALE_CLAIM
```

**JSON:**

```json
{
  "kind": "error",
  "error": "Run rd_9e725b142d81dabcefb9e04919568fcd claim generation advanced since it was captured.",
  "code": "STALE_CLAIM",
  "command": "pass"
}
```

### Concurrent modification

The parent run changed after Rundown derived the delegated child link but before
the transaction could persist that link with the initial claim. The transaction
refuses atomically: neither the claim nor the parent link is written.

**Text:**

```text
Error: The parent changed while the delegated child claim was being committed. Retry.
Code: CONCURRENT_MODIFICATION
```

**JSON:**

```json
{
  "kind": "error",
  "error": "The parent changed while the delegated child claim was being committed. Retry.",
  "code": "CONCURRENT_MODIFICATION",
  "command": "claim",
  "details": {
    "parentRunId": "rd_11111111111111111111111111111111",
    "stepId": "1.1",
    "childRunId": "rd_22222222222222222222222222222222"
  }
}
```

### Run target unavailable

The `--run` id supplied is not a running member of this session's active stack.
Claimed delegated children are never stack members — target them with
`--claim-id` instead. The message names the caller-supplied id (the caller
already holds it); it does not reveal any run the caller did not name.

**Text:**

```text
Error: Run rd_9e725b142d81dabcefb9e04919568fcd is not part of this session's active stack.
Code: RUN_TARGET_UNAVAILABLE
```

**JSON:**

```json
{
  "kind": "error",
  "error": "Run rd_9e725b142d81dabcefb9e04919568fcd is not part of this session's active stack.",
  "code": "RUN_TARGET_UNAVAILABLE",
  "command": "goto"
}
```

### Run target mismatch

`rundown delegate --retry <token> --run <rd_…>` where the `--run` id is a valid
target but is **not** the run that owns the supplied delegation token. Distinct
from `RUN_TARGET_UNAVAILABLE`: the named run may be a perfectly healthy, running
member of the active stack — the refusal is about token ownership, not stack
membership. Named authority is never silently discarded, so the retry is refused
rather than redirected to the token's real owner.

The message names only the caller-supplied id. It **never** echoes the run that
actually owns the token (accident-proofing: the caller learns their `--run` is
wrong without learning which run to name instead).

**Text:**

```text
Error: Run rd_9e725b142d81dabcefb9e04919568fcd does not own the supplied delegation token.
Code: RUN_TARGET_MISMATCH
```

**JSON:**

```json
{
  "kind": "error",
  "error": "Run rd_9e725b142d81dabcefb9e04919568fcd does not own the supplied delegation token.",
  "code": "RUN_TARGET_MISMATCH",
  "command": "delegate"
}
```

### Retry already applied

`rundown delegate --retry` when the retry has already been applied and the
replacement shows no committed evidence its bearer was used. Nothing is written
and the exit code is 0 — this is a successful idempotent replay, not a refusal.
The current bearer is echoed so the caller can rotate deliberately by naming it.

**Text:**

```text
ALREADY    step 2.1 -> child.runbook.md
Token:     rdtk_...

RD_CLAIM_TOKEN=rdtk_...
```

**JSON:**

```json
{
  "kind": "delegate",
  "action": "retry-already-applied",
  "step": "2.1",
  "runbook": "child.runbook.md",
  "token": "rdtk_...",
  "token_hash": "sha256:...",
  "parent_run_id": "rd_..."
}
```

### Delegation replacement consumed

`rundown delegate --retry <token>` where the named bearer was already replaced
and the replacement shows committed evidence of use — claimed by a child,
aborted, or its frame entry advanced. Minting a third bearer over work already
in progress is refused. No envelope carries a full token.

**Text:**

```text
Error: the replacement for this bearer shows committed evidence of use (claimed)
Code: RD-826
```

**JSON:**

```json
{
  "kind": "error",
  "error": "the replacement for this bearer shows committed evidence of use (claimed)",
  "code": "RD-826",
  "command": "delegate"
}
```

### Delegation retry identity unmatched

`rundown delegate --retry <token>` where the named bearer identifies neither the
delegation currently recorded at the target nor one that it superseded.

**Text:**

```text
Error: the named bearer matches neither the current delegation nor one it superseded
Code: RD-827
```

**JSON:**

```json
{
  "kind": "error",
  "error": "the named bearer matches neither the current delegation nor one it superseded",
  "code": "RD-827",
  "command": "delegate"
}
```

### Delegation supersession ambiguous

More than one delegation attempt records the named bearer as superseded, so
there is no single replacement to echo or judge. Unreachable by construction: it
is refused, never resolved.

**Text:**

```text
Error: more than one delegation attempt records this bearer as superseded
Code: RD-828
```

**JSON:**

```json
{
  "kind": "error",
  "error": "more than one delegation attempt records this bearer as superseded",
  "code": "RD-828",
  "command": "delegate"
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
  "kind": "error",
  "error": "Invalid run id. Expected rd_<32 hex characters>.",
  "code": "INVALID_RUN_ID",
  "command": "complete"
}
```

### Collect not authorized for this target

`rundown collect` was issued with a bearer claim that does not control the
target delegating run — collection requires a `collect-for-run` grant for that
run, so a claimant may collect only delegations issued by its own claimed run.
The verified bearer lacks the exact grant, so the command is refused with the
shared `CLAIM_GRANT_REQUIRED` claim-grant refusal. (A `collect` with no bearer
at all on a delegation-exposed run is refused with `ACTOR_CONTEXT_REQUIRED`
instead.)

**Text:**

```text
Error: The supplied claim id is not authorized to run `rundown collect` for this target.
Code: CLAIM_GRANT_REQUIRED
```

**JSON:**

```json
{
  "kind": "error",
  "error": "The supplied claim id is not authorized to run `rundown collect` for this target.",
  "code": "CLAIM_GRANT_REQUIRED",
  "command": "collect"
}
```

### Runbook database and persisted state (`RD-306`…`RD-309`)

Four `STATE`-category errors describe the state store itself rather than any one
command's authority. They are **thrown**, not returned as command outcomes, so
they reach output through the top-level error wrapper rather than through
`OutputEmitter`. That gives them two shapes distinct from every envelope above:

- **Text** is `Error <code>: <message>` on one line — not the `Error: …` /
  `Code: …` pair the symbolic codes render. `--verbose` appends the registered
  description, and nothing else.
- **JSON** carries an extra `details` object holding `category`, `title`, and
  the error's structured `context`. The documented envelope fields (`kind`,
  `error`, `code`, `command`) are unchanged.

The registered `description` reaches an operator **only** under
`--text --verbose`, and never appears in the default JSON envelope, so each of
these codes deliberately spells its diagnosis and its recovery into `error`
itself.

**No documentation URL is emitted, by any code.** Errors carry no `docsUrl`
field and `--verbose` prints no link. The per-code `docSlug` still exists in the
registry as the durable identifier a future `/docs/errors/` route would key on,
but no such route has ever been served, so nothing renders it.

Every one of these four contexts also carries a `message` key holding the same
diagnosis already rendered into `error`. It is **elided from the fences below**
for readability; expect it on the wire.

Two are open-time faults on the database as a whole, two concern one run.

| Code     | Symbolic name                   | Scope    | Nature                    |
| -------- | ------------------------------- | -------- | ------------------------- |
| `RD-306` | `WAL_JOURNAL_MODE_UNAVAILABLE`  | Database | Refusal — establish WAL   |
| `RD-307` | `STATE_STORE_UNAVAILABLE`       | Database | Retry lock; else repair   |
| `RD-308` | `CONCURRENT_STATE_MODIFICATION` | One run  | **Transient — re-run it** |
| `RD-309` | `INVALID_PERSISTED_RUN_STATE`   | One run  | Refusal — finish or prune |

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
  "command": "run",
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
Error RD-307: Runbook database unavailable - Native SQLite (node:sqlite) is unavailable on this multi-process host: attempt to write a readonly database. Rundown does not downgrade to the single-writer sql.js adapter outside WebContainer.
```

**JSON:**

```json
{
  "kind": "error",
  "error": "Runbook database unavailable - Native SQLite (node:sqlite) is unavailable on this multi-process host: attempt to write a readonly database. Rundown does not downgrade to the single-writer sql.js adapter outside WebContainer.",
  "code": "RD-307",
  "command": "status",
  "details": {
    "category": "STATE",
    "title": "Runbook database unavailable",
    "context": { "driverCode": "SQLITE_READONLY" }
  }
}
```

#### `RD-308` — run state lost to a concurrent writer

A run-state read-modify-write spent its optimistic compare-and-swap budget
because another process committed to the same run first. Nothing was written and
the persisted state is intact.

This is the **thrown face** of the same condition the symbolic
`CONCURRENT_MODIFICATION` code renders when a command returns it as an outcome.
The two are not duplicates and must not be merged: the symbolic code is a
command result, while `RD-308` is what escapes the throwing state-manager seam
to the top-level wrapper, which speaks only `RD-NNN`. Before this code that
escape surfaced as `RD-999` "Unknown error" — the one place the condition was
undiagnosable.

Alone among the `3xx` state errors this is **transient, not a refusal**: re-run
the command.

**Text:**

```text
Error RD-308: Runbook state lost to a concurrent writer - Run rd_9e725b142d81dabcefb9e04919568fcd was modified concurrently by another writer.
```

**JSON:**

```json
{
  "kind": "error",
  "error": "Runbook state lost to a concurrent writer - Run rd_9e725b142d81dabcefb9e04919568fcd was modified concurrently by another writer.",
  "code": "RD-308",
  "command": "pass",
  "details": {
    "category": "STATE",
    "title": "Runbook state lost to a concurrent writer",
    "context": { "runId": "rd_9e725b142d81dabcefb9e04919568fcd" }
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

The recovery names `rundown prune --inactive`, not the bare command, and the
mode is load-bearing: an unfiltered `rundown prune` selects completed and
stopped runs out of `RunbookStateManager.list`, which skips every row that fails
validation, so it exits `0` having pruned nothing at all. `--inactive` (or
`--all`) reaches the run through prune's invalid-id path.

Being scoped to one run is also why `context` names it. `runId` is the affected
run, `reason` is a closed set naming which refusal fired (`unparseable_json`,
`invalid_schema_version`, `missing_template_vars`, `missing_prompted`,
`schema_validation_failed`, `legacy_dynamic_step_snapshot`,
`malformed_delegate_frontier`, `unrecognized_recovery_reason`,
`missing_render_context`, `unsupported_snapshot_state_value`,
`snapshot_step_not_in_runbook`, `cursor_step_not_in_runbook`,
`missing_frontmatter_outputs`), and `schemaVersion` — present only for
`invalid_schema_version` — is the version the row claims, reported exactly as
persisted and deliberately not narrowed to a number. That last field appears
**nowhere** in the message prose, so structured context is the only way to read
it.

**Text:**

```text
Error RD-309: Invalid persisted run state - Invalid runbook state for "rd_9e725b142d81dabcefb9e04919568fcd": invalid schemaVersion; expected schema version 2. Rundown never migrates persisted state, so this run cannot be resumed: finish it with "rundown complete", stop it with "rundown stop", or discard it with "rundown prune --inactive", then re-run the runbook from source.
```

**JSON:**

```json
{
  "kind": "error",
  "error": "Invalid persisted run state - Invalid runbook state for \"rd_9e725b142d81dabcefb9e04919568fcd\": invalid schemaVersion; expected schema version 2. Rundown never migrates persisted state, so this run cannot be resumed: finish it with \"rundown complete\", stop it with \"rundown stop\", or discard it with \"rundown prune --inactive\", then re-run the runbook from source.",
  "code": "RD-309",
  "command": "pass",
  "details": {
    "category": "STATE",
    "title": "Invalid persisted run state",
    "context": {
      "runId": "rd_9e725b142d81dabcefb9e04919568fcd",
      "reason": "invalid_schema_version",
      "schemaVersion": 1
    }
  }
}
```

### Transactional refusals under `rundown collect`

`rundown collect` shares the transactional refusal vocabulary documented above.
The codes reach a collect's output at two different positions — the command's
own refusal envelope, and streamed observations from follow-on execution-loop
work — and the two mean different things.

#### Collect's own refusal envelope

The whole collection commits as one fenced aggregate transaction: the drain's
applies, any delegation re-entry frontier consumption, the terminal session
release, and a delegating grandparent's outcome row all land together or not at
all. Because the seam captures the collector's authority and re-checks it at
commit time, collect's own error envelope carries the transactional codes.

| Code                                                                | Cause                                                                                                                                                                            | Origin                                    |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `ACTOR_CONTEXT_REQUIRED`                                            | Bare `rundown collect` on a delegation-exposed run                                                                                                                               | Command policy                            |
| `CLAIM_GRANT_REQUIRED`                                              | Verified bearer without the `collect-for-run` grant on the target delegating run                                                                                                 | Command policy                            |
| `DELEGATION_SUPERSEDED` / `CLAIMED_RUNBOOK_UNAVAILABLE`             | The presented `--claim-id` is no longer authority — refused while resolving the target, before any mutation is attempted                                                         | Target resolution                         |
| `SUBSTEPS_NOT_RESOLVED`                                             | Not every DELEGATE substep in the targeted frame has resolved                                                                                                                    | Collection seam                           |
| `NOT_DELEGATE_STEP` / `STEP_NOT_FOUND` / `COLLECT_OPERATION_FAILED` | The targeted step is not a DELEGATE step, does not exist, or a delegated outcome did not apply to the target cursor                                                              | Collection seam                           |
| `RD-821`                                                            | A persisted delegation re-entry frontier refused to project — the presenting claim is not the issuing claim, or the reconstructed bearer does not hash to the persisted verifier | Delegation frontier                       |
| `STALE_CLAIM`                                                       | The collector's claim was released or replaced between authorization and commit                                                                                                  | Aggregate transaction                     |
| `CONCURRENT_MODIFICATION`                                           | Another writer advanced a captured run's state version first                                                                                                                     | Aggregate transaction                     |
| `EXECUTION_IN_PROGRESS`                                             | Another process holds the execution lease on a captured run                                                                                                                      | Aggregate transaction                     |
| `RECOVERY_REQUIRED` / `AGGREGATE_RECOVERY_REQUIRED`                 | An interrupted execution attempt must be recovered before the collection can commit; the aggregate form names every affected run in `details.runs`                               | Aggregate transaction                     |
| `RUN_TARGET_UNAVAILABLE`                                            | The `--run` id is not a running member of this session's active stack, or a captured run disappeared before the commit                                                           | Target resolution / aggregate transaction |

Two notes on reading this table:

`RUN_TARGET_UNAVAILABLE` has **two distinct origins** that share a code and a
remedy. From target resolution nothing was captured, so there was no transaction
to lose. From the aggregate transaction a captured run vanished mid-flight. An
agent cannot tell them apart from the envelope, and does not need to — the
recovery is the same.

`RD-829` (`frontier_consume_failed`) is **not** reachable from
`rundown collect`. That code reports a frontier that projected but whose consume
did not commit, leaving the frontier persisted and retryable. A collection
derives its consume rather than committing one separately, so the only way it
does not land is that the enclosing transaction refused — reported as the
transactional code above, with the frontier likewise untouched. The code remains
reachable from the execution loop, which still drives the unfenced projection
seam.

An `AGGREGATE_RECOVERY_REQUIRED` from collect names the collect target and, when
the target is itself a delegated child whose grandparent received a terminal
report, that grandparent too.

#### Streamed `error_occurred` observations

A collect whose aggregation advances the delegating run into execution-loop work
streams that work's events through the same emitter, on the same `seq` counter.
The loop's command fence commits under captured authority, so it can lose the
compare-and-swap that collect's own seam never performs. When it does, the
refusal is observed as an `error_occurred` line carrying the same code
vocabulary — `STALE_CLAIM`, `CONCURRENT_MODIFICATION`, `EXECUTION_IN_PROGRESS`,
`RECOVERY_REQUIRED`, or `RUN_TARGET_UNAVAILABLE` — followed by
`runbook_stopped`.

**The collection is already committed when this is observed.** Collect's own
aggregate transaction — the drain's applies, any delegation re-entry frontier
consumption, the terminal session release, and a delegating grandparent's
outcome row — lands in full _before_ any execution-loop work begins; the loop is
post-commit follow-on work driven from the state that commit produced. Only the
**refused follow-on transition** committed nothing, and precisely because that
invocation committed nothing it owns no terminal cleanup either — releasing
there would let a losing claimant tear down the winner's run. The delegating run
is therefore left exactly where the aggregation put it: applied, non-terminal,
and still session-targeted.

**Do not re-run the collect to recover.** The aggregation is durable and is
never applied twice — a repeated bare `rundown collect` on the post-aggregation
cursor is the idempotent `already-aggregated` no-op (`COLLECT_ALREADY_APPLIED`),
and it cannot retry the transition that was refused. Recover the streamed `code`
on its own terms (its row in
[docs/reference/cli.md](../reference/cli.md#common-errors-and-resolutions)
carries the remedy: wait out the owning process, let the automatic inline
recovery finish, or re-resolve a bearer that is no longer authority), then drive
the delegating run forward from where it now stands.

```jsonl
{"type":"error_occurred","message":"Run rd_0123456789abcdef0123456789abcdef claim generation advanced since it was captured.","code":"STALE_CLAIM","timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/parent.runbook.md"},"seq":3}
{"type":"runbook_stopped","message":"Runbook command execution was not committed","position":{"current":"2","total":3},"timestamp":"2026-05-07T00:00:00.000Z","runbookId":"rd_0123456789abcdef0123456789abcdef","runbook":{"source":"project","path":"runbooks/parent.runbook.md"},"seq":4}
```

A `code` on an `error_occurred` line is drawn from the same registered
error-code enum as the top-level `code` field, but the line is an
**observation** of a refusal, not the command's error envelope.
`rundown collect` still writes its `collect` action object as the last JSON
line, and exits non-zero.
