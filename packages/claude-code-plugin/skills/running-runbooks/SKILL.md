---
name: running-runbooks
description: Use when a rundown runbook is active, when receiving delegation instructions with a claim token, or when rd/rundown CLI commands appear in step output
---

# Running Runbooks

Rundown executes markdown runbooks step-by-step. The CLI controls progress — you follow the output and respond.

## Quick Reference

```
rd run <file>                    # Start a runbook
rd run <file> --var k=v          # Start with variables
rd run <file> --var-json k=json  # Start with JSON variable
rd run <file> --var-file <path>  # Load variables from YAML

rd pass                    # Mark step passed (aliases: yes, ok)
rd fail                    # Mark step failed (alias: no)

rd status                  # Show current state
rd status --json           # Structured state (for parsing)
rd stop                    # Abort runbook
rd complete                # Force early completion
```

## How Steps Work

Each step is one of two types:

| Type | What happens | What you do |
|------|-------------|-------------|
| **Command** | Executes automatically (bash) | Wait. Exit code determines result. |
| **Prompt** | Outputs instructions | Follow the instructions, then `rd pass` or `rd fail`. |

Default transitions:
- **PASS** → advance to next step
- **FAIL** → stop execution

The runbook may override these (e.g., FAIL retries, GOTO a recovery step). **Trust the output unconditionally** — it tells you what happened and what's next. Do not second-guess or work around the runbook's transition logic, even if the result seems unexpected.

## Substeps

Some steps contain substeps (e.g., step 2 has substeps 2.1, 2.2). When responding to substeps:

```
rd pass --step 2.1         # Pass a specific substep
rd fail --step 2.2         # Fail a specific substep
```

## FOR Loops

Steps with FOR loops repeat across iterations. Target a specific iteration with `--index` (requires `--step`):

```
rd pass --step 2.1 --index 3    # Pass substep 2.1 at iteration 3
rd fail --step 2.1 --index 3    # Fail substep 2.1 at iteration 3
```

## Claiming Delegated Work

When another agent delegates work to you, the plugin injects claim instructions automatically. The flow:

1. You receive instructions containing a claim token
2. Run `rd claim <token>` to accept the work
3. Follow the runbook steps (same as above — follow output, pass/fail)
4. `rd pass` or `rd fail` to report your result back to the parent

Variables can be passed during claiming:

```
rd claim <token> --var key=value
rd claim <token> --var-json key=json
rd claim <token> --var-file <path>
```

For orchestrating delegation from the parent side, see [delegating-runbooks](../delegating-runbooks/SKILL.md).

## Prompted Mode

With `--prompted`, command steps do NOT auto-execute — you see the command and manually advance. Use `--step 3` to jump (requires `--prompted`).

## State Management

```
rd ls                # List active runbooks
rd stash             # Pause current runbook (stash)
rd pop               # Resume stashed runbook
rd prune             # Remove completed runbook state
rd prune --all       # Remove all runbook state
```

## Structured Output

Use `--json` for machine-readable output when you need to parse state programmatically:

```
rd status --json           # Current state as JSON
rd run <file> --json       # Execution events as JSON
```

## Rules

- **Follow all step instructions exactly** — do not skip, improvise, or reinterpret
- **Never work around transitions** — if a FAIL handler retries or GOTOs, that is correct behavior; do not override it
- **Complete ALL steps** — do not abandon a runbook mid-execution
- **Use the CLI** — always use `rd pass`/`rd fail` to respond, not just verbal acknowledgment

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Verbal "done" instead of CLI | Always `rd pass` or `rd fail` |
| Skipping steps | Follow every step — runbook controls flow |
| Bare `rd pass` with substeps active | Use `rd pass --step 2.1` |
| Abandoning without `rd stop` | Complete all steps or explicitly stop |

## Reference

- [Runbook patterns and examples](../../../../runbooks/README.md)
- [Rundown specification](../../../../docs/SPEC.md)
- [CLI reference](../../../../CLAUDE.md)
