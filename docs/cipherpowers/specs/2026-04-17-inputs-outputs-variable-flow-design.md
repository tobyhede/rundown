# INPUTS / OUTPUTS Variable Flow Design

**Date:** 2026-04-17
**Status:** Approved

## Problem

INPUTS and OUTPUTS are currently implemented as a file-based side-channel (`outputs.json`), outside the state machine. This violates the core architectural principle that the state machine owns execution state. Specific issues:

- No enforcement: the machine cannot validate that required outputs were produced
- No observability: `rd status` cannot show what values are in flight
- Flat global namespace: all steps and child runbooks write to the same file, last writer wins
- Side-channel: persistence is manual and separate from run state serialisation

## Goal

Make INPUTS/OUTPUTS first-class citizens of the state machine, unified with the existing variable system.

## Design

### Core principle

**Variables are global within a runbook.** The existing variable system is unchanged. INPUTS/OUTPUTS extend it in two ways:

1. **Step OUTPUTS** — steps can produce or update variables during execution
2. **Runbook boundary contract** — `inputs:` / `outputs:` in frontmatter define what flows in and out at runbook boundaries

### Step OUTPUTS

Steps declare OUTPUTS to compute or update variables:

```markdown
## 2. Write plan
- OUTPUTS
  - PlanPath {{ path "plan.json" }}
- PASS CONTINUE
- FAIL STOP
```

Rules:
- Evaluated on **every** step completion, regardless of PASS or FAIL. This is intentional: FAIL paths may need to pass information forward (e.g. an error code or partial result for a recovery step). Authors who want PASS-only output should route FAIL to a step that does not declare the relevant output.
- OUTPUTS are evaluated **before** the transition action is dispatched. All subsequent steps — including GOTO targets — see the updated variable space.
- Add or update variables available to all subsequent steps in the runbook.
- Value expression syntax: helper calls (`{{ path "file.json" }}`), template variable references (`{{ VarName }}`), quoted literals (`"value"`), and bare variable references (`VarName`).
- If a value expression cannot be resolved at evaluation time, the failure is non-fatal: it is logged, an `ERROR_OCCURRED` event is emitted, the variable is left unchanged, and the step's PASS or FAIL transition still fires normally afterward.
- Stored in XState machine context as part of the variable space — part of run state, not a separate file.
- A step that is **skipped** (bypassed via GOTO or never reached) is never completed; its OUTPUTS are never evaluated. Subsequent steps that depend on those variables will find them absent — the author must handle this via transitions.

### Runbook boundary contract

**`inputs:` is a rename of `vars:`.** The frontmatter `vars:` field is removed and replaced by `inputs:` with **identical YAML shape, identical syntax, identical semantics, and identical precedence**. It is a key-value map, exactly as `vars:` was:

```yaml
---
name: write-plan
inputs:
  environment: staging
  port: 3000
  PlanPath:
outputs:
  - PlanPath
  - PlanSummary {{ path "summary.txt" }}
---
```

A key with no value (`PlanPath:`) declares a variable with no default — it must be provided via CLI, env, or config. A key with a value (`environment: staging`) provides a default used when no higher-precedence source supplies it.

Migration: rename `vars:` to `inputs:` in all frontmatter. No other changes required.

The CLI `--var`, `--var-json`, and `--var-file` flags are completely unaffected.

**Parsing rule for `outputs:` list entries:** the first whitespace-delimited token is the output variable name. Everything after the first whitespace is the value expression. If no whitespace is present, the entry is a bare variable reference looked up in the variable space by name.

---

**`inputs:`** — the renamed `vars:` field. Same precedence (level 4), same resolution order, same YAML shape. Behaviour is identical to `vars:` in all respects when run standalone.

The additional cross-runbook behaviour: the plugin, when injecting claim instructions into a child agent's context, reads the child runbook's `inputs:` declaration and reads the parent's current variable space from the parent's run state. It constructs `--var` flags for each declared input and injects them into the `rd claim <token> --var ...` command. The token itself is an opaque identifier — it carries no variable payload. Variables arrive in the child as level-1 CLI flags.

`rd claim <token> --var key=value` is an **escape hatch** to override a specific variable. Standard practice is to let the plugin-injected claim command carry the inputs.

- `inputs:` defaults sit at **level 4** — unchanged from `vars:`.
- When run **standalone**, `inputs:` defaults apply exactly as `vars:` did.
- `inputs:` is distinct from `required:`. `inputs:` declares variables and defaults; `required:` enforces presence from any source at resolution time.
- **Variables expected from a child's `outputs:` cannot be declared in the parent's `required:`**. Child outputs are injected during execution; `required:` is validated at resolution time before execution begins.
- **Breaking change (rename only):** `vars:` is removed. Rename to `inputs:` in all frontmatter.
- **Breaking change (prior `inputs:` semantics):** `inputs:` previously read from `outputs.json`. That behaviour is gone.

---

**`outputs:`** — declares which variables are exported when the runbook terminates. Runbook `outputs:` are **orthogonal to runbook status**: evaluated on **every** runbook termination — normal completion, `rd complete`, or `rd stop`.

