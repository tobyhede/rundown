# Rundown Patterns

Common patterns for Rundown workflows. See [SPEC.md](/docs/SPEC.md) for syntax reference.

## Contents

- [Pattern 1: Static Sequential](#pattern-1-static-sequential) - Linear workflow with GOTO branching
- [Pattern 2: Dynamic Iteration](#pattern-2-dynamic-iteration) - Runtime-determined iterations
- [Pattern 3: Subagent Dispatch](#pattern-3-subagent-dispatch) - Delegate to child workflows
- [Pattern 4: Workflow Composition](#pattern-4-workflow-composition) - Pipeline orchestration
- [Pattern 5: Named Steps](#pattern-5-named-steps) - Semantic step names
- [Additional Examples](#additional-examples) - Transitions, retry, prompts

---

## Pattern 1: Static Sequential

Simple linear workflow with optional branching via GOTO.

**Use when:** Fixed number of steps, simple flow control.

- [standard-sequential.runbook.md](./standard-sequential.runbook.md)

**Characteristics:**
- Steps numbered sequentially: 1, 2, 3...
- GOTO for loops and branches
- No runtime enumeration

---

## Pattern 2: Dynamic Iteration

Use `## {N}` dynamic step with `GOTO NEXT` action for batch processing.

**Use when:** Unknown number of iterations determined at runtime.

- [dynamic-step-next.runbook.md](./dynamic-step-next.runbook.md)
- [dynamic-navigation.runbook.md](./dynamic-navigation.runbook.md)

**Characteristics:**
- `{N}` is placeholder, runtime creates instances: 1, 2, 3...
- `GOTO NEXT` advances to instance N+1
- `COMPLETE` exits the loop
- Cannot mix static and dynamic top-level steps

---

## Pattern 3: Subagent Dispatch

Use dynamic substeps `### {N}.{n}` with workflow list for parallel/sequential subagent dispatch.

**Use when:** Delegating tasks to child workflows (subagents).

- [dynamic-batch.runbook.md](./dynamic-batch.runbook.md)
- [dynamic-substep-transitions.runbook.md](./dynamic-substep-transitions.runbook.md)

**Characteristics:**
- `### 1.{n}` is dynamic substep template
- Workflow list (`- file.runbook.md`) delegates to child workflow
- Runtime enumerates tasks, creates instances: 1.1, 1.2, 1.3...
- Each instance dispatches the child workflow
- `PASS ALL` / `FAIL ANY` aggregates substep outcomes

**Key insight:** This is the primary mechanism for subagent dispatch. The parent workflow orchestrates, child workflows execute.

---

## Pattern 4: Workflow Composition

Static step delegates to multiple child workflows in sequence.

**Use when:** Orchestrating a pipeline of workflows.

- [workflow-composition.runbook.md](./workflow-composition.runbook.md)

**Characteristics:**
- Workflow list executes in order
- Parent step aggregates outcomes
- Clean separation of concerns

---

## Pattern 5: Named Steps

Use named steps for readability and GOTO by name.

**Use when:** Steps have semantic meaning, or GOTO by number is fragile.

- [named-steps.runbook.md](./named-steps.runbook.md)
- [named-substeps.runbook.md](./named-substeps.runbook.md)
- [mixed-named-static.runbook.md](./mixed-named-static.runbook.md)
- [mixed-named-dynamic.runbook.md](./mixed-named-dynamic.runbook.md)

**Characteristics:**
- Steps use `## name:` format
- GOTO uses step name: `GOTO setup`
- Can mix with numbered/dynamic steps

---

## Additional Examples

### Transitions and Control Flow

- [default-transitions.runbook.md](./default-transitions.runbook.md) - Default PASS/FAIL behavior
- [complex-transitions.runbook.md](./complex-transitions.runbook.md) - Complex transition logic
- [substep-transitions.runbook.md](./substep-transitions.runbook.md) - Substep aggregation
- [nested-static-substeps.runbook.md](./nested-static-substeps.runbook.md) - Nested substeps

### Retry Behavior

- [retry-success.runbook.md](./retry-success.runbook.md) - Basic retry
- [retry-counter-reset.runbook.md](./retry-counter-reset.runbook.md) - Counter reset behavior
- [retry-exhaustion-continue.runbook.md](./retry-exhaustion-continue.runbook.md) - Continue on exhaustion
- [retry-exhaustion-goto.runbook.md](./retry-exhaustion-goto.runbook.md) - GOTO on exhaustion
- [retry-exhaustion-done.runbook.md](./retry-exhaustion-done.runbook.md) - Done on exhaustion

### Prompts and Metadata

- [prompted-steps.runbook.md](./prompted-steps.runbook.md) - User prompts
- [mixed-prompts.runbook.md](./mixed-prompts.runbook.md) - Mixed prompt types
- [yes-no-aliases.runbook.md](./yes-no-aliases.runbook.md) - Prompt aliases
- [metadata-header.runbook.md](./metadata-header.runbook.md) - YAML frontmatter
- [list-instructions.runbook.md](./list-instructions.runbook.md) - List-based instructions

---

## See Also

- [SPEC.md](../../docs/SPEC.md) - Full specification
- [FORMAT.md](../../docs/FORMAT.md) - BNF grammar
