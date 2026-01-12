<!-- GENERATED FILE - DO NOT EDIT DIRECTLY -->
<!-- Source: runbooks/patterns/INDEX.md -->
<!-- Regenerate: npm run docs:patterns -->

# Rundown Patterns

Common patterns for Rundown workflows. See [SPEC.md](/docs/SPEC.md) for syntax reference.

---

## Pattern 1: Static Sequential

Simple linear workflow with optional branching via GOTO.

**Use when:** Fixed number of steps, simple flow control.


**standard-sequential.runbook.md:**

```rundown
## 1. Setup

```bash
rd echo --result pass
```

- PASS: CONTINUE
- FAIL: STOP

## 2. Test

```bash
rd echo --result fail --result fail --result pass
```

- PASS: COMPLETE
- FAIL: RETRY 2
```


**Characteristics:**
- Steps numbered sequentially: 1, 2, 3...
- GOTO for loops and branches
- No runtime enumeration

---

## Pattern 2: Dynamic Iteration

Use `## {N}` dynamic step with `GOTO NEXT` action for batch processing.

**Use when:** Unknown number of iterations determined at runtime.


**dynamic-step-next.runbook.md:**

```rundown
## {N}. Process Item
Do something.
- PASS: GOTO NEXT
```


**dynamic-navigation.runbook.md:**

```rundown
## {N}. Process Item

### {N}.1 First substep
Do work.
- PASS: GOTO {N}.2

### {N}.2 Second substep
Do more work.
- PASS: GOTO NEXT
```


**Characteristics:**
- `{N}` is placeholder, runtime creates instances: 1, 2, 3...
- `GOTO NEXT` advances to instance N+1
- `COMPLETE` exits the loop
- Cannot mix static and dynamic top-level steps

---

## Pattern 3: Subagent Dispatch

Use dynamic substeps `### {N}.{n}` with workflow list for parallel/sequential subagent dispatch.

**Use when:** Delegating tasks to child workflows (subagents).


**dynamic-batch.runbook.md:**

```rundown
## 1. Process Files

### 1.{n} Process Item

**Prompt:** Process file number {n}.

```bash
./process.sh item_{n}.dat
```
```


**dynamic-substep-transitions.runbook.md:**

```rundown
# Dynamic Substep Transitions
Tests navigation in dynamic context.

## {N}. Dynamic Template

### {N}.1 Task
Process item.
- PASS: GOTO NEXT
- FAIL: STOP "Dynamic failure"
```


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


**workflow-composition.runbook.md:**

```rundown
## 1. Verify

- lint.runbook.md
- types.runbook.md
- tests.runbook.md

- FAIL ANY: STOP "Verification failed"
```


**Characteristics:**
- Workflow list executes in order
- Parent step aggregates outcomes
- Clean separation of concerns

---

## Pattern 5: Named Steps

Use named steps for readability and GOTO by name.

**Use when:** Steps have semantic meaning, or GOTO by number is fragile.


**named-steps.runbook.md:**

```rundown
# Named Steps Example

## 1 Main workflow
Do the main work
- FAIL: GOTO ErrorHandler
- PASS: COMPLETE SUCCESS

## ErrorHandler
Handle any errors that occur
- PASS: STOP RECOVERED
- FAIL: STOP "Unrecoverable error"
```


**named-substeps.runbook.md:**

```rundown
# Named Substeps Example

## 1 Main step
### 1.1 First substep
Do first thing
### 1.2 Second substep
Do second thing
### 1.Cleanup Handle cleanup
Clean up resources
- PASS: COMPLETE
- FAIL: STOP "Cleanup failed"
```


**mixed-named-static.runbook.md:**

```rundown
# Mixed Named and Static Steps

## 1 First step
- PASS: CONTINUE

## 2 Second step
- PASS: CONTINUE

## 3 Third step
- FAIL: GOTO ErrorHandler
- PASS: COMPLETE

## ErrorHandler
Log the error and stop
- PASS: STOP ERROR
```


**mixed-named-dynamic.runbook.md:**

```rundown
# Mixed Named and Dynamic Steps

## {N} Process each item
### {N}.1 Do work
- FAIL: GOTO {N}.Recovery
- PASS: GOTO NEXT

### {N}.Recovery Handle recovery
- PASS: GOTO NEXT
- FAIL: GOTO GlobalError

## GlobalError
Handle global errors
- PASS: STOP "All items failed"
```


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
