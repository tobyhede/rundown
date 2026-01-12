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

- [standard-sequential.runbook.md](./standard-sequential.runbook.md)

---

## Dynamic Steps

Runtime-determined iteration using `{N}` placeholder.

### dynamic-step-next.runbook.md

Dynamic step with GOTO NEXT for iteration.

- [dynamic-step-next.runbook.md](./dynamic-step-next.runbook.md)

### dynamic-navigation.runbook.md

Navigation between dynamic step instances.

- [dynamic-navigation.runbook.md](./dynamic-navigation.runbook.md)

### dynamic-batch.runbook.md

Batch processing with dynamic substeps.

- [dynamic-batch.runbook.md](./dynamic-batch.runbook.md)

---

## Named Steps

Steps identified by name instead of number.

### named-steps.runbook.md

Basic named steps with GOTO by name.

- [named-steps.runbook.md](./named-steps.runbook.md)

### named-substeps.runbook.md

Named substeps within named steps.

- [named-substeps.runbook.md](./named-substeps.runbook.md)

### mixed-named-static.runbook.md

Named steps mixed with numbered steps.

- [mixed-named-static.runbook.md](./mixed-named-static.runbook.md)

### mixed-named-dynamic.runbook.md

Named steps mixed with dynamic steps.

- [mixed-named-dynamic.runbook.md](./mixed-named-dynamic.runbook.md)

---

## Substeps

Nested steps within parent steps.

### nested-static-substeps.runbook.md

Static substeps within static steps.

- [nested-static-substeps.runbook.md](./nested-static-substeps.runbook.md)

### substep-transitions.runbook.md

Transition logic for substeps.

- [substep-transitions.runbook.md](./substep-transitions.runbook.md)

### dynamic-substep-transitions.runbook.md

Transitions with dynamic substeps.

- [dynamic-substep-transitions.runbook.md](./dynamic-substep-transitions.runbook.md)

---

## GOTO Navigation

Jumping between steps.

### goto-step.runbook.md

GOTO a numbered step.

- [goto-step.runbook.md](./goto-step.runbook.md)

### goto-substep.runbook.md

GOTO a specific substep.

- [goto-substep.runbook.md](./goto-substep.runbook.md)

### goto-dynamic-substep.runbook.md

GOTO within dynamic substeps.

- [goto-dynamic-substep.runbook.md](./goto-dynamic-substep.runbook.md)

### goto-named.runbook.md

GOTO a named step.

- [goto-named.runbook.md](./goto-named.runbook.md)

### goto-next.runbook.md

GOTO NEXT for advancing dynamic steps.

- [goto-next.runbook.md](./goto-next.runbook.md)

---

## Transitions

PASS/FAIL logic and state transitions.

### default-transitions.runbook.md

Default PASS/FAIL behavior.

- [default-transitions.runbook.md](./default-transitions.runbook.md)

### complex-transitions.runbook.md

Complex conditional transitions.

- [complex-transitions.runbook.md](./complex-transitions.runbook.md)

---

## Retry Behavior

Retry logic and exhaustion handling.

### retry-success.runbook.md

Basic retry until success.

- [retry-success.runbook.md](./retry-success.runbook.md)

### retry-counter-reset.runbook.md

Retry counter reset behavior.

- [retry-counter-reset.runbook.md](./retry-counter-reset.runbook.md)

### retry-exhaustion-continue.runbook.md

Continue to next step on retry exhaustion.

- [retry-exhaustion-continue.runbook.md](./retry-exhaustion-continue.runbook.md)

### retry-exhaustion-done.runbook.md

Mark done on retry exhaustion.

- [retry-exhaustion-done.runbook.md](./retry-exhaustion-done.runbook.md)

### retry-exhaustion-goto.runbook.md

GOTO on retry exhaustion.

- [retry-exhaustion-goto.runbook.md](./retry-exhaustion-goto.runbook.md)

---

## Prompts

User prompts and input handling.

### prompted-steps.runbook.md

Steps with user prompts.

- [prompted-steps.runbook.md](./prompted-steps.runbook.md)

### mixed-prompts.runbook.md

Different prompt types in one workflow.

- [mixed-prompts.runbook.md](./mixed-prompts.runbook.md)

### yes-no-aliases.runbook.md

Aliases for yes/no prompts.

- [yes-no-aliases.runbook.md](./yes-no-aliases.runbook.md)

---

## Metadata & Instructions

Frontmatter and instruction formats.

### metadata-header.runbook.md

YAML frontmatter metadata.

- [metadata-header.runbook.md](./metadata-header.runbook.md)

### list-instructions.runbook.md

List-based step instructions.

- [list-instructions.runbook.md](./list-instructions.runbook.md)

---

## Workflow Composition

Orchestrating multiple workflows.

### workflow-composition.runbook.md

Parent workflow delegating to child workflows.

- [workflow-composition.runbook.md](./workflow-composition.runbook.md)

---

## See Also

- [SPEC.md](../../docs/SPEC.md) - Full specification
- [FORMAT.md](../../docs/FORMAT.md) - BNF grammar
