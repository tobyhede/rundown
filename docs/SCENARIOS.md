# Scenarios

Scenarios are a testing and verification feature for Rundown runbooks. They are **not** part of the public Rundown format specification — they exist to exercise and document runbook behavior through repeatable CLI command sequences.

Test runbooks in `runbooks/` serve a dual purpose: they are **test data** providing comprehensive coverage of every Rundown feature and permutation, and **living documentation** serving as the authoritative reference for how every feature behaves. A single runbook both exercises a feature through its scenarios and documents expected behavior through its assertion-style titles and transition assertions.

This document defines the scenario schema, conventions for authoring test runbooks, and the assertion model.

## Scenario Schema

Scenarios are defined in the `scenarios` block of runbook frontmatter (YAML):

```yaml
scenarios:
  test_name:
    description: "Description"
    commands: ["rd run doc.md", "rd pass"]
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
  "result:" ( "COMPLETE" | "STOP" )
  [ "steps:" step_assertion { step_assertion } ]

step_assertion =
  "- " [ "at:" text ] [ "from:" text ] [ "action:" text ] [ "result:" ( "PASS" | "FAIL" ) ] [ "command:" text ] [ "aggregated:" boolean ]
```

At least one of top-level `result:` or `expect.result` must be specified. If both are present, they must match.

## Design Principles

1. **Assertion-style naming** -- Runbook titles and step titles describe the expected behavior, not a real-world task. The H1 title states what feature/behavior the runbook documents. Step titles describe what should happen.

2. **Minimum viable structure** -- Each runbook contains only the steps needed to exercise the feature under test. No padding steps. A single-step runbook is valid if it fully tests the behavior (e.g., FOR with BREAK needs no step 2).

3. **One feature focus per runbook** -- Each runbook targets a specific Rundown feature or interaction. Cross-cutting behaviors (e.g., "RETRY inside FOR loop") get their own runbook rather than being bolted onto a simpler one.

4. **Scenarios define the test matrix** -- The same runbook structure is tested under different pass/fail sequences via scenarios. The runbook declares the structure; scenarios declare the inputs and expected outcomes.

5. **Every syntactic form gets coverage** -- If the parser accepts multiple ways to express something, each form appears in at least one runbook.

6. **Duplication over forced taxonomy** -- If a feature naturally fits in two categories, duplicate rather than create an artificial shared location. It is better to have duplication than to try and find a one-size-fits-all taxonomy.

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

Each directory groups runbooks by the Rundown feature they exercise. Directories use plural nouns. A runbook lives in the directory of its primary feature; cross-cutting behaviors get their own runbook in the most relevant directory.

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
      - rd run --prompted <name>.runbook.md
      - rd pass
    expect:
      result: COMPLETE
---

# <Assertion-style title describing the feature>

<Optional one-line description expanding on the title>

## 1 <Step title describing expected behavior>
- PASS: CONTINUE
- FAIL: STOP

## 2 <Only if testing inter-step behavior>
```

### Conventions

- `name` matches filename (without `.runbook.md`)
- `tags` always includes `test` plus the feature area directory name
- Scenario names are kebab-case describing the test path
- Step titles can be blank for substeps where context makes the purpose obvious
- Body text is minimal -- only when the test requires specific prompt content or command execution

## Scenario Format

### Command Sequences

Scenarios are executable CLI command sequences that drive the runbook through a specific path. Each scenario is a repeatable demonstration of real CLI interaction.

```yaml
scenarios:
  break-on-first:
    description: BREAK exits loop on first FAIL
    commands:
      - rd run --prompted for-break-on-fail.runbook.md
      - rd fail
    expect:
      result: STOP
```

Commands are written **without `--json`**. The scenario runner injects `--json` automatically when `expect.steps` is present or when running `rd delegate` (for token capture). This keeps commands clean and human-readable -- the same commands work for site demos (plain text) and test assertions (JSON events).

### Naming Convention

Scenario names describe the execution path:

| Pattern | Example names |
|---------|--------------|
| Happy path | `all-pass`, `completed` |
| Failure point | `fail-at-step-1`, `break-on-first` |
| Recovery | `retry-then-pass`, `via-goto` |
| Exhaustion | `exhaustion`, `all-retries-fail` |
| Auto mode | `auto-execution` |

### Command Vocabulary

- `rd run --prompted <name>` -- Start in prompted mode (manual pass/fail)
- `rd run <name>` -- Start in auto-execution mode (commands determine outcome)
- `rd pass` -- Mark current step passed
- `rd fail` -- Mark current step failed
- `rd goto N` -- Jump to specific step
- `rd stop` / `rd complete` -- Force terminal state
- `rd delegate <runbook> --step <id>` -- Delegate substep to child
- `rd claim ${TOKEN}` -- Claim delegation token (see Token Capture below)
- `rd abort ${TOKEN}` -- Cancel delegation token

### Token Capture

The scenario runner extracts delegation tokens from parsed JSON output. When `rd delegate` runs with `--json` (injected automatically), the response includes a `token` field. These tokens are captured in order and available for substitution in subsequent commands:

- First token captured: `${TOKEN}`
- Second token: `${TOKEN_2}`
- Third token: `${TOKEN_3}`
- And so on

This enables delegation scenarios without shell variable capture:

```yaml
commands:
  - rd run delegate-basic.runbook.md
  - rd delegate child-task.runbook.md --step 1.1
  - rd claim ${TOKEN}
