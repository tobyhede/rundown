---
name: running-runbooks
description: Use when stepping through a Rundown runbook that is already active or has just been started, when receiving delegation instructions with a claim token, or when rundown CLI commands appear in step output. For cold-start "run the X runbook" requests with nothing active, the rundown launcher skill starts the runbook first.
---

# Running Runbooks

Rundown executes markdown runbooks step-by-step. The CLI controls progress — you follow the output and respond.

Capture the run id when you start the runbook: `rundown run` prints it at start and every subsequent event carries it as `runbookId`. You need it for every mutating command you issue as the orchestrator of a delegation-exposed run (`--run <rd_…>`). A claimed child never needs it — a child names its own lane with `--claim-id <claim_id>`.

## When to Use

- A Rundown runbook is already active and needs step-by-step execution
- CLI output from `rundown` asks for a pass/fail response, claim, status check, or continuation
- A delegated task arrives with a claim token and must be accepted, executed, and reported back
- A prompt or command output references Rundown step IDs, substeps, FOR loop indexes, or claim IDs

## When NOT to Use

- Writing or editing runbook files — use the writing-runbooks skill instead
- Orchestrating parent-side delegation to other agents — use the delegating-runbooks skill instead
- Planning work before authoring a runbook — use the writing-plans skill when applicable
- Running unrelated shell commands that are not part of a Rundown-controlled workflow

## Quick Reference

```bash
rundown run <file>                      # Start a runbook
rundown run <file> --input k=v          # Start with input
rundown run <file> --input-json k=json  # Start with JSON input
rundown run <file> --input-file <path>  # Load inputs from YAML

rundown pass                    # Mark step passed (aliases: yes, ok) — standalone run only
rundown fail                    # Mark step failed (alias: no) — standalone run only

rundown status                  # Show current state (JSON by default)
rundown stop                    # Stop the active workflow; inside inline composition, targets the outermost contiguous-inline ancestor
rundown complete                # Complete the active workflow; inside inline composition, targets the outermost contiguous-inline ancestor
```

The bare `rundown pass` / `rundown fail` / `rundown stop` / `rundown complete`
forms above apply to a **standalone run** (one with no delegation activity). On a
**delegation-exposed run** the bare form is refused with `ACTOR_CONTEXT_REQUIRED`;
name your lane instead — orchestrators pass `--run <rd_…>`, delegated children pass
`--claim-id <claim_id>`:

```bash
rundown pass --run <rd_…>        # Orchestrator advances the run it controls
rundown pass --claim-id <claim_id>   # Delegated child reports its result
```

Inside inline-composed runbooks, use `rundown pass` or `rundown fail` to finish the
current inline unit and let the parent continue (on a delegation-exposed
composition, `--run <rd_…>` naming any member of the contiguous inline chain).
Use `rundown complete` or `rundown stop` only when the intended outcome is to
force the composed workflow terminal. Delegated children still use `--claim-id`
and report to the parent; the parent advances on `rundown collect --run <rd_…>`.

## How Steps Work

Each step is one of two types:

| Type | What happens | What you do |
|------|-------------|-------------|
| **Command** | Executes automatically (bash) | Wait. Exit code determines result. |
| **Prompt** | Outputs instructions | Follow the instructions, then `rundown pass` or `rundown fail`. |

Default transitions:
- **PASS** → advance to next step
- **FAIL** → stop execution

The runbook may override these (e.g., FAIL retries, GOTO a recovery step). **Trust Rundown for execution state and transitions** — it tells you what happened and what's next. Do not second-guess or work around the runbook's transition logic, even if the result seems unexpected. Still apply normal safety, permission, and policy checks before running commands or taking external actions.

## Substeps

Some steps contain substeps (e.g., step 2 has substeps 2.1, 2.2). When responding to substeps:

```bash
rundown pass --step 2.1         # Pass a specific substep
rundown fail --step 2.2         # Fail a specific substep
```

## FOR Loops

Steps with FOR loops repeat across iterations. Target a specific iteration with `--index` (requires `--step`):

```bash
rundown pass --step 2.1 --index 3    # Pass substep 2.1 at iteration 3
rundown fail --step 2.1 --index 3    # Fail substep 2.1 at iteration 3
```

## Nested Runbooks

**Inline linkage** is the default for runbook-list entries: no `- DELEGATE`, no token, the parent auto-launches the child in-session and records the parent linkage. Follow the output you receive — inline child runbooks launch automatically when the parent advances into a substep that references a nested runbook, with no manual `rundown run` command and no `rundown delegate` for these entries:

```bash
rundown pass    # advancing into the step that holds the inline substep auto-launches the child
```

The child:
- Auto-starts and executes command steps
- Presents prompted steps for you to follow
- Automatically propagates its result to the parent substep on completion
- Parent advances to the next step without manual `rundown pass`

If the output provides a delegation token or tells you to delegate work, follow the token flow below or the [delegating-runbooks](../delegating-runbooks/SKILL.md) skill as directed.

## Context Passing (OUTPUTS)

Outputs declared by steps or child runbooks become available automatically to later steps. When a later step references a value such as `{{ PlanPath }}`, trust that Rundown has carried the declared output forward.

