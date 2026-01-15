# Pattern Coverage Matrix

Comprehensive coverage matrix for Rundown workflow patterns.

---

## Step × Substep Matrix

15 combinations of step types and substep types.

| Step Type | None | Static Substep | Dynamic Substep | Named Substep | Mixed Substeps |
|-----------|------|----------------|-----------------|---------------|----------------|
| **Static** | [standard-sequential](sequential/standard-sequential.runbook.md) | [nested-static-substeps](substeps/nested-static-substeps.runbook.md) | [dynamic-batch](dynamic/dynamic-batch.runbook.md) | [named-substeps](named/named-substeps.runbook.md) | [static-step-mixed-substeps](substeps/static-step-mixed-substeps.runbook.md) |
| **Dynamic** | [dynamic-step-next](dynamic/dynamic-step-next.runbook.md) | [dynamic-navigation](navigation/dynamic-navigation.runbook.md) | [dynamic-step-dynamic-substeps](dynamic/dynamic-step-dynamic-substeps.runbook.md) | [dynamic-step-named-substep](dynamic/dynamic-step-named-substep.runbook.md) | [dynamic-step-mixed-substeps](dynamic/dynamic-step-mixed-substeps.runbook.md) |
| **Named** | [named-steps](named/named-steps.runbook.md) | [named-step-static-substeps](named/named-step-static-substeps.runbook.md) | [named-step-dynamic-substep](named/named-step-dynamic-substep.runbook.md) | [named-step-named-substeps](named/named-step-named-substeps.runbook.md) | [named-step-mixed-substeps](named/named-step-mixed-substeps.runbook.md) |

### Step Types

| Type | Format | Example |
|------|--------|---------|
| Static | `## N. Step Name` | `## 1. Setup` |
| Dynamic | `## {N}. Step Name` | `## {N}. Process Item` |
| Named | `## StepName` | `## ErrorHandler` |

### Substep Types

| Type | Static Parent | Dynamic Parent | Named Parent |
|------|---------------|----------------|--------------|
| None | (no H3) | (no H3) | (no H3) |
| Static | `### 1.1 Validate` | `### {N}.1 Validate` | `### Handler.1 Validate` |
| Dynamic | `### 1.{n} Process` | `### {N}.{n} Process` | `### Handler.{n} Process` |
| Named | `### 1.Cleanup` | `### {N}.Cleanup` | `### Handler.Cleanup` |
| Mixed | `### 1.1` + `### 1.Verify` | `### {N}.1` + `### {N}.Verify` | `### Handler.1` + `### Handler.Verify` |

---

## GOTO Navigation Matrix

15 patterns for GOTO navigation targets.

| Pattern | Target | File |
|---------|--------|------|
| GOTO step | `GOTO N` | [goto-static](navigation/goto-static.runbook.md) |
| GOTO substep | `GOTO N.M` | [goto-static](navigation/goto-static.runbook.md) |
| GOTO dynamic substep | `GOTO {N}.M` | [goto-dynamic-substep](navigation/goto-dynamic-substep.runbook.md) |
| GOTO NEXT | `GOTO NEXT` | [goto-static](navigation/goto-static.runbook.md) |
| GOTO named step | `GOTO Name` | [goto-named](navigation/goto-named.runbook.md) |
| GOTO static named substep | `GOTO N.Name` | [goto-static](navigation/goto-static.runbook.md) |
| GOTO dynamic named substep | `GOTO {N}.Name` | [goto-dynamic-substep-from-named](navigation/goto-dynamic-substep-from-named.runbook.md) |
| GOTO from named to step | Named → N | [goto-named](navigation/goto-named.runbook.md) |
| GOTO named to named | Named → Named | [goto-named](navigation/goto-named.runbook.md) |
| GOTO restart dynamic | `GOTO {N}` | [goto-restart-dynamic](navigation/goto-restart-dynamic.runbook.md) |
| GOTO dynamic infinite retry | `GOTO {N}` (self-loop) | [goto-dynamic-step-alone](navigation/goto-dynamic-step-alone.runbook.md) |
| GOTO resume dynamic context | `GOTO {N}.{n}` | [goto-resume-dynamic-substep](navigation/goto-resume-dynamic-substep.runbook.md) |
| GOTO current dynamic substep | `GOTO X.{n}` | [goto-current-dynamic-substep](navigation/goto-current-dynamic-substep.runbook.md) |
| GOTO NEXT step instance | `GOTO NEXT {N}` | [goto-next-qualified-step](navigation/goto-next-qualified-step.runbook.md) |
| GOTO NEXT substep instance | `GOTO NEXT X.{n}` | [goto-next-qualified-substep](navigation/goto-next-qualified-substep.runbook.md) |

