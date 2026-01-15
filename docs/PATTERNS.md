<!-- GENERATED FILE - DO NOT EDIT DIRECTLY -->
<!-- Source: runbooks/patterns/INDEX.md -->
<!-- Regenerate: npm run docs:patterns -->

# Rundown Patterns

Common patterns for Rundown runbooks. See [MATRIX.md](./MATRIX.md) for complete coverage matrix and [SPEC.md](../../docs/SPEC.md) for syntax reference.

## Scenario Naming Taxonomy

To ensure clarity and consistency across all pattern examples, we follow a holistic naming strategy where the **filename** and **scenario name** work together to describe the intent.

### Holistic Strategy

1.  **The "Default" Rule**: If a runbook demonstrates a single primary path, use `completed`. This is concise and avoids repeating words from the filename.
2.  **The "Variation" Rule**: When a runbook has multiple paths to the same result, the scenario name describes the **differentiating branch or condition** (e.g., `via-named` vs `via-static`).
3.  **The "Choice" Rule**: If the runbook centers on a specific decision point (like a failure transition), use the **action taken** as the scenario name (e.g., `continue` vs `stop`).
4.  **Remove Redundancy**: Do not include "success", "failure", or the core topic of the filename in the scenario name. The `result` field already indicates the outcome.

### Coherent Taxonomy

| Category | Scenario Name | Focus |
| :--- | :--- | :--- |
| **Simple** | `completed`, `stopped` | Standard primary outcomes. |
| **Branching** | `via-[name]`, `skipped-[name]` | Destination or path taken. |
| **Retries** | `immediate`, `after-retry` | Timing of success. |
| **Exhaustion** | `continue`, `stop`, `goto-[name]` | Action taken after retry limit reached. |
| **Dynamic** | `single`, `multiple`, `batch` | Volume of iterations. |
| **Composition** | `completed`, `agent-fails`, `child-fails` | Failure mode in delegation. |

---

## Contents

