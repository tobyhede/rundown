# ARTIFACTS Directive Design

## Status

Approved direction for implementation planning.

## Problem

Rundown needs a first-class way to tell an agent which files belong to the current step.
That covers two related workflows:

- create a stable artifact reference for a file the step will produce or update
- find existing artifact references for files the step should read, update, or delete

The current helper-based design puts artifact creation inside template rendering. That makes rendering side-effectful, so the same helper can append manifest rows more than once when command text is rendered for display and then rendered again for execution.

`OUTPUTS` should not carry this responsibility. Its job is to communicate variables produced by command execution back into runbook context after the step finishes.

## Design Summary

Add an `ARTIFACTS` directive with parser-owned syntax:

```markdown
## 8. Write the plan
- ARTIFACTS
  - PlanPath "plan.json"
  - Reviews "*-reviews.json"
- PASS CONTINUE
- FAIL STOP

Write the plan to {{ PlanPath }}.
Review prior findings from {{ Reviews }}.
```

`ARTIFACTS` is resolved once when the step or substep is entered, before prompt text, command text, descriptions, and output expressions are rendered for that execution unit.

The directive injects step-local template variables and structured artifact metadata into the execution context. It does not persist variables into `state.variables` by itself. Later steps find artifacts by declaring their own `ARTIFACTS` entries, or by explicitly receiving values through existing context mechanisms.

## Syntax

Each nested declaration is:

```text
Name "key"
```

Rules:

- `Name` must follow the existing variable-name rules and must not be a reserved template name.
- The key must be a quoted literal. Template markers are not expanded inside keys in v1.
- An exact artifact key uses the existing safe artifact key shape: `[A-Za-z0-9._-]+`.
- A wildcard artifact key uses the same safe characters plus `*` and `?`.
- Slashes, absolute paths, traversal, empty keys, `.`, `..`, and recursive `**` are invalid.
- Duplicate names in one `ARTIFACTS` block are syntax errors.
- A step or substep may declare `ARTIFACTS` at most once.
- `ARTIFACTS` follows the same ordering rule as `OUTPUTS`: it must appear before prompt/body content.

## Resolution Semantics

An exact artifact key declares the current run's artifact for that key:

```markdown
- ARTIFACTS
  - PlanPath "plan.json"
```

At step entry this produces the exact URI:

```text
rd://artifacts/<ContextId>/runs/<RunId>/plan.json
```

It also resolves the local path under:

```text
<WorkPath>/.rd-<ContextId>/runs/<RunId>/plan.json
```

The resolver creates the parent directory and appends one manifest row for the current artifact identity. It does not create or truncate the artifact file.

A wildcard artifact key finds existing manifest-backed artifacts:

```markdown
- ARTIFACTS
  - Reviews "*-reviews.json"
```

Wildcard artifact keys:

- search the current context manifest
- coalesce duplicate manifest rows by artifact identity before matching
- return only records whose artifact file currently exists as a regular contained file
- include current-run matches and completed prior-run matches
- do not append manifest rows
- return an empty list when nothing matches

Exact artifact keys inject a string variable. Wildcard artifact keys inject an array of strings. The strings are artifact URIs. Structured context carries manifest-shaped artifact records.

## Runtime Context

The step-local template variable map receives aliases such as:

```json
{
  "PlanPath": "rd://artifacts/ctx1/runs/rd_0123456789abcdef0123456789abcdef/plan.json",
  "Reviews": [
    "rd://artifacts/ctx1/runs/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/a-reviews.json"
  ]
}
```

JSON events and status should also expose structured artifact records using the existing manifest record shape:

```json
{
  "artifacts": {
    "PlanPath": {
      "uri": "rd://artifacts/ctx1/runs/rd_0123456789abcdef0123456789abcdef/plan.json",
      "runId": "rd_0123456789abcdef0123456789abcdef",
      "contextId": "ctx1",
      "runbook": {
        "source": "project",
        "path": "planning/write-plan.runbook.md"
      },
      "key": "plan.json",
      "timestamp": "2026-05-07T00:00:00.000Z"
    },
    "Reviews": [
      {
        "uri": "rd://artifacts/ctx1/runs/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/a-reviews.json",
        "runId": "rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "contextId": "ctx1",
        "runbook": {
          "source": "project",
          "path": "planning/review.runbook.md"
        },
        "key": "a-reviews.json",
        "timestamp": "2026-05-07T00:00:00.000Z"
      }
    ]
  }
}
```