---

## Transition Patterns

8 patterns for step transitions.

| Pattern | Description | File |
|---------|-------------|------|
| Default transitions | Implicit PASS/FAIL handling | [default-transitions](transition/default-transitions.runbook.md) |
| Complex transitions | ALL/ANY aggregation | [complex-transitions](transition/complex-transitions.runbook.md) |
| YES/NO aliases | Alternative transition keywords | [yes-no-aliases](prompts/yes-no-aliases.runbook.md) |
| Substep transitions | Transitions within substeps | [substep-transitions](transition/substep-transitions.runbook.md) |
| Dynamic substep transitions | Transitions in dynamic substeps | [dynamic-substep-transitions](transition/dynamic-substep-transitions.runbook.md) |
| PASS → STOP | Explicit stop on success | [transition-actions](transition/transition-actions.runbook.md) |
| FAIL → CONTINUE | Continue despite failure | [transition-actions](transition/transition-actions.runbook.md) |
| FAIL → COMPLETE | Complete workflow on failure | [transition-actions](transition/transition-actions.runbook.md) |

---

## Retry Patterns

6 patterns for retry behavior and exhaustion handling.

| Pattern | Exhaustion Action | File |
|---------|-------------------|------|
| Retry until success | N/A (always succeeds) | [retry-success](retries/retry-success.runbook.md) |
| Retry counter reset | Counter resets on success | [retry-counter-reset](retries/retry-counter-reset.runbook.md) |
| Exhaustion → CONTINUE | Move to next step | [retry-exhaustion](retries/retry-exhaustion.runbook.md) |
| Exhaustion → STOP | Halt workflow | [retry-exhaustion](retries/retry-exhaustion.runbook.md) |
| Exhaustion → GOTO | Jump to recovery step | [retry-exhaustion](retries/retry-exhaustion.runbook.md) |
| Exhaustion → COMPLETE | Complete workflow | [retry-exhaustion](retries/retry-exhaustion.runbook.md) |

---

## Mixed Step Patterns

4 patterns combining different step types.

| Pattern | Components | File |
|---------|------------|------|
| Static + Named | Numbered steps with named step | [mixed-named-static](named/mixed-named-static.runbook.md) |
| Dynamic + Named | Dynamic iteration with named step | [mixed-named-dynamic](named/mixed-named-dynamic.runbook.md) |
| Static + Named + Error | Static workflow with error handler | [mixed-static-named-error](named/mixed-static-named-error.runbook.md) |
| Dynamic + Named + Recovery | Dynamic iteration with recovery | [mixed-dynamic-named-recovery](named/mixed-dynamic-named-recovery.runbook.md) |

---

## Other Patterns

6 patterns for additional features.

| Pattern | Feature | File |
|---------|---------|------|
| Prompts | User prompts with checkboxes | [prompted-steps](prompts/prompted-steps.runbook.md) |
| Mixed prompts | Multiple prompt types | [mixed-prompts](prompts/mixed-prompts.runbook.md) |
| Metadata header | YAML frontmatter | [metadata-header](features/metadata-header.runbook.md) |
| List instructions | Bulleted instruction lists | [list-instructions](features/list-instructions.runbook.md) |
| Workflow composition | Including other workflows | [workflow-composition](composition/workflow-composition.runbook.md) |
| Code blocks | Multiple code block types | [code-blocks](features/code-blocks.runbook.md) |

---

## Subworkflow Patterns

| Pattern | Description | File |
|---------|-------------|------|
| agent-binding-simple | Parent delegates step to agent with child workflow | [agent-binding-simple](composition/agent-binding-simple.runbook.md) |
| agent-binding-failure | Parent handles agent failure gracefully | [agent-binding-failure](composition/agent-binding-failure.runbook.md) |
| multi-agent-dynamic | Multiple agents with different runbooks and dynamic iteration | [multi-agent-dynamic](composition/multi-agent-dynamic.runbook.md) |
| substep-runbooks | Runbook references within substeps | [substep-runbooks](composition/substep-runbooks.runbook.md) |

---

## Message Patterns

| Pattern | Description | File |
|---------|-------------|------|
| action-messages | STOP and COMPLETE with message parameters | [action-messages](features/action-messages.runbook.md) |

---

## Summary

| Category | Count |
|----------|-------|
| Step × Substep Matrix | 15 |
| GOTO Navigation | 15 |
| Transitions | 8 |
| Retry | 6 |
| Mixed Steps | 4 |
| Other | 6 |
| Subworkflow Patterns | 4 |
| Message Patterns | 1 |
| **Total** | **59** |
