# Scenarios

Scenarios are a testing and verification feature for Rundown runbooks. They are
**not** part of the public Rundown format specification — they exist to exercise
and document runbook behavior through repeatable CLI command sequences.

Test runbooks in `runbooks/` serve a dual purpose: they are **test data**
providing comprehensive coverage of every Rundown feature and permutation, and
**living documentation** serving as the authoritative reference for how every
feature behaves. A single runbook both exercises a feature through its scenarios
and documents expected behavior through its assertion-style titles and
transition assertions.

This document defines the scenario schema, conventions for authoring test
runbooks, and the assertion model.

## Scenario Schema

Scenarios are defined in the `scenarios` block of runbook frontmatter (YAML):

```yaml
scenarios:
  test_name:
    description: "Description"
    commands: ["rundown run doc.md", "rundown pass"]
    result: COMPLETE
    tags: ["smoke", "deploy"]
```

### BNF Grammar

```bnf
scenarios =
  "scenarios:"
    scenario { scenario }

scenario =
  slug ":"
    [ "description:" text ]
    "commands:"
      "- " text { "- " text }
    [ "result:" ( "COMPLETE" | "STOP" ) ]
    [ "expect:" expect_block ]
    [ "tags:" tag_list ]

expect_block =
  [ "result:" ( "COMPLETE" | "STOP" ) ]
  [ "steps:" step_assertion { step_assertion } ]
  [ "errors:" error_assertion { error_assertion } ]
  [ "artifacts:" artifact_assertion { artifact_assertion } ]
  [ "entered:" entered_assertion { entered_assertion } ]

step_assertion =
  "- " [ "runbook:" text ] [ "at:" text ] [ "from:" text ] [ "action:" text ] [ "result:" ( "PASS" | "FAIL" ) ] [ "command:" text ] [ "aggregated:" boolean ]

error_assertion =
  "- " [ "code:" text ] [ "command:" text ] [ "error:" text ]

artifact_assertion =
  "- " "alias:" text [ "at:" text ] [ "runbook:" text ] [ "kind:" text ] [ "key:" text ] [ "exists:" boolean ] [ "count:" number ]

entered_assertion =
  "- " [ "at:" text ] [ "description:" text ] [ "runbook:" text ]
```

At least one of top-level `result:`, `expect.result`, or `expect.errors` must be
specified. If both result fields are present, they must match.

External scenario suites use the same command and assertion model in standalone
`*.scenario-suite.yaml` files:

```yaml
version: 1
name: Regression Suite
description: Optional suite description
tags: [regression]
cases:
  happy-path:
    description: Optional case description
    file: path/to/example.runbook.md
    commands:
      - rundown run --prompted example.runbook.md
      - rundown pass
    expect:
      result: COMPLETE
      steps:
        - runbook: example.runbook.md
          at: "1"
          action: COMPLETE
```

Suite `version` must be `1`, `name` is required, `cases` must be non-empty, and
each case `file` must end in `.runbook.md`. Each case requires `commands` plus
either top-level `result` or `expect.result`.

## Design Principles

1. **Assertion-style naming** -- Runbook titles and step titles describe the
   expected behavior, not a real-world task. The H1 title states what
   feature/behavior the runbook documents. Step titles describe what should
   happen.

2. **Minimum viable structure** -- Each runbook contains only the steps needed
   to exercise the feature under test. No padding steps. A single-step runbook
   is valid if it fully tests the behavior (e.g., FOR with BREAK needs no step
   2).

