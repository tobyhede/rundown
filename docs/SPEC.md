---
version: 1.0.0
---

# Rundown Runbook Specification

Rundown is a format for defining executable runbooks using Markdown.

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
Steps can be `dynamic`. Dynamic steps enable steps to be defined at runtime.

| Format | Type | Description |
|--------|------|-------------|
| `1` | Static | Standard sequential step |
| `1.1` | Static Substep | Explicitly numbered nested step |
| `1.{n}` | Dynamic Substep | Template nested step |
| `{N}` | Dynamic | Template step instantiated at runtime |
| `{N}.1` | Nested Static | Static child of dynamic parent |
| `{N}.{n}`| Nested Dynamic | Dynamic child of dynamic parent |
| `Name` | Named | Jump target step (GOTO only) |
| `1.Name` | Named Substep | Named child of static parent |
| `{N}.Name` | Named Substep | Named child of dynamic parent |
| `Name.Name` | Named Substep | Named child of named parent |

**Rules:**
1. Static steps MUST be numbered sequentially starting from 1.
2. Static substeps MUST be numbered sequentially starting from 1.
3. Only one dynamic step can be defined at each level.
4. Dynamic identifiers (`{N}`, `{n}`) are placeholders.

#### Dynamic Identifiers and Steps

- Dynamic steps are for repeating the same procedure across a set of targets until the work is COMPLETE.
- Think of a Dynamic Step as a **loop construct** for agents. Instead of hardcoding steps, a "template" is defined that can be repeated as many times as required.

Example:
```markdown
## {N} For each assigned task
### {N}.1 Implement the code
### {N}.2 Run the tests
```

---

### Named Steps

Named steps (and named substeps) are identified by a name instead of a number. They follow all the same rules as regular steps but are only reachable via explicit GOTO.

**Rules:**
- Named steps can coexist with static OR dynamic steps
- Named steps and named substeps are NOT part of sequential flow - CONTINUE skips them
- Names must match: `/^[A-Za-z_][A-Za-z0-9_]*$/`
- Reserved words cannot be used as names: NEXT, CONTINUE, COMPLETE, STOP, GOTO, RETRY, PASS, FAIL, YES, NO, ALL, ANY
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
Substep identifiers must strictly match the parent Step ID prefix.

| Format | Parent | Child | Context |
| :--- | :--- | :--- | :--- |
| `1.1` | Static | Static | Sequential task in a static step. |
| `1.{n}` | Static | Dynamic | Iterative task in a static step. |
| `{N}.1` | Dynamic | Static | Fixed task within a dynamic instance. |
| `{N}.{n}` | Dynamic | Dynamic | Iterative task within a dynamic instance. |

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
```
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
- If only `PASS` defined → `FAIL` defaults to `FAIL ANY: STOP`
- If only `FAIL` defined → `PASS` defaults to `PASS ALL: CONTINUE`

---

## Actions

Actions determine what happens next.

| Action | Description |
|--------|-------------|
| `CONTINUE` | Proceed to the next unit in sequence. |
| `COMPLETE [msg]` | Runbook has completed successfully. Optional message. |
| `STOP [msg]` | Halt runbook execution immediately. Optional message. |
| `GOTO {id \| NEXT}` | Jump to Step `id` or create new dynamic step instance. |
| `RETRY [n] [action]` | Retry the current unit `n` times (default 1). If exhausted, perform `action`. |

**Default Actions:**
- `PASS: CONTINUE`
- `FAIL: STOP`


### GOTO

| Target              | Valid From                | Description                                       |
|---------------------|---------------------------|---------------------------------------------------|
| GOTO N              | Any step                  | Jump to step N (must exist)                       |
| GOTO N.M            | Any step                  | Jump to substep M of step N                       |
| GOTO Name           | Any step                  | Jump to named step                                |
| GOTO Name.M         | Any step                  | Jump to substep M of named step                   |
| GOTO {N}            | Any (dynamic context)     | Restart current dynamic step instance             |
| GOTO {N}.M          | Any (dynamic context)     | Jump to substep M within current dynamic instance |
| GOTO {N}.{n}        | Any (dynamic context)     | Resume at current substep of current runbook step |
| GOTO X.{n}          | Any (dynamic context)     | Jump to current dynamic substep instance          |
| GOTO NEXT           | Any (dynamic context)     | Advance innermost dynamic context                 |
| GOTO NEXT {N}       | Any step                  | Advance to next dynamic step instance             |
| GOTO NEXT {N}.{n}   | Any (dynamic context)     | Advance substep, stay in current step instance    |
| GOTO NEXT X.{n}     | Any step                  | Advance to next substep instance in step X        |

**Semantics:**
- `GOTO {N}` restarts the current dynamic step instance from the beginning.
- `GOTO {N}.{n}` resumes at exactly where we were (current step, current substep).
- `GOTO NEXT` without qualifier advances the innermost dynamic context.
- `GOTO NEXT {N}` advances to the next step instance.
- `GOTO NEXT {N}.{n}` advances to the next substep, staying in the current step instance.

**Dynamic Context:**
- "Any (dynamic context)" means the target is valid from any step or substep, including named steps, as long as there is an active dynamic step instance.
- The runtime tracks the current dynamic context. When a named step is reached via GOTO from within a dynamic step, it inherits that dynamic context.
- Example: `## {N}` → `GOTO ErrorHandler` → `GOTO {N}` returns to the active dynamic instance.



---

## Conformance

Parsers and executors must adhere to strict validation:

1. **Hierarchy**: H1 is Metadata. H2 is Step. H3 is Substep. H4+ is invalid.
2. **Step Pattern**: A runbook contains EITHER static steps OR exactly one dynamic step template at each level.
3. **Sequencing**: Static steps must be strictly sequential (1, 2, 3...).
4. **Ordering**: Within a step or substep, content MUST appear in order: transitions (if any), prompt (if any), body (if any).
5. **Exclusivity**: Units MUST contain exactly one of their permitted body types (code_block, substeps, or runbooks).
6. **Single Command**: Each step/substep may have at most one code block (bash, sh, shell, prompt).
7. **Recursion**: `RETRY` actions cannot contain another `RETRY`.

---

## Examples

Executable examples and conformance test cases are maintained in the `packages/parser/fixtures/conformance/` directory.

- **Valid Runbooks**: `packages/parser/fixtures/conformance/valid/`
- **Invalid Runbooks (Error Cases)**: `packages/parser/fixtures/conformance/invalid/`
