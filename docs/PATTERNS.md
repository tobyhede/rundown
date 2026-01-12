<!-- GENERATED FILE - DO NOT EDIT DIRECTLY -->
<!-- Source: runbooks/patterns/INDEX.md -->
<!-- Regenerate: npm run docs:patterns -->

# Rundown Patterns

Common patterns for Rundown workflows. See [SPEC.md](../../docs/SPEC.md) for syntax reference.

## Contents

- [Sequential Workflows](#sequential-workflows)
- [Dynamic Steps](#dynamic-steps)
- [Named Steps](#named-steps)
- [Substeps](#substeps)
- [GOTO Navigation](#goto-navigation)
- [Transitions](#transitions)
- [Retry Behavior](#retry-behavior)
- [Prompts](#prompts)
- [Metadata & Instructions](#metadata--instructions)
- [Workflow Composition](#workflow-composition)

---

## Sequential Workflows

Linear workflows with numbered steps.

### standard-sequential.runbook.md

Basic numbered steps executing in order.


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


---

## Dynamic Steps

Runtime-determined iteration using `{N}` placeholder.

### dynamic-step-next.runbook.md

Dynamic step with GOTO NEXT for iteration.


**dynamic-step-next.runbook.md:**

```rundown
## {N}. Process Item
Do something.
- PASS: GOTO NEXT
```


### dynamic-navigation.runbook.md

Navigation between dynamic step instances.


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


### dynamic-batch.runbook.md

Batch processing with dynamic substeps.


**dynamic-batch.runbook.md:**

```rundown
## 1. Process Files

### 1.{n} Process Item

**Prompt:** Process file number {n}.

```bash
./process.sh item_{n}.dat
```
```


---

## Named Steps

Steps identified by name instead of number.

### named-steps.runbook.md

Basic named steps with GOTO by name.


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


### named-substeps.runbook.md

Named substeps within named steps.


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


### mixed-named-static.runbook.md

Named steps mixed with numbered steps.


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


### mixed-named-dynamic.runbook.md

Named steps mixed with dynamic steps.


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


---

## Substeps

Nested steps within parent steps.

### nested-static-substeps.runbook.md

Static substeps within static steps.


**nested-static-substeps.runbook.md:**

```rundown
## 1. Parent

### 1.1 Static Child
Content.

### 1.2 Another Child
Content.
```


### substep-transitions.runbook.md

Transition logic for substeps.


**substep-transitions.runbook.md:**

```rundown
# Substep Transitions Conformance
Tests discrete transitions and navigation at the substep level.

## 1. Complex Parent

### 1.1 Initial

```bash
rd echo --result pass
```

Do first thing.
- PASS: CONTINUE
- FAIL: RETRY 2 STOP

### 1.2 Branch point

```bash
rd echo --result pass
```

Ask a question.
- YES: GOTO 1.4
- NO: CONTINUE

### 1.3 Alternative path

```bash
rd echo --result pass
```

Should be skipped if YES.
- PASS: CONTINUE

### 1.4 Target

```bash
rd echo --result pass
```

Reached via GOTO or CONTINUE.
- PASS: CONTINUE
```


### dynamic-substep-transitions.runbook.md

Transitions with dynamic substeps.


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


---

## GOTO Navigation

Jumping between steps.

### goto-step.runbook.md

GOTO a numbered step.


**goto-step.runbook.md:**

```rundown
# GOTO Step Pattern
Demonstrates GOTO N - jumping to a specific step number.

## 1. Entry point

```bash
rd echo --result pass
```

- PASS: GOTO 3
- FAIL: STOP

## 2. Skipped step

This step is skipped via GOTO.

```bash
rd echo --result fail
```

- PASS: CONTINUE
- FAIL: STOP

## 3. Jump target

Reached via GOTO from step 1.

```bash
rd echo --result pass
```

- PASS: COMPLETE
- FAIL: STOP
```


### goto-substep.runbook.md

GOTO a specific substep.


**goto-substep.runbook.md:**

```rundown
# GOTO Substep Pattern
Demonstrates GOTO N.M - jumping to a specific substep.

## 1. Parent step

### 1.1 Entry point

```bash
rd echo --result pass
```

- PASS: GOTO 1.3
- FAIL: STOP

### 1.2 Skipped substep

This substep is skipped via GOTO.

```bash
rd echo --result fail
```

- PASS: CONTINUE
- FAIL: STOP

### 1.3 Jump target

Reached via GOTO from 1.1.

```bash
rd echo --result pass
```

- PASS: COMPLETE
- FAIL: STOP
```


### goto-dynamic-substep.runbook.md

GOTO within dynamic substeps.


**goto-dynamic-substep.runbook.md:**

```rundown
# GOTO Dynamic Substep Pattern
Demonstrates GOTO {N}.M - jumping within a dynamic step instance.

## {N}. Process batch

### {N}.1 First task

```bash
rd echo --result pass
```

- PASS: GOTO {N}.3
- FAIL: STOP

### {N}.2 Skipped task

This task is skipped via GOTO.

```bash
rd echo --result fail
```

- PASS: CONTINUE
- FAIL: STOP

### {N}.3 Final task

Reached via GOTO from {N}.1.

```bash
rd echo --result pass
```

- PASS: GOTO NEXT
- FAIL: STOP
```


### goto-named.runbook.md

GOTO a named step.


**goto-named.runbook.md:**

```rundown
# GOTO Named Step Pattern
Demonstrates GOTO <name> - jumping to a named step.

## Initialize (name: Initialize)

Set up the workflow.

```bash
rd echo --result pass
```

- PASS: CONTINUE
- FAIL: GOTO Cleanup

## Process (name: Process)

Do the main work.

```bash
rd echo --result pass
```

- PASS: GOTO Cleanup
- FAIL: GOTO ErrorHandler

## ErrorHandler (name: ErrorHandler)

Handle errors.

```bash
rd echo --result pass
```

- PASS: GOTO Cleanup
- FAIL: STOP

## Cleanup (name: Cleanup)

Clean up resources.

```bash
rd echo --result pass
```

- PASS: COMPLETE
- FAIL: STOP
```


### goto-next.runbook.md

GOTO NEXT for advancing dynamic steps.


**goto-next.runbook.md:**

```rundown
# GOTO NEXT Pattern
Demonstrates GOTO NEXT - advancing to the next dynamic step instance.

## {N}. Iteration

Process item N. Use COMPLETE to exit loop.

```bash
rd echo --result pass
```

- PASS: GOTO NEXT
- FAIL: COMPLETE
```


---

## Transitions

PASS/FAIL logic and state transitions.

### default-transitions.runbook.md

Default PASS/FAIL behavior.


**default-transitions.runbook.md:**

```rundown
# Default Transitions

Tests implicit PASS→CONTINUE, FAIL→STOP when no transitions defined.

## 1. Step with no transitions

```bash
rd echo --result pass
```

## 2. Final step

```bash
rd echo --result pass
```

- PASS: COMPLETE
```


### complex-transitions.runbook.md

Complex conditional transitions.


**complex-transitions.runbook.md:**

```rundown
## 1. Aggregation

```bash
rd echo --result pass
```

- PASS ALL: CONTINUE
- FAIL ANY: STOP "Failed"

## 2. Optimistic

```bash
rd echo --result pass
```

- PASS ANY: GOTO 4
- FAIL ALL: RETRY 3

## 3. Empty

```bash
rd echo --result pass
```

- PASS: CONTINUE

## 4. End

```bash
rd echo --result pass
```

- PASS: COMPLETE
```


---

## Retry Behavior

Retry logic and exhaustion handling.

### retry-success.runbook.md

Basic retry until success.


**retry-success.runbook.md:**

```rundown
# RETRY Success Before Exhaustion

Tests that RETRY succeeds before count is exhausted.

## 1. Flaky step that recovers

```bash
rd echo --result fail --result pass
```

- PASS: COMPLETE
- FAIL: RETRY 3 STOP
```


### retry-counter-reset.runbook.md

Retry counter reset behavior.


**retry-counter-reset.runbook.md:**

```rundown
# Retry Counter Reset on GOTO

Tests spec rule: "GOTO resets the retry counter to 0 for the target location"

## 1. First attempt

```bash
rd echo --result fail --result fail
```

- PASS: CONTINUE
- FAIL: RETRY 1 GOTO 2

## 2. Second attempt (counter should be 0 again)

```bash
rd echo --result fail --result pass
```

- PASS: COMPLETE
- FAIL: RETRY 1 STOP
```


### retry-exhaustion-continue.runbook.md

Continue to next step on retry exhaustion.


**retry-exhaustion-continue.runbook.md:**

```rundown
# RETRY Exhaustion with CONTINUE

Tests that RETRY exhaustion triggers CONTINUE fallback action.

## 1. Flaky step

```bash
rd echo --result fail --result fail
```

- PASS: COMPLETE
- FAIL: RETRY 1 CONTINUE

## 2. Fallback step

```bash
rd echo --result pass
```

- PASS: COMPLETE
```


### retry-exhaustion-done.runbook.md

Mark done on retry exhaustion.


**retry-exhaustion-done.runbook.md:**

```rundown
# RETRY Exhaustion with COMPLETE

Tests that RETRY exhaustion triggers COMPLETE fallback action.

## 1. Flaky step

```bash
rd echo --result fail --result fail
```

- PASS: CONTINUE
- FAIL: RETRY 1 COMPLETE
```


### retry-exhaustion-goto.runbook.md

GOTO on retry exhaustion.


**retry-exhaustion-goto.runbook.md:**

```rundown
# RETRY Exhaustion with GOTO

Tests that RETRY exhaustion triggers GOTO fallback action.

## 1. Flaky step

```bash
rd echo --result fail --result fail --result fail
```

- PASS: CONTINUE
- FAIL: RETRY 2 GOTO 3

## 2. Skipped step

```bash
rd echo --result pass
```

- PASS: COMPLETE

## 3. Recovery step

```bash
rd echo --result pass
```

- PASS: COMPLETE
```


---

## Prompts

User prompts and input handling.

### prompted-steps.runbook.md

Steps with user prompts.


**prompted-steps.runbook.md:**

```rundown
## 1. Step with prompt
**Prompt:** Please review the code.

## 2. Step with implicit prompt
Review this instead.
```


### mixed-prompts.runbook.md

Different prompt types in one workflow.


**mixed-prompts.runbook.md:**

```rundown
## 1. Mixed prompts
**Prompt:** Explicit prompt.
- Implicit instruction 1
- Implicit instruction 2

- PASS: CONTINUE
- FAIL: STOP
```


### yes-no-aliases.runbook.md

Aliases for yes/no prompts.


**yes-no-aliases.runbook.md:**

```rundown
# YES/NO Aliases

Test that YES/NO work as aliases for PASS/FAIL.

## 1. Prompt step

Did you verify the deployment?

- YES: CONTINUE
- NO: STOP "Verification failed"
```


---

## Metadata & Instructions

Frontmatter and instruction formats.

### metadata-header.runbook.md

YAML frontmatter metadata.


**metadata-header.runbook.md:**

```rundown
# Workflow Title
This is a description of the workflow.

## 1. First Step
Do something.

## 2. Second Step
Do something else.
```


### list-instructions.runbook.md

List-based step instructions.


**list-instructions.runbook.md:**

```rundown
## 1. Step with list instructions
The following instructions should be preserved:
- instruction 1
- instruction 2

## 2. Step with mixed content
General prose.
- instruction 3
- instruction 4
```


---

## Workflow Composition

Orchestrating multiple workflows.

### workflow-composition.runbook.md

Parent workflow delegating to child workflows.


**workflow-composition.runbook.md:**

```rundown
## 1. Verify

- lint.runbook.md
- types.runbook.md
- tests.runbook.md

- FAIL ANY: STOP "Verification failed"
```


---

## See Also

- [SPEC.md](../../docs/SPEC.md) - Full specification
- [FORMAT.md](../../docs/FORMAT.md) - BNF grammar