3. **One feature focus per runbook** -- Each runbook targets a specific Rundown
   feature or interaction. Cross-cutting behaviors (e.g., "RETRY inside FOR
   loop") get their own runbook rather than being bolted onto a simpler one.

4. **Scenarios define the test matrix** -- The same runbook structure is tested
   under different pass/fail sequences via scenarios. The runbook declares the
   structure; scenarios declare the inputs and expected outcomes.

5. **Every syntactic form gets coverage** -- If the parser accepts multiple ways
   to express something, each form appears in at least one runbook.

6. **Duplication over forced taxonomy** -- If a feature naturally fits in two
   categories, duplicate rather than create an artificial shared location. It is
   better to have duplication than to try and find a one-size-fits-all taxonomy.

## Directory Structure

```text
runbooks/
  transitions/       # PASS/FAIL, CONTINUE/STOP/COMPLETE, defaults, ALL/ANY
  retries/           # RETRY N, exhaustion actions, counter reset
  goto/              # Static, named, substep targets
  for-loops/         # BREAK, CONTINUE, variable expansion, data sources
  substeps/          # Static, named, mixed substep types
  named-steps/       # Named steps, mixed static+named
  prompts/           # Explicit/implicit prompts, YES/NO, prompt code blocks
  composition/       # Runbook lists, substep runbook references
  delegation/        # Delegate, claim, abort, token lifecycle
  stash-pop/         # Stash/pop enforcement control
  variables/         # Template variables, built-ins, and context
  examples/          # Curated real-world runbooks (docs/explore reference)
```

Each directory groups runbooks by the Rundown feature they exercise. Directories
use plural nouns. A runbook lives in the directory of its primary feature;
cross-cutting behaviors get their own runbook in the most relevant directory.

## File Naming Convention

Filenames are descriptive of the feature and behavior, using kebab-case:

```text
<feature>-<behavior>.runbook.md
```

Examples:

```text
for-break-on-fail.runbook.md
retry-exhaustion-goto.runbook.md
goto-named-step.runbook.md
transitions-default-implicit.runbook.md
```

## Runbook Structure Template

```md
---
name: <matching filename without extension>
description: <one-line description of what this runbook tests>
tags: [test, <feature-area>]
scenarios:
  <scenario-name>:
    description: <what this scenario verifies>
    commands:
      - rundown run --prompted <name>.runbook.md
      - rundown pass
    expect:
      result: COMPLETE
---

# <Assertion-style title describing the feature>

<Optional one-line description expanding on the title>

## 1 <Step title describing expected behavior>
- PASS CONTINUE
- FAIL STOP

## 2 <Only if testing inter-step behavior>
```

### Conventions

- `name` matches filename (without `.runbook.md`)
- `tags` always includes `test` plus the feature area directory name
- Scenario names are kebab-case describing the test path
- Step titles can be blank for substeps where context makes the purpose obvious
- Body text is minimal -- only when the test requires specific prompt content or
  command execution

## Scenario Format

### Command Sequences

Scenarios are executable CLI command sequences that drive the runbook through a
specific path. Each scenario is a repeatable demonstration of real CLI
interaction.

Scenario `commands:` must list the actual `rd` or `rundown` commands being
tested. Express the workflow directly and visibly:

```yaml
scenarios:
  break-on-first:
    description: BREAK exits loop on first FAIL
    commands:
      - rundown run --prompted for-break-on-fail.runbook.md
      - rundown fail
    expect:
      result: STOP
```

Do not hide workflow steps inside opaque shell wrappers such as `node -e`,
`bash -c`, npm scripts, helper scripts, or shell pipelines that call `rd`
internally. The scenario runner derives terminal state, step transitions,
delegation tokens, and claim ids only from visible `rd`/`rundown` command
entries. Hidden `rd` invocations obscure that state and make scenario assertions
depend on shell behavior instead of the scenario runner's command model.

Detailed payload assertions, ad hoc JSON checks, and state-file inspections
belong in dedicated Jest integration or unit tests. Frontmatter scenarios should
assert through the scenario schema (`expect.result`, `expect.steps`,
`expect.errors`, `expect.artifacts`) and keep `commands:` focused on the CLI
interaction sequence.

**These rules are enforced**, not advisory, by
`packages/cli/__tests__/schemas/scenario-authoring.test.ts`. It rejects a
scenario command whose executable is an interpreter (`node`, `python3`, `sh`,
…), a helper script (`./setup.sh`), or a package runner (`npm`, `npx`, …) — in
any form, not only the inline `-e` / `-c` spellings — and any command whose
inline code spawns a subprocess. Detection is anchored to the executable
position of each operator-separated segment, so a wrapper hidden behind `&&` is
caught while an incidental mention of `bash` inside a quoted argument is not.

Those wrappers are confined to a small allowlist for **fault injection only** —
where the shell command _is_ the fault being injected or the untrusted input
being forged, never a workflow step and never an assertion. The allowlist is
matched by set equality, so a stale entry fails the suite as loudly as an
unlisted violation. The predicates themselves are unit-tested in
`packages/cli/__tests__/schemas/scenario-authoring-rules.test.ts`.

Commands output JSON by default. The scenario runner parses every `rd`/`rundown`
command's stdout to collect terminal state, step transitions, entered-step
events, delegation tokens, and claim ids. Use `--text` for human-readable
terminal output in demo scenarios; `--text` output is not useful for
`expect.steps`, `expect.entered`, token capture, or claim-id capture.

The runner executes plain `rd` and `rundown` commands directly through the
current CLI entry point instead of through a shell. Leading command-scoped
environment assignments are supported:

```yaml
commands:
  - rundown claim ${TOKEN}
  - rundown pass --claim-id ${CLAIM_ID}
```

Claim ids captured from `rundown claim` expand as `${CLAIM_ID}` for the first
claim and `${CLAIM_ID_2}` for the second claim. Use claim-id placeholders when a
scenario claims multiple delegated siblings.

Shell operators in an `rd`/`rundown` command are rejected (`&&`, `||`, `|`,
etc.). Split those into separate `commands` entries. Non-`rd` commands run
through the user's shell and are only appropriate for fixture setup, fault
injection, or other support work that cannot be expressed as Rundown CLI
interaction. They must not call `rd` or `rundown` internally or assert detailed
CLI payloads.

Prefix a command with `!` followed by a literal space when a non-zero exit is
the expected outcome:

```yaml
commands:
  - rundown run --prompted validation.runbook.md
  - "! rundown claim rdtk_invalid"
```

For `!` commands, exit code `0` is an error. The `!` token must be followed by a
space. For normal commands, a non-zero exit is an error unless the command
output still produced a parsed terminal runbook result.

### Naming Convention

Scenario names describe the execution path:

| Pattern       | Example names                      |
| ------------- | ---------------------------------- |
| Happy path    | `all-pass`, `completed`            |
| Failure point | `fail-at-step-1`, `break-on-first` |
| Recovery      | `retry-then-pass`, `via-goto`      |
| Exhaustion    | `exhaustion`, `all-retries-fail`   |
| Auto mode     | `auto-execution`                   |

### Command Vocabulary

- `rundown run --prompted <name>` -- Start in prompted mode (manual pass/fail)
- `rundown run <name>` -- Start in auto-execution mode (commands determine
  outcome)
- `rundown pass` -- Mark current step passed
- `rundown fail` -- Mark current step failed
- `rundown goto N` -- Jump to specific step
- `rundown stop` / `rundown complete` -- Force terminal state
- `rundown delegate <runbook> --step <id>` -- Delegate substep to child
- `rundown claim ${TOKEN}` -- Claim delegation token (see Token Capture below)
- `rundown abort ${TOKEN}` -- Cancel delegation token

The command vocabulary is the source of truth for the runbook workflow under
test. If a scenario needs `rundown run`, `rundown pass`, `rundown fail`,
`rundown goto`, `rundown delegate`, `rundown claim`, or `rundown abort`, write
that command as its own `commands:` entry.

### Runbook Staging

Scenario execution copies the runbook under test into an isolated
`.rundown/runbooks/` workspace. It also stages child runbooks referenced by
scenario commands and by authored substep runbook references in the runbook
source. Authored references are discovered by parsing the source runbook,
including explicit H3 substeps and runbook-list shorthand entries; each staged
child is parsed again so authored child references are copied recursively.

Only static relative `.runbook.md` references are staged this way. Absolute
paths, parent traversal, namespaced refs, and template refs are not copied as
authored child files. Staged child runbooks keep their relative layout under the
scenario workspace, and static artifact files referenced by each staged runbook
are copied alongside the runbook graph.

### Token Capture

The scenario runner extracts delegation tokens from parsed JSON output. Tokens
are captured in order from:

- `rundown delegate` JSON responses with `action: "delegated"` and a string
  `token`
- `step_entered` events whose `delegateFrontier` array contains string `token`
  values

Captured tokens are available for substitution in subsequent commands:

- First token captured: `${TOKEN}`
- Second token: `${TOKEN_2}`
- Third token: `${TOKEN_3}`
- And so on

This enables delegation scenarios without shell variable capture:

```yaml
commands:
  - rundown run delegate-basic.runbook.md
  - rundown delegate child-task.runbook.md --step 1.1
  - rundown claim ${TOKEN}
```

The runner substitutes `${TOKEN}` with the actual captured token value. For
multi-delegation scenarios:

```yaml
commands:
  - rundown run delegate-hierarchy.runbook.md
  - rundown delegate child-a.runbook.md --step 1.1
  - rundown claim ${TOKEN}       # claims child-a token
  - rundown delegate child-b.runbook.md --step 1.2
  - rundown claim ${TOKEN_2}     # claims child-b token
```

For `DELEGATE`-annotated steps, `rundown run` can auto-issue frontier tokens as
soon as the delegate step is entered. In that case, a later
`rundown claim ${TOKEN}` can use the token captured from the
`step_entered.delegateFrontier` event without an explicit `rundown delegate`
command.

### Auto-Execution Scenarios

When a runbook has bash commands (typically `rundown echo`), auto-execution
scenarios use a single command:

```yaml
auto-execution:
  description: Code block determines pass/fail automatically
  commands:
    - rundown run for-break-on-fail.runbook.md
  expect:
    result: STOP
```

## Assertion Model

### Vocabulary

Assertion field names align with both the `StepTransitionedPayload` event fields
and the CLI transition output (`Action:`, `From:`, `Result:`, `At:`). The event
payload, JSON output, CLI text output, and scenario assertions all use the same
field names -- no mapping layer required.

| Field        | Meaning                                               | Values                                                                    |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `at`         | Step position after transition                        | Qualified ID: `1`, `1.1`, `1.3.1`, `ErrorHandler`                         |
| `from`       | Step position before transition                       | Same as `at`                                                              |
| `action`     | Transition type                                       | `CONTINUE`, `DEFER`, `GOTO`, `STOP`, `COMPLETE`, `RETRY`, `BREAK`, `NEXT` |
| `result`     | Step outcome that triggered transition                | `PASS`, `FAIL`                                                            |
| `command`    | Command associated with the transition                | Exact command string                                                      |
| `aggregated` | Whether the transition came from deferred aggregation | `true`, `false`                                                           |
| `runbook`    | Runbook that emitted the transition                   | Suffix match against event `runbook.path`, falling back to `runbook.name` |

### Entered Assertions

`expect.entered` asserts against captured `step_entered` events rather than
transition events. The runner evaluates these assertions into
`enteredAssertions` in JSON output and an "Entered Assertions" block in text
output.

Use entered assertions for behavior where entry itself is the contract,
especially inline runbook-list composition. A non-DELEGATE runbook-list substep
emits a parent `step_entered` event with an `at` position such as `2.1` and a
generated description such as `Runbook: child.runbook.md`; it may then launch
the child inline without emitting a parent transition at that moment.

Supported fields:

| Field         | Meaning                              | Values                                                               |
| ------------- | ------------------------------------ | -------------------------------------------------------------------- |
| `at`          | Entered step position                | Qualified ID from the event position, such as `1`, `2.1`, or `1.3.1` |
| `description` | Entered step description             | Exact event description                                              |
| `runbook`     | Runbook that emitted the entry event | Suffix match against event `runbook.path`                            |

### Action Semantics: NEXT vs CONTINUE

The `NEXT` and `CONTINUE` actions are distinct in FOR loop context:

| Action     | Meaning                              | When emitted                                            |
| ---------- | ------------------------------------ | ------------------------------------------------------- |
| `CONTINUE` | Advance to next substep or next step | Substep-to-substep, step-to-step progression            |
| `NEXT`     | Advance to next FOR iteration        | Substep completes within a FOR loop, iteration advances |
| `BREAK`    | Exit FOR loop immediately            | Substep triggers loop exit                              |

In the Rundown syntax, `PASS CONTINUE` on a substep inside a FOR loop means
"continue to next iteration" -- but the _emitted action_ is `NEXT`, not
`CONTINUE`. The compiler translates the syntactic `CONTINUE` to the semantic
`NEXT` within FOR loop scope. Test assertions must use the emitted action name.

Example transition stream for a 3-iteration FOR loop where all pass:

```js
{ at: 1.1.1, action: NEXT, result: PASS }    # iteration 1 -> 2
{ at: 1.2.1, action: NEXT, result: PASS }    # iteration 2 -> 3
{ at: 1.3.1, action: COMPLETE, result: PASS } # iteration 3 -> parent resolves
```

### Qualified Step Identifiers

The iteration-aware identifier syntax encodes all positional context in a single
string:

| Identifier       | Meaning                        |
| ---------------- | ------------------------------ |
| `1`              | Step 1                         |
| `1.1`            | Step 1, substep 1              |
| `1.3.1`          | Step 1, iteration 3, substep 1 |
| `ErrorHandler`   | Named step                     |
| `ErrorHandler.1` | Named step, substep 1          |

Numeric-looking values (e.g., `1.1`) should be quoted to prevent YAML 1.2 from
parsing them as floats. Without quotes, trailing zeros are lost (`1.10` becomes
`1.1`). Authors should write `at: "1.1"` and quote any numeric-looking
identifiers (`from`, `to`, etc.).

> **YAML quoting:** Step positions like `1.10` (step 1, substep 10) must be
> quoted as `"1.10"` in YAML. Without quotes, YAML parses `1.10` as the float
> `1.1`, which would fail to match the actual step position. This applies to any
> `at`/`from` value where trailing zeros are significant.

### Schema Structure

```yaml
expect:
  result: COMPLETE              # Terminal outcome (optional if top-level result: present)

  steps:                        # Transition assertions (optional, ordered)
    - runbook: child.runbook.md  # Optional runbook filter for delegated/nested runs
      at: "1.1"
      from: "1"
      action: CONTINUE
      result: PASS
    - at: "3"                   # Last entry serves as terminal assertion
      action: COMPLETE
      result: PASS

  entered:                      # Step-entry assertions (optional, ordered)
    - runbook: parent.runbook.md
      at: "1.1"
      description: "Runbook: child.runbook.md"
```

All fields within `steps` entries are optional. Assert only what matters for the
test.

There is no separate `final` block. The last `steps` entry serves as the
terminal assertion when needed. The `result` field at the top level
(`COMPLETE`/`STOP`) captures the terminal outcome from
`RUNBOOK_COMPLETED`/`RUNBOOK_STOPPED` events.

Terminal results are parsed from JSON event streams (`type: "runbook_completed"`
or `type: "runbook_stopped"`) and from flushed JSON command responses with
`complete: true` or `stopped: true`. Step assertions are matched only against
streamed `step_transitioned` events, not flushed summary objects.

Error assertions match JSON error responses emitted by expected-failure commands
(`! rundown ...`). `code` and `command` match exactly; `error` matches as a
substring of the human-readable error message.

Artifact assertions match `STEP_ENTERED.artifacts` working sets emitted by JSON
command output. `alias` is required and names the ARTIFACTS variable. `at`,
`runbook`, `key`, and `count` filter captured artifact records. `exists` checks
whether the resolved artifact URI maps to an existing regular artifact file
after the scenario command sequence has run.

Entered assertions match `STEP_ENTERED` events emitted by JSON command output.
Supported fields are `at`, `description`, and `runbook`; `runbook` is a suffix
match against the event's canonical `runbook.path`. The runner reports results
as `enteredAssertions` in JSON output and under "Entered Assertions" in text
output. Use `expect.entered` for entry-only behavior that may not produce a
transition, such as generated runbook-list substeps entering with description
`Runbook: child.runbook.md`.

### Matching Semantics

`steps` entries are matched **in order** against the `STEP_TRANSITIONED` event
stream from command output. Each entry matches the next event that satisfies all
specified fields. Non-matching events are skipped.

`artifacts` entries use the same ordered skip-matching model against captured
`STEP_ENTERED.artifacts` events.

`entered` entries use the same ordered skip-matching model against captured
`STEP_ENTERED` events.

This means you do not have to assert on every transition -- just the ones
relevant to the test:

```yaml
# Skips iterations 1 and 2, matches the BREAK on iteration 3
steps:
  - at: "1.3.1"
    action: BREAK
```

### Examples

**FOR with BREAK -- verify which iteration broke:**

```yaml
expect:
  result: STOP
  steps:
    - at: "1.3.1"
      result: FAIL
      action: BREAK
    - at: "1"
      action: STOP
```

**RETRY then succeed:**

```yaml
expect:
  result: COMPLETE
  steps:
    - at: "1"
      result: FAIL
      action: RETRY
    - at: "1"
      result: PASS
      action: COMPLETE
```

**GOTO to named step:**

```yaml
expect:
  result: COMPLETE
  steps:
    - at: ErrorHandler
      from: "1"
      action: GOTO
      result: FAIL
    - at: ErrorHandler
      result: PASS
      action: COMPLETE
```

**Minimal -- just verify a GOTO happened:**

```yaml
expect:
  result: COMPLETE
  steps:
    - action: GOTO
      at: ErrorHandler
```

**Delegated child transition:**

```yaml
expect:
  result: COMPLETE
  steps:
    - runbook: child.runbook.md
      from: "1"
      action: COMPLETE
      result: PASS
    - runbook: parent.runbook.md
      action: COMPLETE
```

## Artifact Capture

A scenario command receives an artifact `rd://` URI by **capturing it from a
prior command's output**. This is the only mechanism -- there is no seed
directive, and scenarios must never fabricate an `rd://` URI or hand-write a
manifest row. Core owns URI construction (`buildArtifactUri`) and the manifest
row shape; a scenario that duplicates either will drift silently when core
changes.

This constrains how a scenario obtains a URI it intends to _use_. It does not
constrain a negative test that forges an artifact record as a **public input**
in order to assert the input channel rejects it -- there, the forgery is the
assertion rather than a seeding shortcut, so it is the point of the scenario and
not a shortcut around capture. `forged-file-record-rejected`
(`runbooks/artifacts/artifact-variable-review-plan.runbook.md`) is the canonical
example: it writes a `file-artifact-record` bearing an out-of-project `file://`
URI, feeds it through `--input-file`, and expects
`Artifact record input for "Plan" is not trusted`. Leave it alone.

| Placeholder                       | Resolves to                                          |
| --------------------------------- | ---------------------------------------------------- |
| `${CAPTURE_ARTIFACT:<key>}`       | The most recent `rd://artifacts/...` URI for `<key>` |
| `${CAPTURE_ARTIFACT_ARRAY:<key>}` | A JSON array of every matching URI for `<key>`       |

**The array form must be single-quoted.** It resolves to JSON containing double
quotes, and placeholders are substituted into command text that is then
tokenized by the shell. Unquoted, the shell strips those quotes and
`["rd://a","rd://b"]` arrives as the invalid `[rd://a,rd://b]`. Quote the whole
assignment:

```yaml
- rd run collate.runbook.md --artifacts-json 'Reviews=${CAPTURE_ARTIFACT_ARRAY:review.json}' --allow-all
```

This is enforced, not advisory -- an unquoted array placeholder is rejected
before the command runs. The scalar form needs no quoting: its values cannot
contain a shell metacharacter.

Both are resolved from the artifact manifest immediately before each command
runs, so they see rows that earlier commands in the same scenario actually
produced. Recency is by manifest row `timestamp`, with within-context append
order breaking ties; a scalar pick whose latest-timestamp rows span more than
one context is ambiguous and raises an error rather than guessing.

An earlier `${ARTIFACT:<name>}` grammar and its `seed:` directive were retired
in [#498](https://github.com/tobyhede/rundown/issues/498). Both are now rejected
outright -- `seed:` fails scenario validation as an unknown key, and
`${ARTIFACT:...}` in a command throws before execution -- rather than being
ignored.

### `rd://` in a directive is not `rd://` in a command

The same text means opposite things depending on where it lives, so do not
review this with a text search. `grep -rn 'rd://artifacts/' runbooks/` cannot
tell these apart, and will always report the selector fixtures as false hits:

| Where                                            | Verdict                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| An `ARTIFACTS` directive in the runbook **body** | The **selector language**. Legitimate: it names a _set_, resolved against whatever a real producer wrote. |
| A scenario **command** in frontmatter            | **Fabrication.** Capture it from a producer instead.                                                      |

```md
- Matched "rd://artifacts/{{ ContextId }}/*/plan.json?source=project"  # body: fine
```

```yaml
- rd run x.runbook.md --artifacts Plan=rd://artifacts/ctx/rd_1/plan.json # command: fabrication
```

`packages/cli/__tests__/schemas/scenario-authoring.test.ts` enforces the
distinction correctly because it lints **parsed frontmatter values**, not file
text: selector syntax lives on directive lines in the body, which the lint never
reads, so it cannot false-positive. It rejects any scenario command that names
an `rd://` URI, writes `manifest.jsonl`, or hand-derives the `.rd-<contextId>`
directory. There is no allowlist for these -- a real producer's output is the
only legitimate source of artifact provenance.

### Seeding a pre-existing artifact

When a scenario needs an artifact to "already exist", run a real producer
runbook as its first command and capture the artifact it emits:

```yaml
scenarios:
  consume-plan-artifact:
    commands:
      - rd run scenario-seed-artifacts.runbook.md --allow-all
      - "rd run execute-plan.runbook.md --artifacts PlanPath=${CAPTURE_ARTIFACT:PlanPath}"
    expect:
      result: COMPLETE
```

`runbooks/artifacts/scenario-seed-artifacts.runbook.md` is the shared
deterministic seeder; it emits keys `PlanPath` and `plan.json` through the real
`ARTIFACTS` production path. Any producer runbook works -- the seeder is a
convenience, not a special case. The producer needs `--allow-all` because it
writes its backing files from a bash block.

The producer runbook is staged automatically: the harness scans command strings
for `*.runbook.md` references and copies them into the scenario workspace.

### Asserting on a captured artifact

A naked `ARTIFACTS` alias fed an exact `rd://` URI surfaces the **injected
record's key**, while the record's **provenance stays the producer's**. Two
consequences for `expect.artifacts` entries:

- `key:` matches the consumer's alias mapping, as authored in the consuming
  runbook.
- `runbook:` filters the **emitting event's** runbook -- _not_ the record's
  provenance. Adding `runbook: <consumer>` to an assertion over an injected
  record does not scope it "to the consumer's row"; the row's provenance is the
  producer's either way. Disambiguate consumer from producer by `alias:`
  instead, and give the seeder's aliases distinct names from the consumer's.

## Dependency Copying and Path Safety

Scenarios and suite cases run in isolated temporary workspaces.

For runbook-frontmatter scenarios, the runner copies the scenario's source
runbook into the temp workspace's `.rundown/runbooks/` directory. It scans
commands for `*.runbook.md` references and also parses authored runbook
references in staged runbooks, including explicit substep references and
runbook-list shorthand. Authored references are staged recursively from the
referring runbook's directory. Missing referenced runbooks fail before command
execution.

For `--input-file` arguments in frontmatter scenarios, both `--input-file`
followed by `path.yaml` and `--input-file=path.yaml` are detected, including
inside `!` expected-failure commands and env-prefixed `rd` commands. The `!`
token must be followed by a space. The runner copies the entire containing
input-file directory because YAML input files may refer to sibling `file:` data
sources. Absolute input-file paths and `..` traversal are rejected, and source
and destination paths are resolved to ensure they stay inside the source
directory and temp workspace.

For scenario suites, each case's `file` path is resolved relative to the suite
file. The runner rejects absolute paths and `..` traversal, preserves the case
file's subdirectory structure under `.rundown/runbooks/`, and also copies the
main runbook flat by basename so bare-filename commands resolve. Referenced
child runbooks are copied from the main runbook's directory first, then the
suite directory, with path traversal rejected. Authored runbook references are
staged recursively using the same rules.
