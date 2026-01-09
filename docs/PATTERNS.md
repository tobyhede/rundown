# Rundown Patterns

Common patterns for Rundown workflows. See [SPEC.md](./SPEC.md) for syntax reference.

---

## Pattern 1: Static Sequential

Simple linear workflow with optional branching via GOTO.

**Use when:** Fixed number of steps, simple flow control.

```markdown
## 1. First step

Do something.

- PASS: CONTINUE
- FAIL: STOP

## 2. Second step

Do something else.

- PASS: COMPLETE
- FAIL: GOTO 1
```

**Characteristics:**
- Steps numbered sequentially: 1, 2, 3...
- GOTO for loops and branches
- No runtime enumeration

---

## Pattern 2: Dynamic Iteration

Use `## {N}` dynamic step with `GOTO NEXT` action for batch processing.

**Use when:** Unknown number of iterations determined at runtime.

```markdown
## {N} Process item

Process item {N} from the queue.

**tsv yes:** More items remaining
**tsv no:** Queue empty

- PASS: GOTO NEXT
- FAIL: COMPLETE
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

```markdown
## 1. Execute tasks

### 1.{n}
 - implement-task.runbook.md

- PASS ALL: CONTINUE
- FAIL ANY: STOP "Task failed"

## 2. Complete

All tasks passed.

- PASS: COMPLETE
- FAIL: STOP
```

**Characteristics:**
- `### 1.{n}` is dynamic substep template
- Workflow list (`- file.runbook.md`) delegates to child workflow
- Runtime enumerates tasks, creates instances: 1.1, 1.2, 1.3...
- Each instance dispatches the child workflow
- `PASS ALL` / `FAIL ANY` aggregates substep outcomes

**Key insight:** This is the primary mechanism for subagent dispatch. The parent workflow orchestrates, child workflows execute.

---

## Pattern 4: Batch with Validation

Static steps with GOTO loop for batches, dynamic substeps for task dispatch.

**Use when:** Each batch needs validation after task execution.

**Constraint:** Cannot mix static (`## 1`) and dynamic (`## {N}`) top-level steps.

```markdown
## 1. Load plan

Review the plan.

- PASS: CONTINUE
- FAIL: STOP "STOPPED"

## 2. Execute batch

### 2.{n}
 - implement-task.runbook.md

- PASS ALL: CONTINUE
- FAIL ANY: STOP "STOPPED"

## 3. Check

```bash
npm run lint && npm run build && npm test
```

- PASS: CONTINUE
- FAIL: GOTO 4

## 4. Troubleshoot

Can you fix without changing approach?

**tsv yes:** Fix is trivial
**tsv no:** Needs plan revision

- PASS: GOTO 3
- FAIL: STOP "STOPPED"

## 5. Batch complete

**tsv yes:** More batches
**tsv no:** All done

- PASS: GOTO 2
- FAIL: COMPLETE
```

**Characteristics:**
- Static top-level steps: `## 1`, `## 2`, `## 3`...
- Dynamic substep `### 2.{n}` for task iteration with workflow list
- GOTO loop (`GOTO 2`) for batch iteration
- Validation as separate static steps
- Cannot use `GOTO NEXT` (requires dynamic top-level step)

---

## Pattern 5: Workflow Composition

Static step delegates to multiple child workflows in sequence.

**Use when:** Orchestrating a pipeline of workflows.

```markdown
## 1. Build pipeline

 - lint.runbook.md
 - build.runbook.md
 - test.runbook.md

- PASS ALL: CONTINUE
- FAIL ANY: STOP

## 2. Deploy

 - deploy.runbook.md

- PASS: COMPLETE
- FAIL: STOP
```

**Characteristics:**
- Workflow list executes in order
- Parent step aggregates outcomes
- Clean separation of concerns

---

## Anti-Patterns

### ❌ Using GOTO for iteration

```markdown
## 5. Task complete

**tsv yes:** More tasks
**tsv no:** Done

- PASS: GOTO 1
- FAIL: COMPLETE
```

**Problem:** Requires manual state tracking. Use dynamic steps instead.

**Fix:** Use `## {N}` with `GOTO NEXT` action.

### ❌ Mixing prose with workflow list

```markdown
## 1. Execute

Dispatch subagents to run tasks.

 - task.runbook.md

- PASS: CONTINUE
```

**Problem:** Violates exclusivity rule. Step must have EITHER body OR workflow list.

**Fix:** Put prose in description or use substeps.

### ❌ Static substeps for variable iteration

```markdown
### 1.1 Task 1
### 1.2 Task 2
### 1.3 Task 3
```

**Problem:** Requires knowing task count at authoring time.

**Fix:** Use `### 1.{n}` dynamic substep.

---

## Quick Reference

| Pattern | Top-level | Substeps | Use Case |
|---------|-----------|----------|----------|
| Static Sequential | `## 1`, `## 2` | None | Simple linear flow |
| Dynamic Iteration | `## {N}` | None | Unknown iterations |
| Subagent Dispatch | `## 1` | `### 1.{n}` + workflow | Delegate to children |
| Batch + Validation | `## {N}` | `### {N}.{n}` + `{N}.V` | Iterate with validation |
| Composition | `## 1` | workflow list | Pipeline orchestration |

---

## See Also

- [SPEC.md](./SPEC.md) - Full specification
- [FORMAT.md](./FORMAT.md) - BNF grammar
- [examples/runbooks/](../examples/runbooks/) - Working examples
