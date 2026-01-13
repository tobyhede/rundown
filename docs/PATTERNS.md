<!-- GENERATED FILE - DO NOT EDIT DIRECTLY -->
<!-- Source: runbooks/patterns/INDEX.md -->
<!-- Regenerate: npm run docs:patterns -->

# Rundown Patterns

Common patterns for Rundown workflows. See [MATRIX.md](./MATRIX.md) for complete coverage matrix and [SPEC.md](../../docs/SPEC.md) for syntax reference.

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
- [Mixed Patterns](#mixed-patterns)
- [Other](#other)

---

## Sequential Workflows

Linear workflows with numbered steps.

### standard-sequential.runbook.md

Basic numbered steps executing in order.


**standard-sequential.runbook.md:**

```rundown
## 1. Setup
- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo --result pass
```


## 2. Test
- PASS: COMPLETE
- FAIL: RETRY 2

```bash
rd echo --result fail --result fail --result pass
```
```


---

## Dynamic Steps

Runtime-determined iteration using `{N}` placeholder.

### dynamic-step-next.runbook.md

Dynamic step with GOTO NEXT for iteration.


**dynamic-step-next.runbook.md:**

```rundown
# Dynamic Step With GOTO NEXT

## {N}. Process Item
- PASS: GOTO NEXT


Execute.
```


### dynamic-navigation.runbook.md

Navigation between dynamic step instances.


**dynamic-navigation.runbook.md:**

```rundown
# Dynamic Step Navigation

## {N}. Process Item

### {N}.1 Prepare
Execute.

- PASS: GOTO {N}.2

### {N}.2 Run
Execute.

- PASS: GOTO NEXT
```


### dynamic-batch.runbook.md

Batch processing with dynamic substeps.


**dynamic-batch.runbook.md:**

```rundown
# Dynamic Batch Processing

## 1. Process Files

### 1.{n} Process Item

**Prompt:** Process item {n}.

```bash
./process.sh item_{n}.dat
```
```


### dynamic-step-named-substep.runbook.md

Dynamic step containing a named substep.


**dynamic-step-named-substep.runbook.md:**

```rundown
# Dynamic Step With Named Substep

## {N}. Dynamic

### {N}.1 Substep 1
- PASS: GOTO {N}.Named


```bash
rd echo --result pass
```

### {N}.2 Substep 2
Substep 2 should be skipped
```bash
rd echo --result fail
```

### {N}.Named Substep with Name
- PASS: COMPLETE


```bash
rd echo --result pass
```
```


### dynamic-step-dynamic-substeps.runbook.md

Doubly-dynamic iteration with {N}.{n} pattern.


**dynamic-step-dynamic-substeps.runbook.md:**

```rundown
# Dynamic Step With Dynamic Substeps

Demonstrates doubly-dynamic iteration with {N}.{n} pattern.

## {N}. Process Batch

### {N}.{n} Process Item
Process each item in batch N.

- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo "process item"
```


## Cleanup
Handle any failures.

- PASS: COMPLETE
- FAIL: STOP

```bash
rd echo "cleanup resources"
```
```


### dynamic-step-mixed-substeps.runbook.md

Dynamic steps with both static and named substeps.


**dynamic-step-mixed-substeps.runbook.md:**

```rundown
# Dynamic Step With Mixed Substeps

Demonstrates dynamic steps with both static and named substeps.

## {N}. Process Batch

### {N}.1 Prepare
Prepare batch N for processing.

- PASS: CONTINUE
- FAIL: GOTO {N}.Recovery

```bash
rd echo "prepare batch"
```


### {N}.2 Execute
Process the batch.

- PASS: GOTO NEXT
- FAIL: GOTO {N}.Recovery

```bash
rd echo "process batch"
```


### {N}.Recovery
Handle batch processing failure.

- PASS: GOTO NEXT
- FAIL: STOP

```bash
rd echo "recover from failure"
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
- FAIL: GOTO ErrorHandler
- PASS: COMPLETE SUCCESS


Do the main work

## ErrorHandler
- PASS: STOP RECOVERED
- FAIL: STOP "Unrecoverable error"


Handle any errors that occur
```


### named-substeps.runbook.md

Named substeps within named steps.


**named-substeps.runbook.md:**

```rundown
# Named Substeps Example

## 1 Main step
### 1.1 Prepare
Execute first action.
### 1.2 Run
Execute second action.
### 1.Cleanup Cleanup
Clean up resources

- PASS: COMPLETE
- FAIL: STOP "Cleanup failed"
```


### mixed-named-static.runbook.md

Named steps mixed with numbered steps.


**mixed-named-static.runbook.md:**

```rundown
# Mixed Named and Static Steps

## 1. Setup
- PASS: CONTINUE

## 2. Execute
- PASS: CONTINUE

## 3. Validate
- FAIL: GOTO ErrorHandler
- PASS: COMPLETE

## ErrorHandler
- PASS: STOP ERROR


Log the error and stop
```


### mixed-named-dynamic.runbook.md

Named steps mixed with dynamic steps.


**mixed-named-dynamic.runbook.md:**

```rundown
# Mixed Named and Dynamic Steps

## {N}. Process Item
### {N}.1 Execute
- FAIL: GOTO {N}.Recovery
- PASS: GOTO NEXT

### {N}.Recovery Recovery
- PASS: GOTO NEXT
- FAIL: GOTO GlobalError

## GlobalError
- PASS: STOP "All items failed"


Handle global errors
```


### named-step-dynamic-substep.runbook.md

Named step containing dynamic substeps.


**named-step-dynamic-substep.runbook.md:**

```rundown
# Named Step With Dynamic Substep

Demonstrates a named step containing dynamic substeps.

## 1. Run
- FAIL: GOTO ErrorHandler

```bash
rd echo --result fail
```


## ErrorHandler

### ErrorHandler.{n}
- PASS: COMPLETE
- FAIL: GOTO NEXT

```bash
rd echo --result fail --result pass
```
```


### named-step-static-substeps.runbook.md

Named step containing numbered substeps.


**named-step-static-substeps.runbook.md:**

```rundown
# Named Step With Static Substeps

Demonstrates named steps containing numbered substeps.

## 1. Setup
Initial setup step.

- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

```bash
rd echo "initial setup"
```


## ErrorHandler

### ErrorHandler.1 Prepare
Prepare for error handling.

- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo "prepare error handling"
```


### ErrorHandler.2 Execute
Execute error recovery.

- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo "execute recovery"
```


### ErrorHandler.3 Verify
Verify recovery succeeded.

- PASS: GOTO 1
- FAIL: STOP

```bash
rd echo "verify recovery"
```
```


### named-step-named-substeps.runbook.md

Named step containing named substeps.


**named-step-named-substeps.runbook.md:**

```rundown
# Named Step With Named Substeps

Demonstrates named steps containing named substeps.

## 1. Setup
Initial setup.

- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

```bash
rd echo "initial setup"
```


## ErrorHandler

### ErrorHandler.Prepare
Prepare for error handling.

- PASS: GOTO ErrorHandler.Execute
- FAIL: STOP

```bash
rd echo "prepare error handling"
```


### ErrorHandler.Execute
Execute error recovery.

- PASS: GOTO ErrorHandler.Verify
- FAIL: STOP

```bash
rd echo "execute recovery"
```


### ErrorHandler.Verify
Verify recovery succeeded.

- PASS: GOTO 1
- FAIL: STOP

```bash
rd echo "verify recovery"
```
```


### named-step-mixed-substeps.runbook.md

Named step with both static and named substeps.


**named-step-mixed-substeps.runbook.md:**

```rundown
# Named Step With Mixed Substeps

Demonstrates named steps with both static and named substeps.

## 1. Setup
Initial setup.

- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

```bash
rd echo "initial setup"
```


## ErrorHandler

### ErrorHandler.1 Prepare
Prepare for error handling.

- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo "prepare error handling"
```


### ErrorHandler.Cleanup
Named cleanup substep.

- PASS: GOTO 1
- FAIL: STOP

```bash
rd echo "cleanup after error"
```
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
Do first thing.
- PASS: CONTINUE
- FAIL: RETRY 2 STOP

```bash
rd echo --result pass
```

### 1.2 Branch point
Ask a question.
- YES: GOTO 1.4
- NO: CONTINUE

```bash
rd echo --result pass
```

### 1.3 Alternative path
Should be skipped if YES.
- PASS: CONTINUE

```bash
rd echo --result pass
```

### 1.4 Target
Reached via GOTO or CONTINUE.
- PASS: CONTINUE

```bash
rd echo --result pass
```
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


### static-step-mixed-substeps.runbook.md

Static steps containing both numbered and named substeps.


**static-step-mixed-substeps.runbook.md:**

```rundown
# Static Step With Mixed Substeps

Demonstrates static steps containing both numbered and named substeps.

## 1. Setup

### 1.1 Prepare
Prepare the environment.

- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo "prepare environment"
```


### 1.Cleanup
Named cleanup substep.

- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo "cleanup resources"
```


## 2. Execute
Run the main task.

- PASS: COMPLETE
- FAIL: GOTO 1.Cleanup

```bash
rd echo "execute main task"
```
```


---

## GOTO Navigation

Jumping between steps.

### goto-step.runbook.md

GOTO a numbered step.


**goto-step.runbook.md:**

```rundown
# GOTO Step
Demonstrates GOTO N - jumping to a specific step number.

## 1. Setup
- PASS: GOTO 3
- FAIL: STOP

```bash
rd echo --result pass
```


## 2. Skip
- PASS: CONTINUE
- FAIL: STOP

This step is skipped via GOTO.

```bash
rd echo --result fail
```


## 3. Jump target
- PASS: COMPLETE
- FAIL: STOP

Reached via GOTO from step 1.

```bash
rd echo --result pass
```
```


### goto-substep.runbook.md

GOTO a specific substep.


**goto-substep.runbook.md:**

```rundown
# GOTO Substep
Demonstrates GOTO N.M - jumping to a specific substep.

## 1. Parent step

### 1.1 Setup
- PASS: GOTO 1.3
- FAIL: STOP

```bash
rd echo --result pass
```


### 1.2 Skipped


### 1.3 GOTO Target

Reached via GOTO from 1.1.

```bash
rd echo --result pass
```
```


### goto-dynamic-substep.runbook.md

GOTO within dynamic substeps.


**goto-dynamic-substep.runbook.md:**

```rundown
# GOTO Dynamic Substep
Demonstrates GOTO {N}.M - jumping within a dynamic step instance.

## {N}. Process batch

### {N}.1 First task
- PASS: GOTO {N}.3
- FAIL: STOP

```bash
rd echo --result pass
```


### {N}.2 Skipped task
This task is skipped via GOTO.

- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo --result fail
```


### {N}.3 Final task
Reached via GOTO from {N}.1.

- PASS: GOTO NEXT
- FAIL: STOP

```bash
rd echo --result pass
```
```


### goto-dynamic-substep-from-named.runbook.md

GOTO dynamic substep from a named step.


**goto-dynamic-substep-from-named.runbook.md:**

```rundown
---
title: GOTO Dynamic Named Substep
description: Demonstrates GOTO {N}.Name - jumping to a named substep within a dynamic step
tags: [goto, dynamic, substep, named]
---

# GOTO Dynamic Named Substep

Demonstrates `GOTO {N}.Name` - jumping to a named substep within a dynamic step.

## {N}. Process Item

### {N}.Validate
Validate the current item.

- PASS: CONTINUE
- FAIL: GOTO {N}.Cleanup

### {N}.Execute
Execute processing for validated item.

- PASS: GOTO NEXT
- FAIL: GOTO {N}.Cleanup

### {N}.Cleanup
Clean up after validation or execution failure.

- PASS: GOTO NEXT
- FAIL: STOP
```


### goto-named.runbook.md

GOTO a named step.


**goto-named.runbook.md:**

```rundown
# GOTO Named Step
Demonstrates GOTO <name> - jumping to a named step.

## Initialize
- PASS: CONTINUE
- FAIL: GOTO Cleanup

Set up the workflow.

```bash
rd echo --result pass
```


## Process
- PASS: GOTO Cleanup
- FAIL: GOTO ErrorHandler

Do the main work.

```bash
rd echo --result pass
```


## ErrorHandler
- PASS: GOTO Cleanup
- FAIL: STOP

Handle errors.

```bash
rd echo --result pass
```


## Cleanup
- PASS: COMPLETE
- FAIL: STOP

Clean up resources.

```bash
rd echo --result pass
```
```


### goto-next.runbook.md

GOTO NEXT for advancing dynamic steps.


**goto-next.runbook.md:**

```rundown
# GOTO NEXT
Demonstrates GOTO NEXT - advancing to the next dynamic step instance.

## {N}. Iteration
- PASS: GOTO NEXT
- FAIL: COMPLETE

Process item N. Use COMPLETE to exit loop.

```bash
rd echo --result pass
```
```


### goto-static-named-substep.runbook.md

GOTO N.Name - jumping to a named substep within a static step.


**goto-static-named-substep.runbook.md:**

```rundown
# GOTO Static Named Substep

Demonstrates GOTO N.Name - jumping to a named substep within a static step.

## 1. Setup

### 1.1 Prepare
Initial preparation.

- PASS: GOTO 1.Cleanup
- FAIL: STOP

```bash
rd echo "prepare environment"
```


### 1.Cleanup
Named cleanup substep.

- PASS: CONTINUE
- FAIL: STOP

```bash
rd echo "cleanup resources"
```


## 2. Execute
Main execution.

- PASS: COMPLETE
- FAIL: GOTO 1.Cleanup

```bash
rd echo "execute main task"
```
```


### goto-from-named-step.runbook.md

Navigation from a named step to a numbered step.


**goto-from-named-step.runbook.md:**

```rundown
# GOTO From Named Step

Demonstrates navigation from a named step to a numbered step.

## 1. Setup
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Initial setup.

```bash
rd echo "initial setup"
```


## 2. Execute
- PASS: COMPLETE
- FAIL: GOTO ErrorHandler

Main execution.

```bash
rd echo "main execution"
```


## ErrorHandler
- PASS: GOTO 1
- FAIL: STOP

Handle errors and retry.

```bash
rd echo "handle error"
```
```


### goto-named-to-named.runbook.md

Navigation between named steps.


**goto-named-to-named.runbook.md:**

```rundown
# GOTO Named To Named

Demonstrates navigation between named steps.

## 1. Setup
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Initial setup.

```bash
rd echo "initial setup"
```


## 2. Execute
- PASS: COMPLETE
- FAIL: GOTO ErrorHandler

Main execution.

```bash
rd echo "main execution"
```


## ErrorHandler
- PASS: GOTO 1
- FAIL: GOTO Fallback

Primary error handler.

```bash
rd echo "handle error"
```


## Fallback
- PASS: COMPLETE "Recovered via fallback"
- FAIL: STOP "Unrecoverable error"

Final fallback handler.

```bash
rd echo "fallback recovery"
```
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
- PASS: COMPLETE

```bash
rd echo --result pass
```
```


### complex-transitions.runbook.md

Complex conditional transitions.


**complex-transitions.runbook.md:**

```rundown
# Complex Transitions

## 1. Aggregation
- PASS ALL: CONTINUE
- FAIL ANY: STOP "Failed"

```bash
rd echo --result pass
```


## 2. Optimistic
- PASS ANY: GOTO 4
- FAIL ALL: RETRY 3

```bash
rd echo --result pass
```


## 3. Empty
- PASS: CONTINUE

```bash
rd echo --result pass
```


## 4. End
- PASS: COMPLETE

```bash
rd echo --result pass
```
```


### pass-stop-transition.runbook.md

PASS leading to STOP - workflow halts on success.


**pass-stop-transition.runbook.md:**

```rundown
# PASS STOP Transition

Demonstrates PASS leading to STOP - workflow halts on success.

## 1. Setup
- PASS: CONTINUE
- FAIL: STOP

Prepare the environment.

```bash
rd echo "setup environment"
```


## 2. Execute
- PASS: STOP "Check passed, halting workflow"
- FAIL: CONTINUE

Execute the critical check.

```bash
rd echo "critical check"
```


## 3. Cleanup
- PASS: COMPLETE
- FAIL: STOP

This step only runs if Execute failed.

```bash
rd echo "cleanup resources"
```
```


### fail-continue-transition.runbook.md

FAIL leading to CONTINUE - proceed despite failure.


**fail-continue-transition.runbook.md:**

```rundown
# FAIL CONTINUE Transition

Demonstrates FAIL leading to CONTINUE - proceed despite failure.

## 1. Setup
- PASS: CONTINUE
- FAIL: STOP

Prepare the environment.

```bash
rd echo "setup environment"
```


## 2. Execute
- PASS: CONTINUE
- FAIL: CONTINUE

Non-critical step that may fail.

```bash
rd echo "execute non-critical task" --result fail
```


## 3. Cleanup
- PASS: COMPLETE
- FAIL: STOP

Always runs regardless of Execute result.

```bash
rd echo "cleanup resources"
```
```


### fail-complete-transition.runbook.md

FAIL leading to COMPLETE - workflow completes on failure.


**fail-complete-transition.runbook.md:**

```rundown
# FAIL COMPLETE Transition

Demonstrates FAIL leading to COMPLETE - workflow completes on failure.

## 1. Setup
- PASS: CONTINUE
- FAIL: STOP

Prepare the environment.

```bash
rd echo "setup environment"
```


## 2. Execute
- PASS: CONTINUE
- FAIL: COMPLETE "Early exit condition met"

Check for early exit condition.

```bash
rd echo "check exit condition" --result fail
```


## 3. Cleanup
- PASS: COMPLETE
- FAIL: STOP

Only runs if Execute passed.

```bash
rd echo "cleanup after success"
```
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
- PASS: COMPLETE
- FAIL: RETRY 3 STOP

```bash
rd echo --result fail --result pass
```
```


### retry-counter-reset.runbook.md

Retry counter reset behavior.


**retry-counter-reset.runbook.md:**

```rundown
# Retry Counter Reset on GOTO

Tests spec rule: "GOTO resets the retry counter to 0 for the target location"

## 1. First attempt
- PASS: CONTINUE
- FAIL: RETRY 1 GOTO 2

```bash
rd echo --result fail --result fail
```


## 2. Second attempt (counter should be 0 again)
- PASS: COMPLETE
- FAIL: RETRY 1 STOP

```bash
rd echo --result fail --result pass
```
```


### retry-exhaustion-continue.runbook.md

Continue to next step on retry exhaustion.


**retry-exhaustion-continue.runbook.md:**

```rundown
# RETRY Exhaustion with CONTINUE

Tests that RETRY exhaustion triggers CONTINUE fallback action.

## 1. Flaky step
- PASS: COMPLETE
- FAIL: RETRY 1 CONTINUE

```bash
rd echo --result fail --result fail
```


## 2. Fallback step
- PASS: COMPLETE

```bash
rd echo --result pass
```
```


### retry-exhaustion-done.runbook.md

Mark done on retry exhaustion.


**retry-exhaustion-done.runbook.md:**

```rundown
# RETRY Exhaustion with COMPLETE

Tests that RETRY exhaustion triggers COMPLETE fallback action.

## 1. Flaky step
- PASS: CONTINUE
- FAIL: RETRY 1 COMPLETE

```bash
rd echo --result fail --result fail
```
```


### retry-exhaustion-goto.runbook.md

GOTO on retry exhaustion.


**retry-exhaustion-goto.runbook.md:**

```rundown
# RETRY Exhaustion with GOTO

Tests that RETRY exhaustion triggers GOTO fallback action.

## 1. Flaky step
- PASS: CONTINUE
- FAIL: RETRY 2 GOTO 3

```bash
rd echo --result fail --result fail --result fail
```


## 2. Skip
- PASS: COMPLETE

```bash
rd echo --result pass
```


## 3. Recovery step
- PASS: COMPLETE

```bash
rd echo --result pass
```
```


### retry-exhaustion-complete.runbook.md

COMPLETE on retry exhaustion.


**retry-exhaustion-complete.runbook.md:**

```rundown
# Retry Exhaustion COMPLETE

Demonstrates RETRY with COMPLETE on exhaustion.

## 1. Setup
- PASS: CONTINUE
- FAIL: STOP

Prepare the environment.

```bash
rd echo "setup environment"
```


## 2. Execute
- PASS: CONTINUE
- FAIL: RETRY 3 COMPLETE "Max retries reached, completing anyway"

Retry up to 3 times, then complete successfully.

```bash
rd echo "retry operation" --result fail --result fail --result pass
```


## 3. Cleanup
- PASS: COMPLETE
- FAIL: STOP

Final cleanup.

```bash
rd echo "cleanup resources"
```
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
# Mixed Prompt Types

## 1. Mixed prompts
- PASS: CONTINUE
- FAIL: STOP


**Prompt:** Explicit prompt.
- Implicit instruction 1
- Implicit instruction 2
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
Execute.

## 2. Second Step
Process.
```


### list-instructions.runbook.md

List-based step instructions.


**list-instructions.runbook.md:**

```rundown
# List Instructions

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

## Mixed Patterns

Complex patterns combining multiple features.

### mixed-static-named-error.runbook.md

Static steps with a named error handler step.


**mixed-static-named-error.runbook.md:**

```rundown
# Mixed Static And Named With Error Handler

Demonstrates static steps with a named error handler step.

## 1. Setup
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Prepare the environment.

```bash
rd echo "setup environment"
```


## 2. Execute
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Execute the main task.

```bash
rd echo "execute task"
```


## 3. Cleanup
- PASS: COMPLETE
- FAIL: GOTO ErrorHandler

Final cleanup.

```bash
rd echo "cleanup resources"
```


## ErrorHandler
- PASS: GOTO 1
- FAIL: STOP "Unrecoverable error"

Central error handling step.

```bash
rd echo "handle error"
```
```


### mixed-dynamic-named-recovery.runbook.md

Dynamic iteration with a named recovery step.


**mixed-dynamic-named-recovery.runbook.md:**

```rundown
# Mixed Dynamic And Named With Recovery

Demonstrates dynamic iteration with a named recovery step.

## {N}. Process Item
- PASS: GOTO NEXT
- FAIL: GOTO Recovery

Process each item.

```bash
rd echo "process item"
```



## Recovery
- PASS: GOTO {N}
- FAIL: STOP "Recovery failed"

Handle processing failures and resume iteration.

```bash
rd echo "recovery action"
```
```


---

## Other

Additional workflow patterns.

### workflow-composition.runbook.md

Parent workflow delegating to child workflows.


**workflow-composition.runbook.md:**

```rundown
## 1. Verify
- FAIL ANY: STOP "Verification failed"
- lint.runbook.md
- types.runbook.md
- tests.runbook.md
```


### code-blocks.runbook.md

Various code block patterns in workflows.


**code-blocks.runbook.md:**

```rundown
# Code Blocks

Demonstrates various code block patterns in workflows.

## 1. Setup
- PASS: CONTINUE
- FAIL: STOP

Setup with bash command.

```bash
rd echo "setup environment"
```


## 2. Execute
- PASS: CONTINUE
- FAIL: STOP

Execute with multiple commands.

```bash
rd echo "Starting execution"
rd echo "run main task"
```


## 3. Validate
- PASS: COMPLETE
- FAIL: STOP

Validate with conditional.

```bash
rd echo "Validating..."
rd echo "validate results"
```
```


---

## See Also

- [MATRIX.md](./MATRIX.md) - Complete coverage matrix (48 patterns)
- [SPEC.md](../../docs/SPEC.md) - Full specification
- [FORMAT.md](../../docs/FORMAT.md) - BNF grammar