The template alias is reinforcement for prompts and commands. The structured artifact context is the authoritative data for agents and integrations that need artifact identity and provenance.

When a consumer needs a local filesystem path, it should resolve the artifact URI through the artifact path resolver. The local path is a projection from the manifest record, not part of the artifact record itself.

## OUTPUTS Relationship

`ARTIFACTS` and `OUTPUTS` have separate responsibilities:

- `ARTIFACTS` is pre-step working-set declaration. It is available to the same step.
- `OUTPUTS` is post-execution communication from commands back into runbook context.

An artifact alias does not automatically become a later-step variable. If a runbook wants to publish an alias into persistent context, it can still do that deliberately through `OUTPUTS`.

## Helper Cleanup

Artifact-producing template helpers are no longer the primary artifact API.

Implementation should remove manifest writes from ordinary template rendering. Rendering prompt text, command text, descriptions, and status output must be pure with respect to the artifact manifest.

If `{{ artifact "key" }}` or `{{ path "key" }}` is kept temporarily for compatibility, it must not be the mechanism that registers artifacts for a step. The first-class path is:

```markdown
- ARTIFACTS
  - Name "key"
```

The `rdpath` command remains separate. It is a path assembly and discovery CLI, not the step artifact declaration model.

## Components

Parser:

- add `ArtifactDeclaration` to the AST
- parse `- ARTIFACTS` on steps and substeps
- validate directive ordering, duplicate names, reserved names, and artifact key syntax

Core runtime:

- add an artifact declaration resolver
- build exact artifact URIs and local paths from `WorkPath`, `ContextId`, `RunId`, and `RunbookRef`
- append manifest rows only for exact declarations
- find wildcard artifact keys from the context manifest
- return both template variables and structured manifest-shaped artifact records

CLI execution:

- resolve artifacts once at step/substep entry
- overlay artifact aliases into the step-local variable frame before rendering
- include manifest-shaped artifacts in JSON execution events and status output
- reuse the same resolved command text for `STEP_ENTERED.commandCode` and actual execution, or render command text from the same side-effect-free variable frame

Docs:

- document `ARTIFACTS` as the way to declare files for a step
- update stale helper examples that currently use `{{ path "..." }}` or `{{ artifact "..." }}`
- keep `OUTPUTS` documentation focused on command-produced variables

## Error Handling

Parser errors:

- missing nested declarations
- malformed declaration text
- duplicate `ARTIFACTS` directive
- duplicate artifact alias
- invalid alias or reserved alias
- invalid artifact key shape
- directive after prompt/body content

Runtime errors:

- missing or invalid `WorkPath`, `ContextId`, `RunId`, or `RunbookRef`
- artifact path escaping the configured work root
- corrupt context manifest
- alias collision with an existing effective variable at step entry

Non-errors:

- exact declaration where the file does not exist yet
- wildcard declaration with zero matches

## Testing

Parser tests:

- accepts exact and wildcard artifact key declarations
- rejects invalid artifact keys, duplicate aliases, duplicate directives, and late directives

Core tests:

- exact declaration returns a manifest-shaped artifact record and appends one manifest row
- exact declaration does not create the artifact file
- wildcard declaration returns existing file-backed manifest records
- wildcard declaration returns an empty array for no matches
- wildcard declaration does not append manifest rows
- invalid artifact keys and unsafe paths fail before filesystem mutation

CLI execution tests:

- same-step prompt and command rendering can use artifact aliases
- command display and actual execution do not produce duplicate manifest rows
- JSON events/status include manifest-shaped artifact records
- artifact aliases are not persisted to later steps unless explicitly exported

Docs tests:

- examples use `ARTIFACTS` instead of artifact-producing helpers
- `OUTPUTS` examples remain about command execution output

## Scope

The v1 artifact key is limited to manifest artifact keys, not arbitrary filesystem paths or recursive worktree globs. Raw files without manifest records are invisible to `ARTIFACTS` until they are registered as artifacts.
