---
name: running-runbooks
description: Use when a rundown runbook is active, when receiving delegation instructions with a claim token, or when rd/rundown CLI commands appear in step output
---

# Running Runbooks

Rundown executes markdown runbooks step-by-step. The CLI controls progress — you follow the output and respond.

## Quick Reference

```bash
rd run <file>                      # Start a runbook
rd run <file> --input k=v          # Start with input
rd run <file> --input-json k=json  # Start with JSON input
rd run <file> --input-file <path>  # Load inputs from YAML

rd pass                    # Mark step passed (aliases: yes, ok)
rd fail                    # Mark step failed (alias: no)

rd status                  # Show current state (JSON by default)
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

```bash
rd pass --step 2.1         # Pass a specific substep
rd fail --step 2.2         # Fail a specific substep
```

## FOR Loops

Steps with FOR loops repeat across iterations. Target a specific iteration with `--index` (requires `--step`):

```bash
rd pass --step 2.1 --index 3    # Pass substep 2.1 at iteration 3
rd fail --step 2.1 --index 3    # Fail substep 2.1 at iteration 3
```

## Nested Runbooks (Inline Linkage)

**Inline linkage** is the default for runbook-list entries: no `- DELEGATE`, no token, the parent walks the child in-session. When a step has a substep with a nested runbook reference, run the child with `--step` pointing at the parent substep:

```bash
rd run <child-runbook> --step 1.1
```

If you instead want an out-of-process subagent to execute the child, add `- DELEGATE` and follow the [delegating-runbooks](../delegating-runbooks/SKILL.md) skill.

The child:
- Auto-starts and executes command steps
- Presents prompted steps for you to follow
- Automatically propagates its result to the parent substep on completion
- Parent advances to the next step without manual `rd pass`

For FOR loop iterations, add `--index`:

```bash
rd run <child-runbook> --step 1.1 --index 3
```

## Context Passing (OUTPUTS)

Steps and runbooks may declare OUTPUTS to flow data forward — between steps in the same run, and from a child runbook back to its parent.

**Step OUTPUTS** — evaluated on every step transition (independent of PASS/FAIL), merged into the run's live variable space:
```markdown
## 7. Output Path
- OUTPUTS
  - PlanPath {{ path "plan.json" }}
- PASS CONTINUE
- FAIL STOP
```
On the completing step's transition, `PlanPath` is added to `state.variables` and is visible to every later step in the same run via `{{ PlanPath }}`. Step OUTPUTS apply to both H2 steps and H3 substeps.

**Frontmatter `OUTPUTS:`** — evaluated at terminal completion (`COMPLETE` or `STOPPED`), exported to the parent:
```yaml
---
name: write-plan
OUTPUTS:
  - PlanPath
---
```
At terminal completion, listed names are read from the merged variable space and written to `state.finalVars`. When the runbook completes as a child of a delegation, those `finalVars` are forwarded into the parent's `state.variables` via a `SET_VARIABLES` event — so the parent's later steps see `{{ PlanPath }}` automatically. No CLI plumbing required.

**Receiving inputs** — declare what a runbook needs in frontmatter:

```yaml
---
name: review-plan
INPUTS:
  - PlanPath
  - environment
REQUIRED:
  - PlanPath
---
```

`INPUTS:` is a YAML sequence of variable names the runbook accepts (declarations only, no values). `REQUIRED:` must be a subset of `INPUTS:` — names listed in `REQUIRED:` must also appear in `INPUTS:`, otherwise the parser rejects the frontmatter. `REQUIRED:` causes a hard error at startup if the variable isn't supplied by any source: CLI `--input`, `--input-file`, or `--input-json`; environment variables via `RD_INPUT_*`; parent forwarding; or project `.rundown/config.yaml`. Inside the runbook, just reference `{{ PlanPath }}`.

Defaults do not live in frontmatter. Supply them via `.rundown/config.yaml`, `--input`, `--input-file`, `--input-json`, or `RD_INPUT_*` env.

### Frontmatter casing convention

| Casing | Fields | Reason |
|--------|--------|--------|
| **UPPERCASE** | `INPUTS`, `OUTPUTS`, `REQUIRED` | Load-bearing runtime parameters; mirrors the step-level `- OUTPUTS`/`- FOR` directive style |
| **lowercase** | `name`, `description`, `version`, `author`, `tags`, `skill` | Static metadata |

The parser case-normalizes known keys, so both forms parse identically — the convention is purely for human readability.

## Claiming Delegated Work

When another agent delegates work to you, the plugin injects claim instructions automatically. The flow:

1. You receive instructions containing a claim token
2. Run `rd claim <token>` to accept the work
3. Follow the runbook steps (same as above — follow output, pass/fail)
4. `rd pass` or `rd fail` to report your result back to the parent

Variables can be passed during claiming:

```bash
rd claim <token> --input key=value
rd claim <token> --input-json key=json
rd claim <token> --input-file <path>
```

For orchestrating delegation from the parent side, see [delegating-runbooks](../delegating-runbooks/SKILL.md).

## Prompted

With `--prompted`, command steps do NOT auto-execute — you see the command and manually advance. Use `--step 3` to jump (requires `--prompted`).

Note: auto-execution is `default` behaviour and the typical usage.

## State Management

```bash
rd ls                # List active runbooks
rd stash             # Pause current runbook (stash)
rd pop               # Resume stashed runbook
rd prune             # Remove completed runbook state
rd prune --all       # Remove all runbook state
```

## Structured Output

JSON is the default output format — all commands emit machine-readable JSON unless `--text` is passed:

```bash
rd status           # Current state as JSON (default)
rd run <file>       # Execution events as JSON (default)
rd status --text    # Human-readable text output
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
