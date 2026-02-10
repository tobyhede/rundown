---
version: 1.0.0
---

# Rundown Runbook Specification

Rundown is a format for defining executable runbooks using Markdown.

---

## Quick Reference for AI Agents

Rundown = executable Markdown runbooks. Steps are H2 headers with identifiers, optional transitions, and content (prompt/code/substeps/runbooks).

### Document Hierarchy

| Level | Purpose | Example |
|-------|---------|---------|
| H1 | Title (optional) | `# Deploy Service` |
| H2 | Step | `## 1 Build` |
| H3 | Substep | `### 1 Compile` |

### Step Identifiers

| Format | Type | Usage |
|--------|------|-------|
| `1`, `2` | Static | Sequential steps |
| `1`, `1.1` | Substep | Nested sequence (parent prefix optional) |
| `Name` | Named | GOTO target only (skipped by CONTINUE) |

Any step can include a `- FOR var IN 1 TO N` annotation to loop its substeps over a range. See [FOR Steps](#for-steps).

### Transitions

```text
- PASS [ALL|ANY]: action
- FAIL [ALL|ANY]: action
```

Aliases: YES=PASS, NO=FAIL.

### Default Behaviors (Pessimistic)

| Condition | Default |
|-----------|---------|
| PASS without modifier | PASS ALL |
| FAIL without modifier | FAIL ANY |
| PASS omitted | PASS ALL: CONTINUE |
| FAIL omitted | FAIL ANY: STOP |

### Actions

| Action | Effect |
|--------|--------|
| `CONTINUE` | Next step in sequence |
| `COMPLETE [msg]` | Success termination |
| `STOP [msg]` | Halt execution |
| `GOTO N` | Jump to step N |
| `GOTO N AT I` | Jump to step N at iteration I (only if N is a FOR step) |
| `NEXT` | Skip to next iteration (inside FOR) |
| `BREAK` | Exit loop (inside FOR) |
| `RETRY [n] [action]` | Retry n times, then action |

### Code Blocks

| Tag | Behavior |
|-----|----------|
| `bash`, `sh`, `shell` | Execute; exit 0=PASS, else FAIL |
| `bash prompt`, `prompt` | Display only, never execute |
| other (`json`, etc.) | Display only |

One code block per step maximum.

### Template Variables

- `{{variable}}` - Expanded at run time via `--var name=value`
- `{{Step}}` - Current step identifier (built-in)
- `{{Index}}` - Current loop iteration number (built-in, inside FOR)

Undefined variables preserved as literal text.

### Step Content Order

When present, content MUST appear in order:
1. FOR annotation (if applicable)
2. Transitions (bullet list)
3. Prompt (text)
4. Body (code block OR substeps OR runbooks)

### Authoring Conventions

**Transitions: Always explicit.** Write both PASS and FAIL transitions on every step, even when they match the defaults. Transitions define control flow — the most important aspect of a runbook. Omitting them saves two lines but forces the reader to recall default behavior.

```markdown
## 1 Build
- PASS: CONTINUE
- FAIL: STOP
```

**Messages: Only when they add information.** STOP and COMPLETE accept optional messages. Include a message only when it provides context the step title does not — typically actionable guidance on what went wrong or what to check. Omit when the step title makes the outcome self-evident.

```markdown
## 1 Compile
- PASS: CONTINUE
- FAIL: STOP
```

Not:
```markdown
## 1 Compile
- FAIL: STOP "Compilation failed."
```

Good use of a message — adds actionable context:
```markdown
## 1 Authenticate
- FAIL: STOP "Check that gh is authenticated: run gh auth status"
```

Better use of a message (no message) - include actionable context in the step itself:
```markdown
## 1 Github Authentication
- FAIL: STOP
```

---

## Table of Contents

- [Syntax Synopsis](#syntax-synopsis)
- [Document Structure](#document-structure)
- [Step Definitions](#step-definitions)
- [Transitions](#transitions)
- [Actions](#actions)
- [Conformance](#conformance)
- [Examples](#examples)

---

## Syntax Synopsis

See [rundown-format.md](./FORMAT.md) for the complete BNF-style grammar.

---

## Document Structure

A Rundown document (`.runbook.md`) consists of an optional title and description, followed by one or more steps.

### Header
- **Title**: An optional H1 header (`# Title`).
- **Description**: Optional description text.

### Steps
Steps are the fundamental units of execution. They are defined using H2 (`##`) headers.

### Scenarios

Scenarios define executable command sequences for testing and documentation:

```yaml
scenarios:
  completed:
    description: Optional description
    commands:
      - rd run --prompted example.runbook.md
      - rd pass
    result: COMPLETE  # or STOP
```

**Fields:**
- `description` (optional): Explains what the scenario demonstrates
- `commands` (required): Array of CLI commands to execute in order
- `result` (required): Expected terminal state (`COMPLETE` or `STOP`)

**CLI Usage:**
- `rd scenario ls <file>` - List all scenarios
- `rd scenario show <file> <name>` - Show scenario details
- `rd scenario run <file> <name>` - Run a scenario

---

## Template Variables

Rundown supports template variables using Handlebars double-brace syntax: `{{variableName}}`.

### Syntax

```markdown
## 1. Deploy to {{environment}}
```bash
npm run deploy --env={{environment}}
```
```

### Variable Names

Variable names must be valid identifiers matching the pattern: `/^[a-zA-Z_][a-zA-Z0-9_]*$/`

- Must start with a letter or underscore
- Can contain letters, digits, and underscores
- Case-sensitive

### Built-In Variables

Rundown provides built-in variables using PascalCase, consistent with existing built-ins (Date, WorkPath).

| Variable | Value | Available |
|----------|-------|-----------|
| `{{Step}}` | Full step identifier (`3`, `3.1`, `ErrorHandler`) | Always |
| `{{Index}}` | Current loop iteration number | Inside FOR steps |

These join the template variable context alongside user-defined variables. `{{Index}}` is only defined inside a FOR loop; outside a loop it is preserved as literal text.

### Undefined Variable Behavior

When a variable is not provided, it is preserved as literal text in the output:
- Input: `Deploy to {{environment}}`
- With `--var environment=prod`: `Deploy to prod`
- Without variable: `Deploy to {{environment}}` (unchanged)

### Expansion Timing

Template variables are expanded **once** when `rd run` is invoked. The expanded content is stored in the runbook state, ensuring that resume commands (`pass`, `fail`, `goto`, `status`, `pop`) work consistently without re-rendering.

**FOR loop variables** are expanded **per-iteration**. The loop variable (`{{batch}}`, etc.) and `{{Index}}` are re-evaluated at the start of each iteration, while all other variables retain their initial expansion.

---

## Step Definitions

A step (`##`) defines a unit of work or orchestration.
A step always has an identifier and title.

```markdown
## {Identifier} {Title}
```

A step may contain ONE of the following content types:

- **Prompt**: prompt text and/or a code block.
- **Substeps**: sequence of nested steps defined using H3 (`###`).
- **Runbooks**: list of one or more runbooks.

### Identifiers
Step identifiers define the sequence and structure of the runbook.

| Format | Type | Description |
|--------|------|-------------|
| `1` | Static | Standard sequential step |
| `1`, `2.1` | Substep | Sequential substep (parent prefix optional) |
| `Name` | Named | Jump target step (GOTO only) |
| `1.Name` | Named Substep | Named child of parent step |

**Rules:**
1. Steps MUST be numbered sequentially starting from 1.
2. Substeps MUST be numbered sequentially starting from 1.

### FOR Steps

A step with a `FOR` annotation iterates its substeps.

**Syntax:**

```markdown
## 3 Implement tasks in batches
- FOR batch IN 1 TO {{BatchCount}}
- PASS ALL: CONTINUE
- FAIL ANY: STOP
### 1 Implement (code-agent)
- PASS: CONTINUE
- FAIL: BREAK
### 2 Review (review-agent)
- PASS: CONTINUE
- FAIL: BREAK
```

**FOR clause variants:**

| Syntax | Description |
|--------|-------------|
| `FOR var IN 1 TO 10` | Explicit range, named variable |
| `FOR 1 TO 10` | Explicit range, no variable |
| `FOR var IN 10` | Implicit start (1), named variable |
| `FOR 10` | Implicit start (1), no variable |
| `FOR var IN 1 TO {{Max}}` | Variable range |

**Loop variable:** The named variable joins the template variable context per-iteration. Accessible as `{{var}}` in step content and code blocks. Its value equals the iteration index.

**Aggregation:** Parent FOR step transitions use ALL/ANY to aggregate **across iterations**. Substep transitions control within-iteration flow (CONTINUE, NEXT, BREAK, STOP, GOTO). Parent transitions evaluate the post-loop aggregate (PASS ALL, FAIL ANY, etc.).

```markdown
## 3 Review all batches
- FOR batch IN 1 TO {{BatchCount}}
- PASS ALL: CONTINUE
- FAIL ANY: STOP
### 1 Security review
- PASS: CONTINUE
- FAIL: BREAK
### 2 Code review
- PASS: CONTINUE
- FAIL: BREAK
```

Parallel vs sequential execution of substeps is a **runtime decision**, orthogonal to syntax. ALL/ANY defines aggregation logic, not execution strategy.

---

### Named Steps

Named steps (and named substeps) are identified by a name instead of a number. They follow all the same rules as regular steps but are only reachable via explicit GOTO.

**Rules:**
- Named steps can coexist with static steps
- Named steps and named substeps are NOT part of sequential flow - CONTINUE skips them
- Names must match: `/^[A-Za-z_][A-Za-z0-9_]*$/`
- Reserved words cannot be used as names: NEXT, CONTINUE, COMPLETE, STOP, GOTO, RETRY, PASS, FAIL, YES, NO, ALL, ANY, BREAK, FOR, IN, TO, AT
- **Reserved word matching is case-sensitive.** `NEXT` is reserved, but `Next`, `next`, or `NextStep` are valid identifiers.

**Example:**
```markdown
## 1 Main runbook
- FAIL: GOTO ErrorHandler
- PASS: COMPLETE

## ErrorHandler
- PASS: STOP RECOVERED
Handle errors
```

---

### Prompt

A step may have a prompt and/or a code block.

- **Prompt**: text instructions for the agent/user.
- **Code Block**: code block containing a command.

**Ordering Rule:** When a step contains both a prompt and a body (code block, substeps, or runbooks), the prompt MUST appear FIRST.

````markdown
## {Identifier} {Title}
{Prompt}
```bash
{Command}
```
````

#### Code Blocks

Code blocks enable automatic execution and handling of commands.
The exit code of an executed command maps to the Step PASS/FAIL transition and action.

- **Executable**: code blocks may be executed automatically.
- **Prompt Code Block**: A code block marked `prompt` is never executed - the block is output for the agent/user.

| Tag                   | Type          | Behavior                                 |
|-----------------------|---------------|------------------------------------------|
| `bash`, `sh`, `shell` | Executable    | Auto-run, exit code determines PASS/FAIL |
| `bash prompt`         | Instructional | Output only, never executed              |
| `json`, `lang`        | Instructional | Output only, never executed              |
| `prompt`              | Instructional | Output only, never executed              |


**Note:** A `prompt` code block counts as the step's command (it becomes `rd prompt '...'`). Since only one code block is allowed per step, you cannot have both a `bash` command AND a `prompt` block in the same step. Use prompt TEXT (paragraph

**Info string syntax:** Use space-separated tokens only. The optional `prompt` flag can follow a language tag (for example: `json prompt`, `bash prompt`). Semicolons or other separators are not allowed.

#### Execution Semantics

When executable code blocks run:

| Aspect | Behavior |
|--------|----------|
| **Working Directory** | Project root (where `rd run` was invoked) |
| **Timeout** | None (commands can run indefinitely) |
| **Environment** | Inherited from parent process |
| **Result** | Exit code only (0 = PASS, non-zero = FAIL) |
| **Output** | Streams to terminal (`stdio: 'inherit'`) |

**Notes:**
- stderr content does NOT affect pass/fail determination
- For monorepo patterns, use explicit `cd`: `cd packages/foo && npm test`
- Long-running commands should use agent-driven mode (`rd pass`/`rd fail`)

---

### Substeps

Substeps enable grouping of related processes within a Step.

- **Headers**: Defined using H3 (`###`) headers.
- **Nesting**: Only valid as children of H2 steps. Substeps CANNOT contain further nested steps (H4 is invalid).
- **Exclusivity**: Like Steps, a Substep MUST contain either a **Prompt** or a **Runbook List**, but not both.

#### Identifiers

Substep identifiers must be numbered sequentially. The parent prefix is optional.

| Format | Description |
|--------|-------------|
| `### 1` | Sequential substep (short form) |
| `### 2.1` | Sequential substep (qualified form) |
| `### 1.Name` | Named substep |

#### Result Aggregation
When a Step contains Substeps, the parent step's final outcome is derived from the collective results of its children. This aggregation is controlled by [Transitions](#transitions) using `ALL` or `ANY` modifiers.

---

### Runbooks

Runbooks enable nested runbooks.

Example:
```markdown
## 1. Code Review
  - code-review.runbook.md
  - security-review.runbook.md
```

---

## Transitions

Transitions define the control flow based on the result of a step or substep.

**Syntax:**
```text
- { PASS | FAIL | YES | NO } [ { ALL | ANY } ]: action
```

**Result:**
- `PASS` / `YES`: The unit (step, substep, or command) succeeded.
- `FAIL` / `NO`: The unit failed.

Aliases are optimised for readability (`YES/NO` for prompts, `PASS/FAIL` for command results).

**Modifiers (Aggregation):**
Used when a step has substeps or runbooks.
- `ALL`: Trigger only if ALL units have this outcome.
- `ANY`: Trigger if AT LEAST ONE unit has this outcome.

**Default Behavior (Pessimistic):**
- `PASS` implies `PASS ALL`
- `FAIL` implies `FAIL ANY`

**Partial Transition Defaults:**
When only one transition is defined, the other uses its default action:
- If only `PASS` defined -> `FAIL` defaults to `FAIL ANY: STOP`
- If only `FAIL` defined -> `PASS` defaults to `PASS ALL: CONTINUE`

---

## Actions

Actions determine what happens next.

| Action | Description |
|--------|-------------|
| `CONTINUE` | Proceed to the next unit in sequence. |
| `COMPLETE [msg]` | Runbook has completed successfully. Optional message. |
| `STOP [msg]` | Halt runbook execution immediately. Optional message. |
| `GOTO {id} [AT index]` | Jump to Step `id`. `AT index` is only valid when the target step has a FOR annotation. |
| `NEXT` | Skip remaining substeps, advance to next FOR iteration. |
| `BREAK` | Exit the FOR loop; parent transitions evaluate. |
| `RETRY [n] [action]` | Retry the current unit `n` times (default 1). If exhausted, perform `action`. |

**Default Actions:**
- `PASS: CONTINUE`
- `FAIL: STOP`


### GOTO

| Target | Valid From | Description |
|--------|-----------|-------------|
| `GOTO N` | Any step | Jump to step N (if FOR step, implies AT 1) |
| `GOTO N.M` | Any step | Jump to substep M of step N |
| `GOTO Name` | Any step | Jump to named step |
| `GOTO Name.M` | Any step | Jump to substep M of named step |
| `GOTO N AT I` | Any step | Enter FOR step N at iteration I (only if N is a FOR step) |
| `GOTO N AT {{Index}}` | Inside FOR | Re-enter FOR step N at current iteration |
| `GOTO N.M AT I` | Any step | Jump to substep M of FOR step N at iteration I (only if N is a FOR step) |
| `GOTO Name AT I` | Any step | Enter named FOR step at iteration I (only if Name is a FOR step) |

**AT syntax (FOR steps):**

`AT` is only valid when the target is a step with a FOR annotation. It specifies the iteration. If omitted, it defaults to 1 (restart from beginning):

| Syntax | Meaning |
|--------|---------|
| `GOTO 3 AT 1` | Enter step 3 loop at iteration 1 (reset) |
| `GOTO 3 AT {{Index}}` | Re-enter step 3 at current iteration (restart) |
| `GOTO 3.1 AT {{Index}}` | Jump to substep 1 of step 3 at current iteration |
| `GOTO 3` (no AT) | Implies `GOTO 3 AT 1` (reset to first iteration) |

**Named step context:** Named steps inherit loop context. `GOTO ErrorHandler` from inside a FOR preserves `{{Step}}` and `{{Index}}`, enabling generic error handlers:

```markdown
## ErrorHandler
- PASS: GOTO {{Step}} AT {{Index}}
```

### NEXT and BREAK

`NEXT` and `BREAK` are loop control actions, valid **only within substeps of a FOR step**.

| Action | Effect |
|--------|--------|
| `NEXT` | Skip remaining substeps in this iteration, advance to next iteration |
| `BREAK` | Exit the FOR loop entirely; parent step transitions evaluate |

These actions are **invalid** at the parent FOR step level. The parent step uses standard actions (CONTINUE, STOP, COMPLETE, GOTO).

### CONTINUE Semantics

CONTINUE means "proceed to the next thing in sequence." The runtime resolves context:

- More substeps -> next substep
- Last substep, more iterations -> next iteration
- Last substep, last iteration (or no FOR) -> exit loop, parent evaluates
- No substeps -> next step

---

## Conformance

Parsers and executors must adhere to strict validation:

1. **Hierarchy**: H1 is Metadata. H2 is Step. H3 is Substep. H4+ is invalid.
2. **Sequencing**: Steps must be strictly sequential (1, 2, 3...).
3. **Ordering**: Within a step or substep, content MUST appear in order: FOR annotation (if any), transitions (if any), prompt (if any), body (if any).
4. **Exclusivity**: Units MUST contain exactly one of their permitted body types (code_block, substeps, or runbooks).
5. **Single Command**: Each step/substep may have at most one code block (bash, sh, shell, prompt).
6. **Recursion**: `RETRY` actions cannot contain another `RETRY`.
7. **FOR validation**: `NEXT` and `BREAK` are only valid within substeps of a FOR step.
8. **FOR steps require substeps**: A step with a FOR annotation must contain substeps; FOR is invalid on steps with code blocks or runbooks.
9. **FOR placement**: The FOR annotation must appear before transitions in the bullet list.

---

## Examples

Executable examples and conformance test cases are maintained in the `packages/parser/fixtures/conformance/` directory.

- **Valid Runbooks**: `packages/parser/fixtures/conformance/valid/` contains symlinks to `runbooks/patterns/` - browse the patterns directory directly for example runbooks
- **Invalid Runbooks (Error Cases)**: `packages/parser/fixtures/conformance/invalid/`

> **Tip:** For browsable examples, see `runbooks/patterns/` directly. The symlinks in `valid/` are for conformance testing.