Do not manually copy, forward, or re-enter output values unless the runbook output explicitly asks you to do so. Your job as a runner is to follow the CLI output and step instructions, not to manage variable plumbing.

If `rundown run` or `rundown claim` reports missing required inputs, supply them operationally:

```bash
rundown run <file> --input key=value
rundown run <file> --input-json key=json
rundown run <file> --input-file <path>

rundown claim <token> --input key=value
rundown claim <token> --input-json key=json
rundown claim <token> --input-file <path>
```

## Claiming Delegated Work

When another agent delegates work to you, the plugin injects claim instructions automatically. The flow:

1. You receive instructions containing a claim token
2. Run `rundown claim <token>` to accept the work
3. Follow the runbook steps (same as above — follow output, pass/fail), passing `--claim-id <claim_id>` on **every** command
4. Use `rundown pass --claim-id <claim_id>` or `rundown fail --claim-id <claim_id>` to report your result back to the parent
5. **Stop.** Once you have reported your claim's final result, your job is done — end your turn and return control to the orchestrator that delegated you.

Variables can be passed during claiming:

```bash
rundown claim <token> --input key=value
rundown claim <token> --input-json key=json
rundown claim <token> --input-file <path>
```

On a delegation-exposed run, bare `rundown pass` / `rundown fail` are refused with `ACTOR_CONTEXT_REQUIRED` — they do not silently target anything. Orchestrators pass `--run <rd_…>`; children pass `--claim-id <claim_id>`. Only a standalone run (no delegation activity) accepts the bare form.

<important>
**A claimed child stays inside its claim and stops when the claim ends.** You were dispatched to execute exactly one delegated runbook. When it completes (or fails), the parent pipeline may auto-advance into *its* next step — but those steps belong to the **orchestrator**, not to you. Do not keep going.

- Pass `--claim-id <claim_id>` on **every** mutating `rundown` command for your claimed work. **Never** issue a bare `rundown pass` / `rundown fail` / `rundown delegate` as a claimed child — on a delegation-exposed run the bare form is refused with `ACTOR_CONTEXT_REQUIRED` (it does not silently drive the parent), and the remediation names both lanes without ever echoing the run id. Read-only commands like `rundown status` stay bare.
- The "Complete ALL steps — do not abandon a runbook" rule applies to **your claimed runbook only**, not to the parent that auto-advanced behind it.
- After `rundown pass --claim-id` / `rundown fail --claim-id`, **end your turn.** Report your result in prose to whoever dispatched you; do not run further `rundown` commands.
</important>

For orchestrating delegation from the parent side, see [delegating-runbooks](../delegating-runbooks/SKILL.md).

## State Management

```bash
rundown ls                # List active runbooks
rundown stash             # Pause current runbook (stash)
rundown pop               # Resume stashed runbook
rundown prune             # Remove completed runbook state
rundown prune --all       # Remove all runbook state
```

## Structured Output

JSON is the agent-facing output format — every command emits machine-readable JSON by default:

```bash
rundown status           # Current state as JSON (default)
rundown run <file>       # Execution events as JSON (default)
```

The `--text` flag exists only for humans reading output in a terminal; it is
not part of the agent protocol. **Do not add `--text`** to any command — parse
the JSON instead.

## Rules

- **Follow all step instructions exactly** — do not skip, improvise, or reinterpret
- **Never work around transitions** — if a FAIL handler retries or GOTOs, that is correct behavior; do not override it
- **Complete ALL steps** — do not abandon a runbook mid-execution
- **Use the CLI** — always use `rundown pass`/`rundown fail` to respond, not just verbal acknowledgment

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Verbal "done" instead of CLI | Always `rundown pass` or `rundown fail` |
| Skipping steps | Follow every step — runbook controls flow |
| Bare `rundown pass` with substeps active | Use `rundown pass --step 2.1` |
| Bare `rundown pass`/`rundown fail` in a claimed child | Use `rundown pass --claim-id <claim_id>` to report to the parent |
| Bare mutating command on a delegation-exposed run | Refused with `ACTOR_CONTEXT_REQUIRED`; name your lane — `--run <rd_…>` (orchestrator) or `--claim-id <claim_id>` (child) |
| Claimed child keeps going after reporting | Stop after `rundown pass --claim-id`; the parent's next steps belong to the orchestrator, not you |
| Abandoning without `rundown stop` | Complete all steps or explicitly stop |

## Reference

- [Runbook patterns and examples](../../../../runbooks/README.md)
- [Rundown specification](../../../../docs/spec/language.md)
- [CLI reference](../../../../docs/reference/cli.md)
- [Project overview and command list](../../../../CLAUDE.md)

## Prompted Mode

> Included for completeness. **Automatic execution is the default and the typical usage** — reach for `--prompted` only when you explicitly need to step through manually. Nothing above requires it.

`--prompted` suppresses auto-execution: command steps do NOT run automatically — you see the command and advance manually with `rundown pass` / `rundown fail`. Use `--step <n>` to jump (requires `--prompted`).

**Nested runbooks under `--prompted`.** Because auto-launch is suppressed, launch an inline child explicitly with `--step` pointing at the parent substep:

```bash
rundown run <child-runbook> --step 1.1
```

For a FOR loop iteration, add `--index`:

```bash
rundown run <child-runbook> --step 1.1 --index 3
```
