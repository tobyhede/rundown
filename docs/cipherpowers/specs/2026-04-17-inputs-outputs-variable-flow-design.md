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

Runbook frontmatter declares its interface:

```yaml
---
name: write-plan
inputs:
  - ContextId
  - environment: staging
  - port: 3000
outputs:
  - PlanPath
  - PlanSummary {{ path "summary.txt" }}
---
```

**`inputs:` is a rename of `vars:`.** The frontmatter `vars:` field is removed and replaced by `inputs:` with identical syntax, identical semantics, and identical precedence. No behaviour changes. The rename signals intent — these are variables the runbook accepts from outside — but the default-value and resolution mechanics are unchanged.

The CLI `--var`, `--var-json`, and `--var-file` flags are completely unaffected.

Each `inputs:` entry uses the same syntax as `vars:`:
- A bare name (`- PlanPath`) — no default; must be provided via CLI, env, or config
- A `name: default` pair (`- environment: staging`) — has a default value used when no higher-precedence source provides it

**Parsing rule for `outputs:` list entries:** the first whitespace-delimited token is the output variable name. Everything after the first whitespace is the value expression. If no whitespace is present, the entry is a bare variable reference: the variable name is both the key and the source variable looked up in the variable space by name.

---

**`inputs:`** — the renamed `vars:` field. Declares variables and optional defaults. Behaviour is identical to `vars:` in all respects: same precedence (level 4), same resolution order, same syntax.

The additional cross-runbook behaviour layered on top of the rename: the parent reads the child's `inputs:` declaration at **delegate time** and encodes the matching variable values into the delegation token. When the child is **claimed**, those values are automatically available — no manual `--var` flags required. This is the standard flow.

`rd claim <token> --var key=value` is an **escape hatch** to override a specific variable at claim time. It follows standard variable precedence (level 1 CLI flag) and overrides whatever value was encoded in the token. General practice is to let the token carry the variables.

- `inputs:` defaults sit at **level 4** — unchanged from `vars:`.
- When run **standalone**, `inputs:` defaults apply exactly as `vars:` did.
- `inputs:` is distinct from `required:`. `inputs:` declares variables and defaults; `required:` enforces presence from any source at resolution time.
- **Variables expected from a child's `outputs:` cannot be declared in the parent's `required:`**. Child outputs are injected during execution; `required:` is validated at resolution time before execution begins.
- **Breaking change (rename only):** `vars:` is removed. Existing frontmatter `vars:` blocks must be renamed to `inputs:`. No other changes required.
- **Breaking change (prior `inputs:` semantics):** `inputs:` previously read from `outputs.json`. That behaviour is gone.

---

**`outputs:`** — declares which variables are exported when the runbook terminates. Runbook `outputs:` are **orthogonal to runbook status**: they are evaluated and injected into the caller's variable space on **every** runbook termination — whether the runbook completes normally, completes early (`rd complete`), or is stopped (`rd stop`). The output represents the final state of the variable space at the point of termination.

- Value expression failures follow the same non-fatal rule as step OUTPUTS: logged, `ERROR_OCCURRED` emitted, that output silently omitted.
- If a declared output variable is absent from the variable space at termination time (e.g. because the producing step was never reached), that output is silently omitted — non-fatal.
- Injected `outputs:` values are runtime mutations to the parent's variable space — they overwrite any existing value for that variable, regardless of its original source.
- If `outputs:` is absent, nothing is exported to the caller.

### Variable precedence

The precedence table governs **initial resolution** — how the variable space is populated before execution begins. It does not apply to runtime mutations.

| Level | Source |
|-------|--------|
| 1 | CLI flags (`--var`, `--var-json`, `--var-file`) — includes caller-derived `--var` from `inputs:` forwarding |
| 2 | `RD_VAR_*` environment variables |
| 3 | `.rundown/config.yaml` |
| 4 | `inputs:` defaults (renamed from `vars:`) |
| 5 | Built-in defaults |