```

The runner substitutes `${TOKEN}` with the actual token value extracted from the delegate command's JSON `token` field. For multi-delegation scenarios:

```yaml
commands:
  - rd run delegate-hierarchy.runbook.md
  - rd delegate child-a.runbook.md --step 1.1
  - rd claim ${TOKEN}       # claims child-a token
  - rd delegate child-b.runbook.md --step 1.2
  - rd claim ${TOKEN_2}     # claims child-b token
```

### Auto-Execution Scenarios

When a runbook has bash commands (typically `rd echo`), auto-execution scenarios use a single command:

```yaml
auto-execution:
  description: Code block determines pass/fail automatically
  commands:
    - rd run for-break-on-fail.runbook.md
  expect:
    result: STOP
```

## Assertion Model

### Vocabulary

Assertion field names align with both the `StepTransitionedPayload` event fields and the CLI transition output (`Action:`, `From:`, `Result:`, `At:`). The event payload, JSON output, CLI text output, and scenario assertions all use the same field names -- no mapping layer required.

| Field | Meaning | Values |
|-------|---------|--------|
| `at` | Step position after transition | Qualified ID: `1`, `1.1`, `1.3.1`, `ErrorHandler` |
| `from` | Step position before transition | Same as `at` |
| `action` | Transition type | `CONTINUE`, `GOTO`, `STOP`, `COMPLETE`, `RETRY`, `BREAK`, `NEXT` |
| `result` | Step outcome that triggered transition | `PASS`, `FAIL` |

### Action Semantics: NEXT vs CONTINUE

The `NEXT` and `CONTINUE` actions are distinct in FOR loop context:

| Action | Meaning | When emitted |
|--------|---------|-------------|
| `CONTINUE` | Advance to next substep or next step | Substep-to-substep, step-to-step progression |
| `NEXT` | Advance to next FOR iteration | Substep completes within a FOR loop, iteration advances |
| `BREAK` | Exit FOR loop immediately | Substep triggers loop exit |

In the Rundown syntax, `PASS: CONTINUE` on a substep inside a FOR loop means "continue to next iteration" -- but the *emitted action* is `NEXT`, not `CONTINUE`. The compiler translates the syntactic `CONTINUE` to the semantic `NEXT` within FOR loop scope. Test assertions must use the emitted action name.

Example transition stream for a 3-iteration FOR loop where all pass:

```js
{ at: 1.1.1, action: NEXT, result: PASS }    # iteration 1 -> 2
{ at: 1.2.1, action: NEXT, result: PASS }    # iteration 2 -> 3
{ at: 1.3.1, action: COMPLETE, result: PASS } # iteration 3 -> parent resolves
```

### Qualified Step Identifiers

The iteration-aware identifier syntax encodes all positional context in a single string:

| Identifier | Meaning |
|------------|---------|
| `1` | Step 1 |
| `1.1` | Step 1, substep 1 |
| `1.3.1` | Step 1, iteration 3, substep 1 |
| `ErrorHandler` | Named step |
| `ErrorHandler.1` | Named step, substep 1 |

Numeric-looking values (e.g., `1.1`) should be quoted to prevent YAML 1.2 from parsing them as floats. Without quotes, trailing zeros are lost (`1.10` becomes `1.1`). Authors should write `at: "1.1"` and quote any numeric-looking identifiers (`from`, `to`, etc.).

> **YAML quoting:** Step positions like `1.10` (step 1, substep 10) must be
> quoted as `"1.10"` in YAML. Without quotes, YAML parses `1.10` as the
> float `1.1`, which would fail to match the actual step position. This
> applies to any `at`/`from` value where trailing zeros are significant.

### Schema Structure

```yaml
expect:
  result: COMPLETE              # Terminal outcome (required)

  steps:                        # Transition assertions (optional, ordered)
    - at: "1.1"
      from: "1"
      action: CONTINUE
      result: PASS
    - at: "3"                   # Last entry serves as terminal assertion
      action: COMPLETE
      result: PASS
```

All fields within `steps` entries are optional. Assert only what matters for the test.

There is no separate `final` block. The last `steps` entry serves as the terminal assertion when needed. The `result` field at the top level (`COMPLETE`/`STOP`) captures the terminal outcome from `RUNBOOK_COMPLETED`/`RUNBOOK_STOPPED` events.

### Matching Semantics

`steps` entries are matched **in order** against the `STEP_TRANSITIONED` event stream captured from `--json` output. Each entry matches the next event that satisfies all specified fields. Non-matching events are skipped.

This means you do not have to assert on every transition -- just the ones relevant to the test:

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
