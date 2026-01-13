# Pattern Coverage Matrix

Comprehensive coverage matrix for Rundown workflow patterns.

---

## Step × Substep Matrix

15 combinations of step types and substep types.

| Step Type | None | Static Substep | Dynamic Substep | Named Substep | Mixed Substeps |
|-----------|------|----------------|-----------------|---------------|----------------|
| **Static** | [standard-sequential](standard-sequential.runbook.md) | [nested-static-substeps](nested-static-substeps.runbook.md) | [dynamic-batch](dynamic-batch.runbook.md) | [named-substeps](named-substeps.runbook.md) | [static-step-mixed-substeps](static-step-mixed-substeps.runbook.md) |
| **Dynamic** | [dynamic-step-next](dynamic-step-next.runbook.md) | [dynamic-navigation](dynamic-navigation.runbook.md) | [dynamic-step-dynamic-substeps](dynamic-step-dynamic-substeps.runbook.md) | [dynamic-step-named-substep](dynamic-step-named-substep.runbook.md) | [dynamic-step-mixed-substeps](dynamic-step-mixed-substeps.runbook.md) |
| **Named** | [named-steps](named-steps.runbook.md) | [named-step-static-substeps](named-step-static-substeps.runbook.md) | [named-step-dynamic-substep](named-step-dynamic-substep.runbook.md) | [named-step-named-substeps](named-step-named-substeps.runbook.md) | [named-step-mixed-substeps](named-step-mixed-substeps.runbook.md) |

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

14 patterns for GOTO navigation targets.

| Pattern | Target | File |
|---------|--------|------|
| GOTO step | `GOTO N` | [goto-step](goto-step.runbook.md) |
| GOTO substep | `GOTO N.M` | [goto-substep](goto-substep.runbook.md) |
| GOTO dynamic substep | `GOTO {N}.M` | [goto-dynamic-substep](goto-dynamic-substep.runbook.md) |
| GOTO NEXT | `GOTO NEXT` | [goto-next](goto-next.runbook.md) |
| GOTO named step | `GOTO Name` | [goto-named](goto-named.runbook.md) |
| GOTO static named substep | `GOTO N.Name` | [goto-static-named-substep](goto-static-named-substep.runbook.md) |
| GOTO dynamic named substep | `GOTO {N}.Name` | [goto-dynamic-substep-from-named](goto-dynamic-substep-from-named.runbook.md) |
| GOTO from named to step | Named → N | [goto-from-named-step](goto-from-named-step.runbook.md) |
| GOTO named to named | Named → Named | [goto-named-to-named](goto-named-to-named.runbook.md) |
| GOTO restart dynamic | `GOTO {N}` | [goto-restart-dynamic](goto-restart-dynamic.runbook.md) |
| GOTO resume dynamic context | `GOTO {N}.{n}` | [goto-resume-dynamic-substep](goto-resume-dynamic-substep.runbook.md) |
| GOTO current dynamic substep | `GOTO X.{n}` | [goto-current-dynamic-substep](goto-current-dynamic-substep.runbook.md) |
| GOTO NEXT step instance | `GOTO NEXT {N}` | [goto-next-qualified-step](goto-next-qualified-step.runbook.md) |
| GOTO NEXT substep instance | `GOTO NEXT X.{n}` | [goto-next-qualified-substep](goto-next-qualified-substep.runbook.md) |

---

## Transition Patterns

8 patterns for step transitions.

| Pattern | Description | File |
|---------|-------------|------|
| Default transitions | Implicit PASS/FAIL handling | [default-transitions](default-transitions.runbook.md) |
| Complex transitions | ALL/ANY aggregation | [complex-transitions](complex-transitions.runbook.md) |
| YES/NO aliases | Alternative transition keywords | [yes-no-aliases](yes-no-aliases.runbook.md) |
| Substep transitions | Transitions within substeps | [substep-transitions](substep-transitions.runbook.md) |
| Dynamic substep transitions | Transitions in dynamic substeps | [dynamic-substep-transitions](dynamic-substep-transitions.runbook.md) |
| PASS → STOP | Explicit stop on success | [pass-stop-transition](pass-stop-transition.runbook.md) |
| FAIL → CONTINUE | Continue despite failure | [fail-continue-transition](fail-continue-transition.runbook.md) |
| FAIL → COMPLETE | Complete workflow on failure | [fail-complete-transition](fail-complete-transition.runbook.md) |

---

## Retry Patterns

6 patterns for retry behavior and exhaustion handling.

| Pattern | Exhaustion Action | File |
|---------|-------------------|------|
| Retry until success | N/A (always succeeds) | [retry-success](retry-success.runbook.md) |
| Retry counter reset | Counter resets on success | [retry-counter-reset](retry-counter-reset.runbook.md) |
| Exhaustion → CONTINUE | Move to next step | [retry-exhaustion-continue](retry-exhaustion-continue.runbook.md) |
| Exhaustion → STOP | Halt workflow | [retry-exhaustion-done](retry-exhaustion-done.runbook.md) |
| Exhaustion → GOTO | Jump to recovery step | [retry-exhaustion-goto](retry-exhaustion-goto.runbook.md) |
| Exhaustion → COMPLETE | Complete workflow | [retry-exhaustion-complete](retry-exhaustion-complete.runbook.md) |

---

## Mixed Step Patterns

4 patterns combining different step types.

| Pattern | Components | File |
|---------|------------|------|
| Static + Named | Numbered steps with named step | [mixed-named-static](mixed-named-static.runbook.md) |
| Dynamic + Named | Dynamic iteration with named step | [mixed-named-dynamic](mixed-named-dynamic.runbook.md) |
| Static + Named + Error | Static workflow with error handler | [mixed-static-named-error](mixed-static-named-error.runbook.md) |
| Dynamic + Named + Recovery | Dynamic iteration with recovery | [mixed-dynamic-named-recovery](mixed-dynamic-named-recovery.runbook.md) |

---

## Other Patterns

6 patterns for additional features.

| Pattern | Feature | File |
|---------|---------|------|
| Prompts | User prompts with checkboxes | [prompted-steps](prompted-steps.runbook.md) |
| Mixed prompts | Multiple prompt types | [mixed-prompts](mixed-prompts.runbook.md) |
| Metadata header | YAML frontmatter | [metadata-header](metadata-header.runbook.md) |
| List instructions | Bulleted instruction lists | [list-instructions](list-instructions.runbook.md) |
| Workflow composition | Including other workflows | [workflow-composition](workflow-composition.runbook.md) |
| Code blocks | Multiple code block types | [code-blocks](code-blocks.runbook.md) |

---

## Subworkflow Patterns

| Pattern | Description |
|---------|-------------|
| agent-binding-simple | Parent delegates step to agent with child workflow |
| agent-binding-failure | Parent handles agent failure gracefully |
| multi-agent-dynamic | Multiple agents with different runbooks and dynamic iteration |

---

## Message Patterns

| Pattern | Description |
|---------|-------------|
| action-messages | STOP and COMPLETE with message parameters |

---

## Summary

| Category | Count |
|----------|-------|
| Step × Substep Matrix | 15 |
| GOTO Navigation | 14 |
| Transitions | 8 |
| Retry | 6 |
| Mixed Steps | 4 |
| Other | 6 |
| Subworkflow Patterns | 3 |
| Message Patterns | 1 |
| **Total** | **57** |