**Return path:** at termination, the child's final variable space is persisted as part of its run state (XState machine context → run state file). The parent, upon detecting child completion, reads the child's run state file, extracts the values of variables declared in the child's `outputs:`, and mutates its own variable space with those values. No new file format or communication channel is introduced — this uses the existing run state persistence.

- Value expression failures follow the same non-fatal rule as step OUTPUTS: logged, `ERROR_OCCURRED` emitted, that output silently omitted.
- If a declared output variable is absent from the child's final variable space (e.g. because the producing step was never reached), that output is silently omitted — non-fatal.
- Injected `outputs:` values are runtime mutations to the parent's variable space — they overwrite any existing value, regardless of its original source.
- If `outputs:` is absent, nothing is exported to the caller.

### Variable precedence

The precedence table governs **initial resolution** — how the variable space is populated before execution begins. It does not apply to runtime mutations.

| Level | Source |
|-------|--------|
| 1 | CLI flags (`--var`, `--var-json`, `--var-file`) — includes plugin-injected `--var` from `inputs:` forwarding |
| 2 | `RD_VAR_*` environment variables |
| 3 | `.rundown/config.yaml` |
| 4 | `inputs:` defaults (renamed from `vars:`, same position) |
| 5 | Built-in defaults |

**Step OUTPUTS and child `outputs:` are runtime mutations, not precedence levels.** They overwrite the variable space directly, regardless of how the variable was originally set. A step OUTPUTS `Blah "vtha"` overwrites `Blah` even if the user passed `--var Blah=hello`. This takes effect immediately for all subsequent steps.

### Cross-runbook flow

When a parent step runs a child runbook:

```
[delegate time]
  rd delegate --step 2.1
  → delegation token created (opaque identifier, no variable payload)

[child agent dispatch]
  → parent spawns child agent with RD_CLAIM_TOKEN=rdtk_... in prompt
  → plugin detects token in child agent's context
  → plugin reads child runbook's inputs: declaration
  → plugin reads parent's current variable space from parent's run state
  → plugin injects: rd claim <token> --var A=<val> --var B=<val> ...

[child execution — standard claim]
  → child runs plugin-injected claim command
  → inputs: variables arrive as level-1 CLI flags
  → child executes; step OUTPUTS mutate child's variable space

[claim override — escape hatch]
  → rd claim <token> --var key=override
  → overrides a specific variable; use sparingly

[termination — COMPLETE or STOP]
  → child's final variable space persisted to child's run state file
  → parent reads child's run state, extracts variables declared in outputs:
  → parent mutates its own variable space with those values
  → parent continues with updated variables
```

### State machine integration

- The variable space (including step-produced values) is stored in XState machine context using the existing variable value types (string, number, boolean, JsonArray, JsonObject, JsonArrayStream)
- Step OUTPUTS are evaluated via `assign` actions on step completion, before the transition action is dispatched
- Runbook `outputs:` are evaluated at every runbook termination; values written into the run state before the process exits
- `outputs.json` is replaced by run state serialisation — persistence is automatic

### Observability

- `rd status` JSON output includes a `vars` field: a flat string-to-string map of all variables currently in the variable space, including step-produced values. Example: `{ "vars": { "PlanPath": "/path/to/plan.json", "environment": "staging" } }`.
- Missing required variables (`required:` field) remain a hard error at resolution time.

## What changes

- **`vars:` renamed to `inputs:`.** Identical YAML shape, syntax, semantics, and precedence — a find-and-replace migration.
- **`inputs:` gains cross-runbook forwarding** via plugin-injected `--var` flags at claim time. No behaviour change when run standalone.
- **Prior `inputs:` semantics removed:** `inputs:` no longer reads from `outputs.json`.
- **`outputs:` frontmatter field is new.** Evaluated on every termination; return path is child run state → parent variable space mutation.
- **Step OUTPUTS evaluation:** previously PASS only; now every step completion regardless of PASS or FAIL.
- **Step OUTPUTS storage:** previously `outputs.json`; now XState machine context. Syntax and evaluation semantics unchanged.
- **Step-level `- INPUTS` directives** removed from the format.
- **`outputs.json` context store** removed.
- **`rd status`** gains a `vars` field exposing the current variable space.

## What does NOT change

- Template variable syntax (`{{ variableName }}`) — unchanged
- CLI `--var`, `--var-json`, `--var-file` flags — unchanged
- `required:` field semantics — unchanged
- Step OUTPUTS value expression syntax — unchanged
- `inputs:` / `vars:` precedence level (level 4) — unchanged

## Migration

- **`vars:` → `inputs:`** in all frontmatter. Rename only; YAML shape is identical.
- **`outputs.json` is removed.** External tooling reading `.rundown/contexts/<ContextId>/outputs.json` must be updated to use `rd status --text` or the `vars` field in `rd status` JSON output.
- **Prior `inputs:` usage** (reading from `outputs.json`) must be replaced with the new boundary contract via `outputs:` and cross-runbook forwarding.
- **Step-level `- INPUTS` directives** must be removed. The parser rejects them; `rd check` will report a parse error.
- Run state schema bumped; active runbooks must be completed before upgrading.