**Step OUTPUTS are runtime mutations, not a precedence level.** When a step produces an output, it overwrites the variable in the variable space directly — regardless of how that variable was originally set (CLI flag, env, config, or default). A step OUTPUTS `Blah "vtha"` will overwrite `Blah` even if the user passed `--var Blah=hello`. This takes effect immediately for all subsequent steps.

Child `outputs:` injected into the parent at termination follow the same rule: they are runtime mutations that overwrite the parent's variable space directly.

### Cross-runbook flow

When a parent step runs a child runbook:

```
[delegate time]
  Parent variable space
  → parent reads child frontmatter inputs: declaration
  → parent encodes matching variable values into the delegation token

[claim time — standard]
  → child process starts
  → inputs: variables from the token are automatically available in the child
  → no --var flags required from the claimer

[claim time — escape hatch]
  → rd claim <token> --var key=override
  → overrides a specific variable at level 1, takes precedence over token values
  → use sparingly; standard practice is to let the token carry all inputs

[child execution]
  → child executes; step OUTPUTS mutate child's variable space

[termination — COMPLETE or STOP]
  → parent reads child frontmatter outputs: declaration
  → parent mutates its variable space with declared output values
  → parent continues with updated variables
```

### State machine integration

- The variable space (including step-produced values) is stored in XState machine context using the existing variable value types (string, number, boolean, JsonArray, JsonObject, JsonArrayStream)
- Step OUTPUTS are evaluated via `assign` actions on step completion, before the transition action is dispatched
- Runbook `outputs:` are evaluated at every runbook termination and returned to the caller
- `outputs.json` is replaced by machine context serialisation — persistence is automatic with run state

### Observability

- `rd status` JSON output includes the current variable space (all step-produced values visible at the current execution point). The exact schema field is left to implementation.
- Missing required variables (`required:` field) remain a hard error at resolution time.

## What changes

- **`vars:` renamed to `inputs:`.** Identical syntax and behaviour — a find-and-replace migration.
- **`inputs:` gains cross-runbook forwarding:** at delegate time, the parent auto-derives `--var` flags from the child's `inputs:` declaration. No behaviour change when run standalone.
- **Prior `inputs:` semantics removed:** `inputs:` no longer reads from `outputs.json`.
- **`outputs:` frontmatter field is new.** Evaluated on every termination (COMPLETE, `rd complete`, `rd stop`) — orthogonal to runbook status.
- **Step OUTPUTS evaluation:** previously PASS only; now every step completion regardless of PASS or FAIL.
- **Step OUTPUTS storage:** previously `outputs.json`; now XState machine context. Syntax and evaluation semantics unchanged.
- **Step-level `- INPUTS` directives** removed from the format.
- **`outputs.json` context store** removed.
- **Variable precedence:** `vars:` level renamed to `inputs:` defaults (level 4, same position). Step OUTPUTS and child `outputs:` are runtime mutations — they are not a precedence level and overwrite the variable space directly.

## What does NOT change

- Template variable syntax (`{{ variableName }}`) — unchanged
- CLI `--var`, `--var-json`, `--var-file` flags — unchanged
- `required:` field semantics — unchanged
- Step OUTPUTS value expression syntax — unchanged
- Delegation and claim variable passing via explicit `--var` — unchanged
- `inputs:` / `vars:` precedence level (level 4) — unchanged

## Migration

- **`vars:` → `inputs:`** in all frontmatter. Rename only; no other changes required.
- **`outputs.json` is removed.** External tooling reading `.rundown/contexts/<ContextId>/outputs.json` must be updated to use `rd status` JSON output or the new boundary contract.
- **Prior `inputs:` usage** (reading from `outputs.json`) must be replaced with the new boundary contract via `outputs:` and cross-runbook forwarding.
- **Step-level `- INPUTS` directives** must be removed. The parser rejects them; `rd check` will report a parse error.
- Run state schema bumped; active runbooks must be completed before upgrading.
