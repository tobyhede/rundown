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

- [Sequential Workflows](#sequential-workflows)
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

- [standard-sequential.runbook.md](./sequential/standard-sequential.runbook.md)

---

## Dynamic Steps

Runtime-determined iteration using `{N}` placeholder.

### dynamic-batch.runbook.md

Batch processing with dynamic substeps.

- [dynamic-batch.runbook.md](./dynamic/dynamic-batch.runbook.md)

### dynamic-step-next.runbook.md

Dynamic step with GOTO NEXT for iteration.

- [dynamic-step-next.runbook.md](./dynamic/dynamic-step-next.runbook.md)

### dynamic-step-named-substep.runbook.md

Dynamic step containing a named substep.

- [dynamic-step-named-substep.runbook.md](./dynamic/dynamic-step-named-substep.runbook.md)

### dynamic-step-dynamic-substeps.runbook.md

Doubly-dynamic iteration with {N}.{n} pattern.

- [dynamic-step-dynamic-substeps.runbook.md](./dynamic/dynamic-step-dynamic-substeps.runbook.md)

### dynamic-step-mixed-substeps.runbook.md

Dynamic steps with both static and named substeps.

- [dynamic-step-mixed-substeps.runbook.md](./dynamic/dynamic-step-mixed-substeps.runbook.md)

---

## Named Steps

Steps identified by name instead of number.

### named-steps.runbook.md

Basic named steps with GOTO by name.

- [named-steps.runbook.md](./named/named-steps.runbook.md)

### named-substeps.runbook.md

Named substeps within named steps.

- [named-substeps.runbook.md](./named/named-substeps.runbook.md)

### mixed-named-static.runbook.md

Named steps mixed with numbered steps.

- [mixed-named-static.runbook.md](./named/mixed-named-static.runbook.md)

### mixed-named-dynamic.runbook.md

Named steps mixed with dynamic steps.

- [mixed-named-dynamic.runbook.md](./named/mixed-named-dynamic.runbook.md)

### mixed-static-named-error.runbook.md

Static steps with a named error handler step.

- [mixed-static-named-error.runbook.md](./named/mixed-static-named-error.runbook.md)

### mixed-dynamic-named-recovery.runbook.md

Dynamic iteration with a named recovery step.

- [mixed-dynamic-named-recovery.runbook.md](./named/mixed-dynamic-named-recovery.runbook.md)

### named-step-dynamic-substep.runbook.md

Named step containing dynamic substeps.

- [named-step-dynamic-substep.runbook.md](./named/named-step-dynamic-substep.runbook.md)

### named-step-static-substeps.runbook.md

Named step containing numbered substeps.

- [named-step-static-substeps.runbook.md](./named/named-step-static-substeps.runbook.md)

### named-step-named-substeps.runbook.md

Named step containing named substeps.

- [named-step-named-substeps.runbook.md](./named/named-step-named-substeps.runbook.md)

### named-step-mixed-substeps.runbook.md

Named step with both static and named substeps.

- [named-step-mixed-substeps.runbook.md](./named/named-step-mixed-substeps.runbook.md)

---

## Substeps

Nested steps within parent steps.

### nested-static-substeps.runbook.md

Static substeps within static steps.

- [nested-static-substeps.runbook.md](./substeps/nested-static-substeps.runbook.md)

### static-step-mixed-substeps.runbook.md

Static steps containing both numbered and named substeps.

- [static-step-mixed-substeps.runbook.md](./substeps/static-step-mixed-substeps.runbook.md)

---

## GOTO Navigation

Jumping between steps and substeps.

### goto-static.runbook.md

Consolidated static GOTO patterns (Step, Substep, NEXT, Named Substep).

- [goto-static.runbook.md](./navigation/goto-static.runbook.md)

### goto-named.runbook.md

Consolidated named GOTO patterns.

- [goto-named.runbook.md](./navigation/goto-named.runbook.md)

### goto-dynamic-substep.runbook.md

GOTO within dynamic substeps.

- [goto-dynamic-substep.runbook.md](./navigation/goto-dynamic-substep.runbook.md)

### goto-dynamic-substep-from-named.runbook.md

GOTO dynamic substep from a named step.

- [goto-dynamic-substep-from-named.runbook.md](./navigation/goto-dynamic-substep-from-named.runbook.md)

### dynamic-navigation.runbook.md

Navigation between dynamic step instances.

- [dynamic-navigation.runbook.md](./navigation/dynamic-navigation.runbook.md)

### goto-current-dynamic-substep.runbook.md

GOTO X.{n} - jumping to a specific substep in the current dynamic sequence.

- [goto-current-dynamic-substep.runbook.md](./navigation/goto-current-dynamic-substep.runbook.md)

### goto-dynamic-step-alone.runbook.md

GOTO {N} self-loop or infinite retry pattern.

- [goto-dynamic-step-alone.runbook.md](./navigation/goto-dynamic-step-alone.runbook.md)

### goto-next-qualified-step.runbook.md

GOTO NEXT {N} - explicit iteration to next dynamic step.

- [goto-next-qualified-step.runbook.md](./navigation/goto-next-qualified-step.runbook.md)

### goto-next-qualified-substep.runbook.md

GOTO NEXT X.{n} - explicit iteration to next dynamic substep.

- [goto-next-qualified-substep.runbook.md](./navigation/goto-next-qualified-substep.runbook.md)

### goto-restart-dynamic.runbook.md

Restarting a dynamic sequence.

- [goto-restart-dynamic.runbook.md](./navigation/goto-restart-dynamic.runbook.md)

### goto-resume-dynamic-substep.runbook.md

Resuming execution within a dynamic substep context.

- [goto-resume-dynamic-substep.runbook.md](./navigation/goto-resume-dynamic-substep.runbook.md)

---

## Transitions

PASS/FAIL logic and state transitions.

### default-transitions.runbook.md

Default PASS/FAIL behavior.

- [default-transitions.runbook.md](./transition/default-transitions.runbook.md)

### complex-transitions.runbook.md

Complex conditional transitions.

- [complex-transitions.runbook.md](./transition/complex-transitions.runbook.md)

### transition-actions.runbook.md

Explicit transition actions (STOP, CONTINUE, COMPLETE).

- [transition-actions.runbook.md](./transition/transition-actions.runbook.md)

### substep-transitions.runbook.md

Transition logic for substeps.

- [substep-transitions.runbook.md](./transition/substep-transitions.runbook.md)

### dynamic-substep-transitions.runbook.md

Transitions with dynamic substeps.

- [dynamic-substep-transitions.runbook.md](./transition/dynamic-substep-transitions.runbook.md)

---

## Retry Behavior

Retry logic and exhaustion handling.

### retry-success.runbook.md

Basic retry until success.

- [retry-success.runbook.md](./retries/retry-success.runbook.md)

### retry-counter-reset.runbook.md

Retry counter reset behavior.

- [retry-counter-reset.runbook.md](./retries/retry-counter-reset.runbook.md)

### retry-exhaustion.runbook.md

Consolidated patterns for retry exhaustion (CONTINUE, STOP, GOTO, COMPLETE).

- [retry-exhaustion.runbook.md](./retries/retry-exhaustion.runbook.md)

---

## Prompts

User prompts and input handling.

### prompted-steps.runbook.md

Steps with user prompts.

- [prompted-steps.runbook.md](./prompts/prompted-steps.runbook.md)

### mixed-prompts.runbook.md

Different prompt types in one runbook.

- [mixed-prompts.runbook.md](./prompts/mixed-prompts.runbook.md)

### yes-no-aliases.runbook.md

Aliases for yes/no prompts.

- [yes-no-aliases.runbook.md](./prompts/yes-no-aliases.runbook.md)

### prompt-code-block.runbook.md

Code blocks with `prompt` info string (displayed but not executed).

- [prompt-code-block.runbook.md](./prompts/prompt-code-block.runbook.md)

---

## Composition & Agents

Parent runbooks, agents, and delegation.

### runbook-composition.runbook.md

Parent runbook delegating to child runbooks.

- [runbook-composition.runbook.md](./composition/runbook-composition.runbook.md)

### substep-runbooks.runbook.md

Runbook references within substeps.

- [substep-runbooks.runbook.md](./composition/substep-runbooks.runbook.md)

### agent-binding-simple.runbook.md

Basic agent delegation.

- [agent-binding-simple.runbook.md](./composition/agent-binding-simple.runbook.md)

### agent-binding-failure.runbook.md

Handling failure in agent delegation.

- [agent-binding-failure.runbook.md](./composition/agent-binding-failure.runbook.md)

### multi-agent-dynamic.runbook.md

Multiple agents in a dynamic runbook loop.

- [multi-agent-dynamic.runbook.md](./composition/multi-agent-dynamic.runbook.md)

### agent-task-lint.runbook.md

Helper runbook for linting tasks (used in composition tests).

- [agent-task-lint.runbook.md](./composition/agent-task-lint.runbook.md)

### agent-task-test.runbook.md

Helper runbook for testing tasks (used in composition tests).

- [agent-task-test.runbook.md](./composition/agent-task-test.runbook.md)

### child-task.runbook.md

Helper child runbook (used in composition tests).

- [child-task.runbook.md](./composition/child-task.runbook.md)

---

## Specific Features

Additional specific functionality.

### action-messages.runbook.md

STOP and COMPLETE with custom messages.

- [action-messages.runbook.md](./features/action-messages.runbook.md)

### code-blocks.runbook.md

Various code block patterns in runbooks.

- [code-blocks.runbook.md](./features/code-blocks.runbook.md)

### list-instructions.runbook.md

List-based step instructions.

- [list-instructions.runbook.md](./features/list-instructions.runbook.md)

### metadata-header.runbook.md

YAML frontmatter metadata.

- [metadata-header.runbook.md](./features/metadata-header.runbook.md)

---

## See Also

- [MATRIX.md](./MATRIX.md) - Complete coverage matrix
- [SPEC.md](../../docs/SPEC.md) - Full specification
- [FORMAT.md](../../docs/FORMAT.md) - BNF grammar