- [Sequential Runbooks](#sequential-runbooks)
- [Dynamic Steps](#dynamic-steps)
- [Named Steps](#named-steps)
- [Substeps](#substeps)
- [GOTO Navigation](#goto-navigation)
- [Transitions](#transitions)
- [Retry Behavior](#retry-behavior)
- [Prompts](#prompts)
- [Composition & Agents](#composition--agents)
- [Specific Features](#specific-features)

---

## Sequential Runbooks

Linear runbooks with numbered steps.

### standard-sequential.runbook.md

Basic numbered steps executing in order.


**standard-sequential.runbook.md:**

```rundown
---
name: standard-sequential
description: Sequential runbook with CONTINUE and RETRY transitions
tags:
  - sequential

scenarios:
  immediate:
    description: Both steps pass on first attempt
    commands:
      - rd run --prompted standard-sequential.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
  after-retry:
    description: Step 2 fails twice then passes (using retry)
    commands:
      - rd run --prompted standard-sequential.runbook.md
      - rd pass
      - rd fail
      - rd fail
      - rd pass
    result: COMPLETE
  auto-execution:
    description: Step 1 passes, step 2 fails twice then passes on retry
    commands:
      - rd run standard-sequential.runbook.md
    result: COMPLETE
---

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

### dynamic-batch.runbook.md

Batch processing with dynamic substeps.


**dynamic-batch.runbook.md:**

```rundown
---
name: dynamic-batch
description: Dynamic batch processing with {n} substep pattern for iteration

scenarios:
  single:
    description: Process one item and complete
    commands:
      - rd run --prompted dynamic-batch.runbook.md
      - rd pass
      - rd fail
    result: COMPLETE
  multiple:
    description: Process multiple items before completing
    commands:
      - rd run --prompted dynamic-batch.runbook.md
      - rd pass
      - rd pass
      - rd fail
    result: COMPLETE
tags:
  - dynamic
---

# Dynamic Batch Processing

## 1. Process Files

### 1.{n} Process Item

**Prompt:** Process item {n}.

```bash
./process.sh item_{n}.dat
```
```


### dynamic-step-next.runbook.md

Dynamic step with GOTO NEXT for iteration.


**dynamic-step-next.runbook.md:**

```rundown
---
name: dynamic-step-next
description: Tests GOTO NEXT navigation which advances to the next step in dynamic runbook

scenarios:
  stopped:
    description: Pass to advance, then fail to stop runbook
    commands:
      - rd run --prompted dynamic-step-next.runbook.md
      - rd pass
      - rd fail
    result: STOP
tags:
  - dynamic
---

# Dynamic Step With GOTO NEXT

## {N}. Process Item
- PASS: GOTO NEXT


Execute.
```


### dynamic-step-named-substep.runbook.md

Dynamic step containing a named substep.


**dynamic-step-named-substep.runbook.md:**

```rundown
---
name: dynamic-step-named-substep
description: Tests dynamic steps with custom-named substeps and GOTO navigation to named steps

scenarios:
  happy-path:
    description: Pass through substep 1 to reach named substep and complete
    commands:
      - rd run --prompted dynamic-step-named-substep.runbook.md
      - rd pass  # Substep 1 - GOTO {N}.Named
      - rd pass  # Named Substep - COMPLETE
    result: COMPLETE

  skip-substep-2:
    description: Demonstrates skipping substep 2 using GOTO to named step
    commands:
      - rd run --prompted dynamic-step-named-substep.runbook.md
      - rd pass  # Substep 1 - GOTO {N}.Named, skips substep 2
      - rd pass  # Named Substep - COMPLETE
    result: COMPLETE
tags:
  - dynamic
  - substeps
---

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
---
name: dynamic-step-dynamic-substeps
description: Demonstrates doubly-dynamic iteration with {N}.{n} pattern

scenarios:
  stopped:
    description: Runbook STOPPED on fail
    commands:
      - rd run --prompted dynamic-step-dynamic-substeps.runbook.md
      - rd fail
      - rd fail
    result: STOP
  completed:
    description: Dynamic steps and substeps COMPLETE on fail recovery
    commands:
      - rd run --prompted dynamic-step-dynamic-substeps.runbook.md
      - rd pass
      - rd pass
      - rd fail
      - rd pass
    result: COMPLETE
tags:
  - dynamic
  - substeps
---

# Dynamic Step With Dynamic Substeps

Demonstrates doubly-dynamic iteration with {N}.{n} pattern.

## {N}. Process Batch

### {N}.{n} Process Item
- PASS: GOTO NEXT
- FAIL: GOTO Cleanup

Process next item in batch.

```bash
rd echo "process item"
```

## Cleanup
- PASS: COMPLETE
- FAIL: STOP

Handle any failures.

```bash
rd echo "cleanup resources"
```
```


### dynamic-step-mixed-substeps.runbook.md

Dynamic steps with both static and named substeps.


**dynamic-step-mixed-substeps.runbook.md:**

```rundown
---
name: dynamic-step-mixed-substeps
description: Demonstrates dynamic steps with both static and named substeps

scenarios:
  recovery-fails:
    description: Recovery step fails and runbook stops
    commands:
      - rd run --prompted dynamic-step-mixed-substeps.runbook.md
      - rd fail
      - rd fail
    result: STOP
tags:
  - dynamic
  - substeps
  - mixed
---

# Dynamic Step With Mixed Substeps

Demonstrates dynamic steps with both static and named substeps.

## {N}. Process Batch

### {N}.1 Prepare
- PASS: CONTINUE
- FAIL: GOTO {N}.Recovery

Prepare batch N for processing.

```bash
rd echo "prepare batch"
```


### {N}.2 Execute
- PASS: GOTO NEXT
- FAIL: GOTO {N}.Recovery

Process the batch.

```bash
rd echo "process batch"
```


### {N}.Recovery
- PASS: GOTO NEXT
- FAIL: STOP

Handle batch processing failure.

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
---
name: named-steps
description: Demonstrates mixing numbered and named steps with GOTO error handling

scenarios:
  completed:
    description: Main runbook passes, completes successfully
    commands:
      - rd run --prompted named-steps.runbook.md
      - rd pass
    result: COMPLETE
  recovered:
    description: Main runbook fails, ErrorHandler recovers
    commands:
      - rd run --prompted named-steps.runbook.md
      - rd fail
      - rd pass
    result: STOP
tags:
  - named
---

# Named Steps Example

## 1. Main runbook
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
---
name: named-substeps
description: Demonstrates named substeps within a parent step

scenarios:
  completed:
    description: All named substeps pass
    commands:
      - rd run --prompted named-substeps.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
tags:
  - named
  - substeps
---

# Named Substeps Example

## 1. Main step
### 1.1 Prepare
Execute first action.
### 1.2 Run
Execute second action.
### 1.Cleanup Cleanup
- PASS: COMPLETE
- FAIL: STOP "Cleanup failed"

Clean up resources
```


### mixed-named-static.runbook.md

Named steps mixed with numbered steps.


**mixed-named-static.runbook.md:**

```rundown
---
name: mixed-named-static
description: Demonstrates mixing numbered static steps with named dynamic steps, showing error handling and routing patterns.
tags:
  - named
  - mixed
---

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
---
name: mixed-named-dynamic
description: Demonstrates mixed named and dynamic steps with individual recovery handlers for each iteration
tags:
  - named
  - dynamic
  - mixed
---

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


### mixed-static-named-error.runbook.md

Static steps with a named error handler step.


**mixed-static-named-error.runbook.md:**

```rundown
---
name: mixed-static-named-error
description: Demonstrates static steps with a named error handler step that redirects failures to central error handling

scenarios:
  success-path:
    description: Tests successful completion through all steps
    commands:
      - rd run --prompted mixed-static-named-error.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE

  error-recovery:
    description: Tests error handling and recovery by going back to setup
    commands:
      - rd run --prompted mixed-static-named-error.runbook.md
      - rd pass
      - rd fail
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE

  unrecoverable-error:
    description: Tests unrecoverable error that stops the runbook
    commands:
      - rd run --prompted mixed-static-named-error.runbook.md
      - rd pass
      - rd fail
      - rd fail
    result: STOP
tags:
  - named
  - mixed
  - error-handling
---

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
---
name: mixed-dynamic-named-recovery
description: Demonstrates dynamic iteration with a shared named recovery step that returns to iterate next item

scenarios:
  recovery-resumes:
    description: Process fails, recovery passes, resumes dynamic step, then fails to stop
    commands:
      - rd run --prompted mixed-dynamic-named-recovery.runbook.md
      - rd fail
      - rd pass
      - rd fail
      - rd fail
    result: STOP

  recovery-fails:
    description: Process fails, recovery fails, runbook stops
    commands:
      - rd run --prompted mixed-dynamic-named-recovery.runbook.md
      - rd fail
      - rd fail
    result: STOP
tags:
  - named
  - dynamic
  - mixed
---

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


### named-step-dynamic-substep.runbook.md

Named step containing dynamic substeps.


**named-step-dynamic-substep.runbook.md:**

```rundown
---
name: named-step-dynamic-substep
description: Demonstrates a named step containing dynamic substeps that execute until a pass condition is met.

scenarios:
  pass-on-second-attempt:
    description: Tests dynamic substeps, failing on first attempt then passing on second attempt
    commands:
      - rd run --prompted named-step-dynamic-substep.runbook.md
      - rd fail
      - rd pass
    result: COMPLETE
tags:
  - named
  - dynamic
  - substeps
---

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
---
name: named-step-static-substeps
description: Demonstrates named steps containing static numbered substeps (ErrorHandler.1, ErrorHandler.2, ErrorHandler.3).

scenarios:
  success-completes:
    description: Setup passes, runbook completes (skips ErrorHandler)
    commands:
      - rd run --prompted named-step-static-substeps.runbook.md
      - rd pass
    result: COMPLETE
  error-handler-failure-at-prepare:
    description: Tests error handler failing at first prepare step and stopping runbook
    commands:
      - rd run --prompted named-step-static-substeps.runbook.md
      - rd fail
      - rd fail
    result: STOP
tags:
  - named
  - substeps
---

# Named Step With Static Substeps

Demonstrates named steps containing numbered substeps.

## 1. Setup
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Initial setup step.

```bash
rd echo "initial setup"
```


## ErrorHandler

### ErrorHandler.1 Prepare
- PASS: CONTINUE
- FAIL: STOP

Prepare for error handling.

```bash
rd echo "prepare error handling"
```


### ErrorHandler.2 Execute
- PASS: CONTINUE
- FAIL: STOP

Execute error recovery.

```bash
rd echo "execute recovery"
```


### ErrorHandler.3 Verify
- PASS: GOTO 1
- FAIL: STOP

Verify recovery succeeded.

```bash
rd echo "verify recovery"
```
```


### named-step-named-substeps.runbook.md

Named step containing named substeps.


**named-step-named-substeps.runbook.md:**

```rundown
---
name: named-step-named-substeps
description: Demonstrates named steps containing named substeps with explicit step references (ErrorHandler.Prepare, ErrorHandler.Execute, ErrorHandler.Verify).

scenarios:
  success-completes:
    description: Setup passes, runbook completes (skips ErrorHandler)
    commands:
      - rd run --prompted named-step-named-substeps.runbook.md
      - rd pass
    result: COMPLETE
  error-handler-failure-at-prepare:
    description: Tests error handler failing at prepare stage and stopping runbook
    commands:
      - rd run --prompted named-step-named-substeps.runbook.md
      - rd fail
      - rd fail
    result: STOP
tags:
  - named
  - substeps
---

# Named Step With Named Substeps

Demonstrates named steps containing named substeps.

## 1. Setup
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Initial setup.

```bash
rd echo "initial setup"
```


## ErrorHandler

### ErrorHandler.Prepare
- PASS: GOTO ErrorHandler.Execute
- FAIL: STOP

Prepare for error handling.

```bash
rd echo "prepare error handling"
```


### ErrorHandler.Execute
- PASS: GOTO ErrorHandler.Verify
- FAIL: STOP

Execute error recovery.

```bash
rd echo "execute recovery"
```


### ErrorHandler.Verify
- PASS: GOTO 1
- FAIL: STOP

Verify recovery succeeded.

```bash
rd echo "verify recovery"
```
```


### named-step-mixed-substeps.runbook.md

Named step with both static and named substeps.


**named-step-mixed-substeps.runbook.md:**

```rundown
---
name: named-step-mixed-substeps
description: Demonstrates named steps with both numbered substeps (ErrorHandler.1) and named substeps (ErrorHandler.Cleanup).

scenarios:
  success-completes:
    description: Setup passes, runbook completes (skips ErrorHandler)
    commands:
      - rd run --prompted named-step-mixed-substeps.runbook.md
      - rd pass
    result: COMPLETE
  error-handler-failure:
    description: Tests error handler preparation step failing and stopping runbook
    commands:
      - rd run --prompted named-step-mixed-substeps.runbook.md
      - rd fail
      - rd fail
    result: STOP
tags:
  - named
  - substeps
  - mixed
---

# Named Step With Mixed Substeps

Demonstrates named steps with both static and named substeps.

## 1. Setup
- PASS: CONTINUE
- FAIL: GOTO ErrorHandler

Initial setup.

```bash
rd echo "initial setup"
```


## ErrorHandler

### ErrorHandler.1 Prepare
- PASS: CONTINUE
- FAIL: STOP

Prepare for error handling.

```bash
rd echo "prepare error handling"
```


### ErrorHandler.Cleanup
- PASS: GOTO 1
- FAIL: STOP

Named cleanup substep.

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
---
name: nested-static-substeps
description: Demonstrates static nested substeps without explicit transitions, showing hierarchical structure and implicit step completion.

scenarios:
  completed:
    description: Tests completing all static substeps in sequence
    commands:
      - rd run --prompted nested-static-substeps.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
tags:
  - substeps
---

## 1. Parent

### 1.1 Static Child
Content.

### 1.2 Another Child
Content.
```


### static-step-mixed-substeps.runbook.md

Static steps containing both numbered and named substeps.


**static-step-mixed-substeps.runbook.md:**

```rundown
---
name: static-step-mixed-substeps
description: Demonstrates static steps containing both numbered and named substeps, including dynamic step transitions.

scenarios:
  happy-path:
    description: Test successful execution through all steps
    commands:
      - rd run --prompted static-step-mixed-substeps.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE

  cleanup-failure-stops:
    description: Test error in cleanup substep stops runbook
    commands:
      - rd run --prompted static-step-mixed-substeps.runbook.md
      - rd pass
      - rd fail
    result: STOP
tags:
  - substeps
  - mixed
---

# Static Step With Mixed Substeps

Demonstrates static steps containing both numbered and named substeps.

## 1. Setup

### 1.1 Prepare
- PASS: CONTINUE
- FAIL: STOP

Prepare the environment.

```bash
rd echo "prepare environment"
```


### 1.Cleanup
- PASS: CONTINUE
- FAIL: STOP

Named cleanup substep.

```bash
rd echo "cleanup resources"
```


## 2. Execute
- PASS: COMPLETE
- FAIL: GOTO 1.Cleanup

Run the main task.

```bash
rd echo "execute main task"
```
```


---

## GOTO Navigation

Jumping between steps and substeps.

### goto-static.runbook.md

Consolidated static GOTO patterns (Step, Substep, NEXT, Named Substep).


**goto-static.runbook.md:**

```rundown
---
name: goto-static
description: Demonstrates static GOTO patterns (Step, Substep, NEXT, Named Substep)
tags:
  - navigation
  - substeps

scenarios:
  goto-step:
    description: Jump from step 1 to step 3
    commands:
      - rd run --prompted goto-static.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE

  goto-substep:
    description: Jump from substep 4.1 to 4.3
    commands:
      - rd run --prompted goto-static.runbook.md
      - rd goto 4
      - rd pass
      - rd pass
    result: COMPLETE

  goto-named-substep:
    description: Jump from 5.1 to 5.Cleanup
    commands:
      - rd run --prompted goto-static.runbook.md
      - rd goto 5
      - rd pass
      - rd pass
    result: COMPLETE
---

# Static GOTO Patterns

## 1. Step Jump
- PASS: GOTO 3
- FAIL: STOP

Please confirm to jump to step 3.

```bash
rd echo "jump start"
```

## 2. Skipped Step
- PASS: CONTINUE
- FAIL: STOP

This step should be skipped.

```bash
rd echo --result fail
```

## 3. Jump Target
- PASS: COMPLETE

Target of step jump.

```bash
rd echo "jump landed"
```

## 4. Substep Jump

### 4.1 Start
- PASS: GOTO 4.3
- FAIL: STOP

Please confirm to jump to substep 4.3.

```bash
rd echo "substep start"
```

### 4.2 Skipped
- PASS: CONTINUE

```bash
rd echo --result fail
```

### 4.3 Target
- PASS: COMPLETE

```bash
rd echo "substep landed"
```

## 5. Named Substep Jump

### 5.1 Start
- PASS: GOTO 5.Cleanup
- FAIL: STOP

Please confirm to jump to the cleanup substep.

Jumps to a named substep in the same step.

```bash
rd echo "named start"
```

### 5.Cleanup
- PASS: COMPLETE

Target named substep.

```bash
rd echo "cleanup"
```
```


### goto-named.runbook.md

Consolidated named GOTO patterns.


**goto-named.runbook.md:**

```rundown
---
name: goto-named
description: Demonstrates GOTO patterns involving named steps (Name->Name, Name->Static, Static->Name)
tags:
  - navigation

scenarios:
  named-to-named:
    description: Jump from Initialize to Cleanup (Name -> Name)
    commands:
      - rd run --prompted goto-named.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE

  named-to-static:
    description: Jump from Process to Step 1 (Name -> Static)
    commands:
      - rd run --prompted goto-named.runbook.md
      - rd goto Process
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE

  static-to-named:
    description: Jump from Step 1 to Cleanup (Static -> Name)
    commands:
      - rd run --prompted goto-named.runbook.md
      - rd goto 1
      - rd pass
      - rd pass
    result: COMPLETE
---

# Named GOTO Patterns

## Initialize
- PASS: GOTO Cleanup
- FAIL: STOP

Please initialize.

Tests GOTO Name -> Name.

```bash
rd echo "initialize"
```

## Process
- PASS: GOTO 1
- FAIL: STOP

Please process.

Tests GOTO Name -> Static.

```bash
rd echo "process"
```

## 1. Static Step
- PASS: GOTO Cleanup
- FAIL: STOP

Tests GOTO Static -> Name.

```bash
rd echo "static step"
```

## Cleanup
- PASS: COMPLETE
- FAIL: STOP

Target for jumps.

```bash
rd echo "cleanup"
```
```


### goto-dynamic-substep.runbook.md

GOTO within dynamic substeps.


**goto-dynamic-substep.runbook.md:**

```rundown
---
name: goto-dynamic-substep
description: Demonstrates GOTO {N}.M - jumping within a dynamic step instance

scenarios:
  iterate-then-stop:
    description: First task GOTOs to final task, GOTO NEXT iterates, then fails to stop
    commands:
      - rd run --prompted goto-dynamic-substep.runbook.md
      - rd pass
      - rd pass
      - rd fail
    result: STOP
tags:
  - navigation
  - dynamic
  - substeps
---

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
- PASS: CONTINUE
- FAIL: STOP

This task is skipped via GOTO.

```bash
rd echo --result fail
```


### {N}.3 Final task
- PASS: GOTO NEXT
- FAIL: STOP

Reached via GOTO from {N}.1.

```bash
rd echo --result pass
```
```


### goto-dynamic-substep-from-named.runbook.md

GOTO dynamic substep from a named step.


**goto-dynamic-substep-from-named.runbook.md:**

```rundown
---
name: goto-dynamic-substep-from-named
description: Demonstrates GOTO {N}.Name - jumping to a named substep within a dynamic step

scenarios:
  cleanup-failure:
    description: Cleanup substep fails causing runbook to stop
    commands:
      - rd run --prompted goto-dynamic-substep-from-named.runbook.md
      - rd pass
      - rd fail
      - rd fail
    result: STOP
tags:
  - navigation
  - dynamic
  - substeps
---

# GOTO Dynamic Named Substep

Demonstrates `GOTO {N}.Name` - jumping to a named substep within a dynamic step.

## {N}. Process Item

### {N}.Validate
- PASS: CONTINUE
- FAIL: GOTO {N}.Cleanup

Validate the current item.

### {N}.Execute
- PASS: GOTO NEXT
- FAIL: GOTO {N}.Cleanup

Execute processing for validated item.

### {N}.Cleanup
- PASS: GOTO NEXT
- FAIL: STOP

Clean up after validation or execution failure.
```


### dynamic-navigation.runbook.md

Navigation between dynamic step instances.


**dynamic-navigation.runbook.md:**

```rundown
---
name: dynamic-navigation
description: Dynamic step navigation with conditional flow control and GOTO patterns

scenarios:
  single:
    description: Process one iteration then stop via fail
    commands:
      - rd run --prompted dynamic-navigation.runbook.md
      - rd pass
      - rd pass
      - rd fail
    result: STOP
  multiple:
    description: Process two iterations then stop via fail
    commands:
      - rd run --prompted dynamic-navigation.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
      - rd fail
    result: STOP
tags:
  - navigation
  - dynamic
---

# Dynamic Step Navigation

## {N}. Process Item

### {N}.1 Prepare
- PASS: GOTO {N}.2

Execute.

### {N}.2 Run
- PASS: GOTO NEXT

Execute.
```


### goto-current-dynamic-substep.runbook.md

GOTO X.{n} - jumping to a specific substep in the current dynamic sequence.


**goto-current-dynamic-substep.runbook.md:**

```rundown
---
name: goto-current-dynamic-substep
description: Demonstrates GOTO X.{n} - jumping to the current instance of a dynamic substep

scenarios:
  error-handler-fails:
    description: Error handler fails and runbook stops
    commands:
      - rd run --prompted goto-current-dynamic-substep.runbook.md
      - rd fail
      - rd fail
    result: STOP
tags:
  - navigation
  - dynamic
  - substeps
---

# GOTO Current Dynamic Substep

Demonstrates `GOTO X.{n}` - referencing the current dynamic substep instance within a step.

## 1. Process Items

### 1.{n} Handle Item
- PASS: GOTO NEXT
- FAIL: GOTO ErrorHandler

Process each item in sequence.

## ErrorHandler
- PASS: GOTO 1.{n}
- FAIL: STOP

Handle errors and resume at current item.
```


### goto-dynamic-step-alone.runbook.md

GOTO {N} self-loop or infinite retry pattern.


**goto-dynamic-step-alone.runbook.md:**

```rundown
---
name: goto-dynamic-step-alone
description: Demonstrates infinite retry pattern where FAIL causes step to restart (GOTO {N}) and only PASS exits the runbook

scenarios:
  retry-until-pass:
    description: Retries on fail until pass, then completes
    commands:
      - rd run --prompted goto-dynamic-step-alone.runbook.md
      - rd fail
      - rd pass
    result: COMPLETE
tags:
  - navigation
  - dynamic
---

# GOTO Dynamic Step

Demonstrates infinite retry pattern. The step restarts on FAIL and only
exits on PASS (defaults to CONTINUE). Use for operations that should retry
indefinitely until an external condition causes failure.

## {N}. Dynamic
- FAIL: GOTO {N}

```bash
rd echo --result fail --result fail --result fail --result fail --result pass
```
```


### goto-next-qualified-step.runbook.md

GOTO NEXT {N} - explicit iteration to next dynamic step.


**goto-next-qualified-step.runbook.md:**

```rundown
---
name: goto-next-qualified-step
description: Demonstrates explicitly advancing to the next step instance using GOTO NEXT syntax for step-level navigation

scenarios:
  error-handler-failure:
    description: Error handler fails to recover, runbook stops
    commands:
      - rd run --prompted goto-next-qualified-step.runbook.md
      - rd fail
      - rd fail
    result: STOP
tags:
  - navigation
---

# GOTO NEXT {N} - Explicit Step Advancement

Demonstrates explicitly advancing to next step instance from anywhere.

## {N}. Main Loop
- PASS: GOTO NEXT
- FAIL: GOTO ErrorHandler

```bash
rd echo --result pass --result fail
```


## ErrorHandler
- PASS: GOTO NEXT {N}
- FAIL: STOP

Handles errors and returns to main loop.

```bash
rd echo --result pass
```
```


### goto-next-qualified-substep.runbook.md

GOTO NEXT X.{n} - explicit iteration to next dynamic substep.


**goto-next-qualified-substep.runbook.md:**

```rundown
---
name: goto-next-qualified-substep
description: Demonstrates explicitly advancing to the next dynamic substep using GOTO NEXT X.{n} syntax for substep-level navigation

scenarios:
  item-failure:
    description: Processing item fails and stops runbook
    commands:
      - rd run --prompted goto-next-qualified-substep.runbook.md
      - rd fail
    result: STOP
tags:
  - navigation
  - substeps
---

# GOTO NEXT X.{n} - Explicit Substep Advancement

Demonstrates explicitly advancing dynamic substep.

## 1. Static Step with Dynamic Substeps

### 1.{n} Process Item
- PASS: GOTO NEXT 1.{n}
- FAIL: STOP

```bash
rd echo --result pass --result fail
```
```


### goto-restart-dynamic.runbook.md

Restarting a dynamic sequence.


**goto-restart-dynamic.runbook.md:**

```rundown
---
name: goto-restart-dynamic
description: Demonstrates restarting the current dynamic step from the beginning using GOTO {N}

scenarios:
  iterate-then-stop:
    description: Setup and Execute pass, GOTO NEXT advances, then fail stops
    commands:
      - rd run --prompted goto-restart-dynamic.runbook.md
      - rd pass
      - rd pass
      - rd fail
    result: STOP
tags:
  - navigation
  - dynamic
---

# GOTO {N} - Restart Dynamic Instance

Demonstrates restarting the current dynamic step from the beginning.

## {N}. Process Item

### {N}.1 Setup
- PASS: CONTINUE

```bash
rd echo --result pass
```


### {N}.2 Execute
- PASS: GOTO NEXT
- FAIL: GOTO {N}

```bash
rd echo --result pass --result fail
```
```


### goto-resume-dynamic-substep.runbook.md

Resuming execution within a dynamic substep context.


**goto-resume-dynamic-substep.runbook.md:**

```rundown
---
name: goto-resume-dynamic-substep
description: Demonstrates error recovery that resumes at the exact dynamic substep where the error occurred
tags:
  - navigation
  - dynamic
  - substeps
---

# GOTO {N}.{n} - Resume at Current Context

Demonstrates error recovery that returns to exactly where we came from.

Use case: Processing items in batches. When an item fails, we jump to
ErrorHandler. After recovery, we either:
- Resume the same item (GOTO {N}.{n})
- Skip to next item (GOTO NEXT {N}.{n})

## {N}. Process Batch

### {N}.{n} Handle Item
- PASS: GOTO NEXT {N}.{n}
- FAIL: GOTO ErrorHandler

Process the current item in the current batch.

```bash
rd echo --result pass --result fail
```


## ErrorHandler
- PASS: GOTO {N}.{n}
- FAIL: GOTO NEXT {N}.{n}

Attempt to recover from the failure.
Runtime tracks which {N} and {n} we came from.

```bash
rd echo --result pass --result fail
```
```


---

## Transitions

PASS/FAIL logic and state transitions.

### default-transitions.runbook.md

Default PASS/FAIL behavior.


**default-transitions.runbook.md:**

```rundown
---
name: default-transitions
description: Tests implicit PASS to CONTINUE and FAIL to STOP when no transitions defined
tags:
  - transition

scenarios:
  completed:
    description: Both steps pass with implicit transitions
    commands:
      - rd run --prompted default-transitions.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
  stopped:
    description: First step fails, runbook stops due to implicit FAIL to STOP
    commands:
      - rd run --prompted default-transitions.runbook.md
      - rd fail
    result: STOP
  auto-execution:
    description: Both steps pass with implicit default transitions
    commands:
      - rd run default-transitions.runbook.md
    result: COMPLETE
---

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
---
name: complex-transitions
description: Demonstrates complex transition conditions with ALL/ANY modifiers
tags:
  - transition

scenarios:
  completed:
    description: All steps pass through to completion
    commands:
      - rd run --prompted complex-transitions.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
  auto-execution:
    description: Step 1 passes, step 2 passes and GOTOs to step 4, which completes
    commands:
      - rd run complex-transitions.runbook.md
    result: COMPLETE
---

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


### transition-actions.runbook.md

Explicit transition actions (STOP, CONTINUE, COMPLETE).


**transition-actions.runbook.md:**

```rundown
---
name: transition-actions
description: Demonstrates explicit transition actions (STOP, CONTINUE, COMPLETE)
tags:
  - transition

scenarios:
  pass-stop:
    description: PASS triggers STOP, runbook halts successfully
    commands:
      - rd run --prompted transition-actions.runbook.md
      - rd pass
    result: STOP

  fail-continue:
    description: FAIL triggers CONTINUE, runbook proceeds to next step
    commands:
      - rd run --prompted transition-actions.runbook.md
      - rd goto 2
      - rd fail
      - rd pass
    result: COMPLETE

  fail-complete:
    description: FAIL triggers COMPLETE, runbook finishes successfully
    commands:
      - rd run --prompted transition-actions.runbook.md
      - rd goto 4
      - rd fail
    result: COMPLETE
---

# Transition Actions

Demonstrates explicit actions for PASS and FAIL transitions.

## 1. PASS STOP
- PASS: STOP "Runbook halted on success"
- FAIL: CONTINUE

Stops the runbook immediately if the step passes.

```bash
rd echo "critical check"
```

## 2. FAIL CONTINUE
- PASS: COMPLETE
- FAIL: CONTINUE

Proceeds to the next step even if this step fails.
"Best effort" execution.

```bash
rd echo "optional step"
```

## 3. Cleanup (for FAIL CONTINUE)
- PASS: COMPLETE

Executes after Step 2, even if Step 2 failed.

```bash
rd echo "cleanup"
```

## 4. FAIL COMPLETE
- PASS: CONTINUE
- FAIL: COMPLETE "Completed with warnings"

Completes the runbook if the step fails.
Useful for "early exit success" or "handled failure".

```bash
rd echo "check condition"
```
```


### substep-transitions.runbook.md

Transition logic for substeps.


**substep-transitions.runbook.md:**

```rundown
---
name: substep-transitions
description: Tests discrete transitions and navigation at the substep level, including conditional branching with GOTO and error handling with retries.

scenarios:
  completed:
    description: Tests successful completion through branch point
    commands:
      - rd run --prompted substep-transitions.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
  after-retry:
    description: Tests retry behavior when initial step fails
    commands:
      - rd run --prompted substep-transitions.runbook.md
      - rd fail
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
  via-branch:
    description: Tests GOTO transition to skip alternative path
    commands:
      - rd run --prompted substep-transitions.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
tags:
  - transition
  - substeps
---

# Substep Transitions Conformance
Tests discrete transitions and navigation at the substep level.

## 1. Complex Parent

### 1.1 Initial
- PASS: CONTINUE
- FAIL: RETRY 2 STOP

Do first thing.
```bash
rd echo --result pass
```

### 1.2 Branch point
- YES: GOTO 1.4
- NO: CONTINUE

Ask a question.
```bash
rd echo --result pass
```

### 1.3 Alternative path
- PASS: CONTINUE

Should be skipped if YES.
```bash
rd echo --result pass
```

### 1.4 Target
- PASS: CONTINUE

Reached via GOTO or CONTINUE.
```bash
rd echo --result pass
```
```


### dynamic-substep-transitions.runbook.md

Transitions with dynamic substeps.


**dynamic-substep-transitions.runbook.md:**

```rundown
---
name: dynamic-substep-transitions
description: Tests navigation transitions in dynamic substeps with GOTO NEXT and STOP conditions

scenarios:
  fail-with-stop:
    description: Fail task to stop runbook with error message
    commands:
      - rd run --prompted dynamic-substep-transitions.runbook.md
      - rd fail
    result: STOP
tags:
  - transition
  - dynamic
  - substeps
---

# Dynamic Substep Transitions
Tests navigation in dynamic context.

## {N}. Dynamic Template

### {N}.1 Task
- PASS: GOTO NEXT
- FAIL: STOP "Dynamic failure"

Process item.
```


---

## Retry Behavior

Retry logic and exhaustion handling.

### retry-success.runbook.md

Basic retry until success.


**retry-success.runbook.md:**

```rundown
---
name: retry-success
description: Tests that RETRY succeeds before count is exhausted
tags:
  - retries

scenarios:
  immediate:
    description: Step passes on first attempt
    commands:
      - rd run --prompted retry-success.runbook.md
      - rd pass
    result: COMPLETE
  after-retry:
    description: Fails first, succeeds on retry
    commands:
      - rd run --prompted retry-success.runbook.md
      - rd fail
      - rd pass
    result: COMPLETE
  auto-execution:
    description: Code block auto-executes - fails once then passes on retry
    commands:
      - rd run retry-success.runbook.md
    result: COMPLETE
---

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
---
name: retry-counter-reset
description: Tests that GOTO resets the retry counter to 0 for the target location
tags:
  - retries

scenarios:
  after-retry:
    description: First step exhausts retry then GOTOs to step 2, which retries and succeeds
    commands:
      - rd run --prompted retry-counter-reset.runbook.md
      - rd fail
      - rd fail
      - rd fail
      - rd pass
    result: COMPLETE
  auto-execution:
    description: Code blocks auto-execute - step 1 fails twice, GOTOs step 2, which retries once then passes
    commands:
      - rd run retry-counter-reset.runbook.md
    result: COMPLETE
---

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


### retry-exhaustion.runbook.md

Consolidated patterns for retry exhaustion (CONTINUE, STOP, GOTO, COMPLETE).


**retry-exhaustion.runbook.md:**

```rundown
---
name: retry-exhaustion
description: Demonstrates various RETRY exhaustion behaviors (CONTINUE, STOP, GOTO, COMPLETE)
tags:
  - retries

scenarios:
  continue:
    description: Exhaustion triggers CONTINUE, proceeds to next step
    commands:
      - rd run --prompted retry-exhaustion.runbook.md
      - rd fail
      - rd fail
      - rd pass
    result: COMPLETE

  stop:
    description: Exhaustion triggers STOP (default or explicit), runbook halts
    commands:
      - rd run --prompted retry-exhaustion.runbook.md
      - rd goto 2
      - rd fail
      - rd fail
    result: STOP

  goto:
    description: Exhaustion triggers GOTO, jumps to recovery step
    commands:
      - rd run --prompted retry-exhaustion.runbook.md
      - rd goto 3
      - rd fail
      - rd fail
      - rd fail
      - rd pass
    result: COMPLETE

  complete:
    description: Exhaustion triggers COMPLETE, runbook finishes immediately
    commands:
      - rd run --prompted retry-exhaustion.runbook.md
      - rd goto 5
      - rd pass
      - rd fail
      - rd fail
      - rd fail
      - rd fail
    result: COMPLETE
---

# RETRY Exhaustion Patterns

Demonstrates different behaviors when a step exhausts its retry count.

## 1. Exhaustion CONTINUE
- PASS: COMPLETE
- FAIL: RETRY 1 CONTINUE

Fails initially, retries once. If it fails again, it CONTINUES to the next step.
This allows "best effort" steps.

```bash
rd echo --result fail --result fail
```

## 2. Exhaustion STOP
- PASS: COMPLETE
- FAIL: RETRY 1 STOP

Fails initially, retries once. If it fails again, it STOPS the runbook.
This is for critical steps that must succeed eventually.

```bash
rd echo --result fail --result fail
```

## 3. Exhaustion GOTO
- PASS: COMPLETE
- FAIL: RETRY 2 GOTO 4

Fails up to 2 times. If it exhausts, it jumps to the Recovery step.

```bash
rd echo --result fail --result fail --result fail
```

## 4. Recovery
- PASS: COMPLETE

Recovery step reached from Step 3 exhaustion.

```bash
rd echo "recovered"
```

## 5. Exhaustion COMPLETE
- PASS: CONTINUE
- FAIL: RETRY 3 COMPLETE "Max retries reached, completing anyway"

Retries up to 3 times. If it still fails, it COMPLETES the runbook (success state).
Useful if the failure is acceptable as a final state.

```bash
rd echo "retry operation" --result fail --result fail --result pass
```
```


---

## Prompts

User prompts and input handling.

### prompted-steps.runbook.md

Steps with user prompts.


**prompted-steps.runbook.md:**

```rundown
---
name: prompted-steps
description: Steps with explicit and implicit prompt definitions

scenarios:
  completed:
    description: All steps pass successfully
    commands:
      - rd run --prompted prompted-steps.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
tags:
  - prompts
---

## 1. Step with prompt
**Prompt:** Please review the code.

## 2. Step with implicit prompt
Review this instead.
```


### mixed-prompts.runbook.md

Different prompt types in one runbook.


**mixed-prompts.runbook.md:**

```rundown
---
name: mixed-prompts
description: Step with both explicit Prompt and implicit instruction list

scenarios:
  completed:
    description: All prompt types pass successfully
    commands:
      - rd run --prompted mixed-prompts.runbook.md
      - rd pass
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
tags:
  - prompts
  - mixed
---

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
---
name: yes-no-aliases
description: Tests that YES/NO work as aliases for PASS/FAIL

scenarios:
  completed:
    description: User confirms with YES, runbook continues
    commands:
      - rd run --prompted yes-no-aliases.runbook.md
      - rd pass
    result: COMPLETE
  stopped:
    description: User declines with NO, runbook stops
    commands:
      - rd run --prompted yes-no-aliases.runbook.md
      - rd fail
    result: STOP
tags:
  - prompts
---

# YES/NO Aliases

Test that YES/NO work as aliases for PASS/FAIL.

## 1. Prompt step
- YES: CONTINUE
- NO: STOP "Verification failed"

Did you verify the deployment?
```


### prompt-code-block.runbook.md

Code blocks with `prompt` info string (displayed but not executed).


**prompt-code-block.runbook.md:**

```rundown
---
name: prompt-code-block
description: Demonstrates prompt code blocks (instructional, never executed)

scenarios:
  basic:
    commands:
      - rd run --prompted prompt-code-block.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
tags:
  - prompts
---

# Prompt Code Blocks

Demonstrates using the `prompt` info string to create instructional code blocks
that are output but never executed.

## 1. JSON Configuration
- PASS: CONTINUE

Display configuration template for user reference.

```json prompt
{
  "apiKey": "your-api-key-here",
  "endpoint": "https://api.example.com"
}
```

## 2. Bash Example
- PASS: COMPLETE

Show a bash command without executing it.

```bash prompt
curl -X POST https://api.example.com/webhook \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"event": "deploy"}'
```
```


---

## Composition & Agents

Parent runbooks, agents, and delegation.

### runbook-composition.runbook.md

Parent runbook delegating to child runbooks.


**runbook-composition.runbook.md:**

```rundown
---
name: workflow-composition
description: Demonstrates composing multiple child workflows to verify lint, types, and tests all pass

scenarios:
  completed:
    description: Tests successful completion when all child workflows pass
    commands:
      - rd run --prompted workflow-composition.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE

  child-fails:
    description: Tests failure when a child workflow fails
    commands:
      - rd run --prompted workflow-composition.runbook.md
      - rd fail
    result: STOP
tags:
  - composition
---

## 1. Verify
- FAIL ANY: STOP "Verification failed"
- lint.runbook.md
- types.runbook.md
- tests.runbook.md
```


### substep-runbooks.runbook.md

Runbook references within substeps.


**substep-runbooks.runbook.md:**

```rundown
---
name: substep-runbooks
description: Demonstrates runbook references within substeps

scenarios:
  basic:
    description: Tests successful execution of child runbooks referenced within substeps
    commands:
      - rd run --prompted substep-runbooks.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
tags:
  - composition
  - substeps
---

# Substep Runbooks

Demonstrates referencing runbooks within substeps instead of at the step level.

## 1. Verification Suite

### 1.1 Lint Check
- FAIL ANY: STOP "Lint failed"

- child-task.runbook.md

### 1.2 Type Check
- FAIL ANY: STOP "Types failed"

- child-task.runbook.md
```


### agent-binding-simple.runbook.md

Basic agent delegation.


**agent-binding-simple.runbook.md:**

```rundown
---
name: agent-binding-simple
description: Parent runbook delegates step to agent with child runbook
tags:
  - composition

scenarios:
  completed:
    description: Agent binds and completes child runbook
    commands:
      - rd run --prompted agent-binding-simple.runbook.md
      - rd run --step 1 agent-binding-simple.runbook.md
      - rd run --agent agent-1
      - rd pass --agent agent-1
      - rd pass
    result: COMPLETE
---

# Agent Binding - Simple

Demonstrates parent runbook delegating to an agent.

## 1. Delegate to Agent
- PASS: COMPLETE
- FAIL: STOP

Please delegate this task to an agent.

- child-task.runbook.md
```


### agent-binding-failure.runbook.md

Handling failure in agent delegation.


**agent-binding-failure.runbook.md:**

```rundown
---
name: agent-binding-failure
description: Parent handles agent failure gracefully
tags:
  - composition
  - error-handling

scenarios:
  agent-fails:
    description: Agent fails, parent handles via GOTO
    commands:
      - rd run --prompted agent-binding-failure.runbook.md
      - rd run --step 1 agent-binding-failure.runbook.md
      - rd run --agent agent-1
      - rd fail --agent agent-1
      - rd pass
      - rd pass
    result: COMPLETE
---

# Agent Binding - Failure Handling

## 1. Delegate to Agent
- PASS: COMPLETE
- FAIL: GOTO Cleanup

Please delegate this task to an agent. We expect it to fail to test recovery.

- child-task.runbook.md

## Cleanup
- PASS: COMPLETE
- FAIL: STOP

Handle failure gracefully.
```


### multi-agent-dynamic.runbook.md

Multiple agents in a dynamic runbook loop.


**multi-agent-dynamic.runbook.md:**

```rundown
---
name: multi-agent-dynamic
description: Multiple agents work on different runbooks with dynamic iteration

scenarios:
  two-agents-cycle:
    description: Two agents complete one iteration then finalize
    commands:
      - rd run --prompted multi-agent-dynamic.runbook.md
      - rd run --step 1.1 agent-task-lint.runbook.md
      - rd run --agent lint-agent
      - rd pass --agent lint-agent
      - rd run --step 1.2 agent-task-test.runbook.md
      - rd run --agent test-agent
      - rd pass --agent test-agent
      - rd fail
      - rd pass
    result: COMPLETE
tags:
  - composition
  - dynamic
---

# Multi-Agent Dynamic Runbook

Demonstrates multiple agents working on different runbooks with dynamic iteration.

## {N}. Process Work Items

- PASS: GOTO NEXT
- FAIL: GOTO Finalize

### {N}.1 Lint Agent

- PASS: CONTINUE
- FAIL: STOP

- agent-task-lint.runbook.md

### {N}.2 Test Agent

- PASS: CONTINUE
- FAIL: STOP

- agent-task-test.runbook.md

## Finalize

- PASS: COMPLETE
- FAIL: STOP

All agents completed their work.
```


### agent-task-lint.runbook.md

Helper runbook for linting tasks (used in composition tests).


**agent-task-lint.runbook.md:**

```rundown
---
name: agent-task-lint
description: Lint task for agent
scenarios:
  completed:
    description: Lint passes
    commands:
      - rd run --prompted agent-task-lint.runbook.md
      - rd pass
    result: COMPLETE
  failure:
    description: Lint task fails
    commands:
      - rd run --prompted agent-task-lint.runbook.md
      - rd fail
    result: STOP
tags:
  - composition
---

# Lint Task

## 1. Run Linter

- PASS: COMPLETE
- FAIL: STOP

Execute lint checks.
```


### agent-task-test.runbook.md

Helper runbook for testing tasks (used in composition tests).


**agent-task-test.runbook.md:**

```rundown
---
name: agent-task-test
description: Test task for agent
scenarios:
  completed:
    description: Tests pass
    commands:
      - rd run --prompted agent-task-test.runbook.md
      - rd pass
    result: COMPLETE
  failure:
    description: Test task fails
    commands:
      - rd run --prompted agent-task-test.runbook.md
      - rd fail
    result: STOP
tags:
  - composition
---

# Test Task

## 1. Run Tests

- PASS: COMPLETE
- FAIL: STOP

Execute test suite.
```


### child-task.runbook.md

Helper child runbook (used in composition tests).


**child-task.runbook.md:**

```rundown
---
name: child-task
description: Simple child runbook for sub-runbook patterns

scenarios:
  basic:
    description: Basic child runbook execution
    commands:
      - rd run --prompted child-task.runbook.md
      - rd pass
    result: COMPLETE
tags:
  - composition
---

# Child Task

## 1. Execute Task

- PASS: COMPLETE
- FAIL: STOP

Execute child runbook task.
```


---

## Specific Features

Additional specific functionality.

### action-messages.runbook.md

STOP and COMPLETE with custom messages.


**action-messages.runbook.md:**

```rundown
---
name: action-messages
description: Demonstrates STOP and COMPLETE with message parameters

scenarios:
  complete-with-message:
    commands:
      - rd run --prompted action-messages.runbook.md
      - rd pass
    result: COMPLETE
tags:
  - features
---

# Action Messages

Shows STOP/COMPLETE with descriptive messages.

## 1. Check Status

- PASS: COMPLETE "Setup completed successfully"
- FAIL: STOP "Setup failed - check prerequisites"

Verify system is ready.
```


### code-blocks.runbook.md

Various code block patterns in runbooks.


**code-blocks.runbook.md:**

```rundown
---
name: code-blocks
description: Demonstrates various code block patterns in runbooks
tags:
  - features

scenarios:
  completed:
    description: Multiple code blocks are rendered correctly
    commands:
      - rd run --prompted code-blocks.runbook.md
      - rd pass
      - rd pass
      - rd pass
    result: COMPLETE
  auto-execution:
    description: All three steps with bash code blocks pass immediately
    commands:
      - rd run code-blocks.runbook.md
    result: COMPLETE
---

# Code Blocks

Demonstrates various code block patterns in runbooks.

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


### list-instructions.runbook.md

List-based step instructions.


**list-instructions.runbook.md:**

```rundown
---
name: list-instructions
description: Demonstrates steps with list-formatted instructions
tags:
  - features

scenarios:
  completed:
    description: List instructions are rendered correctly
    commands:
      - rd run --prompted list-instructions.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# List Instructions

## 1. Step with list instructions
- PASS: CONTINUE
- FAIL: STOP

The following instructions should be preserved:
- instruction 1
- instruction 2

## 2. Step with mixed content
- PASS: COMPLETE
- FAIL: STOP

General prose.
- instruction 3
- instruction 4
```


### metadata-header.runbook.md

YAML frontmatter metadata.


**metadata-header.runbook.md:**

```rundown
---
name: metadata-header
description: Runbook with H1 title and description text
tags:
  - features

scenarios:
  completed:
    description: Frontmatter is parsed and displayed
    commands:
      - rd run --prompted metadata-header.runbook.md
      - rd pass
      - rd pass
    result: COMPLETE
---

# Runbook Title
This is a description of the runbook.

## 1. First Step
- PASS: CONTINUE
- FAIL: STOP

Execute.

## 2. Second Step
- PASS: COMPLETE
- FAIL: STOP

Process.
```


---

## See Also

- [MATRIX.md](./MATRIX.md) - Complete coverage matrix
- [SPEC.md](../../docs/SPEC.md) - Full specification
- [FORMAT.md](../../docs/FORMAT.md) - BNF grammar