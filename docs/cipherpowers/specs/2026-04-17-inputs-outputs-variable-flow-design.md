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
- Value expression syntax is unchanged from the existing step OUTPUTS implementation: helper calls (`{{ path "file.json" }}`), template variable references (`{{ VarName }}`), quoted literals (`"value"`), and bare variable references (`VarName`).
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
  - Environment
outputs:
  - PlanPath
  - PlanSummary {{ path "summary.txt" }}
---
```

**Parsing rule for `outputs:` list entries:** the first whitespace-delimited token is the output variable name. Everything after the first whitespace is the value expression. If no whitespace is present, the entry is a bare variable reference: the variable name is both the key and the source variable looked up in the variable space. This is the same parsing rule as existing step OUTPUTS declarations.

---

**`inputs:`** — declares which variables this runbook receives from its caller. The parent reads the child's `inputs:` declaration at **delegate time** (when creating the delegation token) and derives the `--var` flags to forward. Those flags travel with the delegation token and arrive at the child as level-1 CLI variables when the child is claimed. Variables not listed in `inputs:` are not forwarded by the parent.

`inputs:` replaces `vars:` as the mechanism for declaring variables a runbook expects to receive from a caller. Use `inputs:` for cross-runbook variable contracts; use `vars:` only for truly local defaults (values that make sense when running the runbook standalone). A variable that must come from a parent belongs in `inputs:`, not `vars:`.

- Forwarded `inputs:` variables arrive at **level 1 (CLI flags)** in the child's precedence order — passed as `--var` flags derived from the parent's variable space at delegate time.
- When run **standalone** (via `rd run` with no parent), `inputs:` is a no-op: there is no caller variable space to read from. No error is raised. `required:` validation then applies normally against all remaining sources.
- Variables passed explicitly via CLI `--var` at claim time (level 1) are not affected by `inputs:` filtering. `inputs:` controls what flows automatically across the boundary; explicit `--var` flags always apply regardless.
- `inputs:` is distinct from `required:`. `inputs:` controls which variables are received from the caller; `required:` enforces that a variable is present from any source at resolution time. Because `inputs:` variables arrive as level-1 CLI flags, a variable in both lists will satisfy `required:` if the caller provides it.
- A variable in `required:` but not in `inputs:` will not cross the boundary automatically — it must arrive via CLI flags, `RD_VAR_*`, config, or `vars:`.
- **Variables expected from a child's `outputs:` cannot be declared in the parent's `required:`**. Child outputs are injected during execution (after the child completes); `required:` is validated at resolution time before execution begins.
- If `inputs:` is absent from frontmatter, no variables are forwarded from the caller.
- **Breaking change** from the current `inputs:` behaviour: previously `inputs:` read from `outputs.json` at startup. Under this design it defines the cross-runbook boundary contract. Existing runbooks using `inputs:` will no longer work without updates.

---

**`outputs:`** — declares which variables are exported when the runbook completes. Supports the same value expression syntax as step OUTPUTS (see parsing rule above). On completion — including early completion via `rd complete` — declared outputs are evaluated from the current variable space and injected into the caller's variable space.

- `rd stop` **aborts** the runbook; `outputs:` are **not** evaluated on abort. Both `rd complete` (early completion) and normal last-step completion are completion paths that trigger output injection.
- Injected `outputs:` values land at **level 4 (runtime output injection)** in the precedence order — between `.rundown/config.yaml` (level 3) and frontmatter `vars:` (level 5). This means child-computed values override the parent's authored defaults (`vars:`) but are overridden by CLI flags, env vars, and config files.
- Value expression evaluation failures in frontmatter `outputs:` follow the same non-fatal rule as step OUTPUTS: logged, `ERROR_OCCURRED` emitted, output silently omitted.
- If a declared output variable is absent from the variable space at completion time (e.g. because the producing step was never reached), that output is silently omitted — non-fatal.
- If `outputs:` is absent, nothing is exported to the caller.
- Both `inputs:` and `outputs:` must be explicitly declared; if absent, nothing is received / nothing is exported.

### Variable precedence

The full precedence order (high to low), updated to add level 4:

| Level | Source |
|-------|--------|
| 1 | CLI flags (`--var`, `--var-json`, `--var-file`) |
| 2 | `RD_VAR_*` environment variables |
| 3 | `.rundown/config.yaml` |
| **4** | **Runtime output injection** ← child `outputs:` land here (new) |
| 5 | Frontmatter `vars:` |
| 6 | Delegation inheritance / `inputs:` injection |
| 7 | Built-in defaults |

### Cross-runbook flow

When a parent step runs a child runbook:

```
[delegate time]
  Parent variable space
  → parent reads child frontmatter inputs: declaration
  → parent derives --var flags from its variable space for each declared input
  → --var flags are encoded into the delegation token

[claim time]
  → child process starts; --var flags from token arrive as level 1 CLI variables
  → child executes; step OUTPUTS update child's variable space
  → child completes; parent reads child frontmatter outputs: declaration
  → parent evaluates and injects declared outputs into parent variable space at level 4
  → parent continues with updated variables
```

The injection mechanism uses the existing `--var` delegation path: the parent automatically derives which `--var` flags to encode based on the child's `inputs:` declaration at delegate time. No new cross-process communication channel is introduced. Delegation and claim variable passing via explicit `--var` flags is **unchanged** and remains at level 1.

### State machine integration

- The variable space (including step-produced values) is stored in XState machine context using the existing variable value types (string, number, boolean, JsonArray, JsonObject, JsonArrayStream)
- Step OUTPUTS are evaluated via `assign` actions on step completion, before the transition action is dispatched
- Runbook `outputs:` are evaluated at runbook completion and returned to the caller
- `outputs.json` is replaced by machine context serialisation — persistence is automatic with run state

### Observability

- `rd status` JSON output includes the current variable space (all step-produced values visible at the current execution point). The exact schema field is left to implementation.
- Missing required inputs (`required:` field) remain a hard error at resolution time.

## What changes

- `inputs:` frontmatter semantics are **breaking**: previously injected from `outputs.json`; now defines the cross-runbook boundary contract. Resolved at **delegate time** — the parent derives `--var` flags from the child's `inputs:` declaration when creating the delegation token; they arrive in the child at level 1.
- `inputs:` replaces `vars:` for cross-runbook variable declarations. Variables expected from a parent belong in `inputs:`, not `vars:`. The `vars:` field is unchanged — it remains for local defaults only.
- `outputs:` frontmatter field is new
- Step OUTPUTS evaluation changes: previously evaluated on PASS only; now evaluated on every step completion regardless of PASS or FAIL.
- Step OUTPUTS storage mechanism changes: previously written to `outputs.json`; now stored in XState machine context. Syntax and evaluation semantics are unchanged.
- Step-level `- INPUTS` directives are removed from the format
- `outputs.json` context store is removed
- Variable precedence gains a new level 4 (runtime output injection) between config and `vars:`; existing levels 4–6 shift to 5–7

## What does NOT change

- Template variable syntax (`{{ variableName }}`) — unchanged
- `required:` field semantics — unchanged (validated at resolution time from any source)
- Step OUTPUTS value expression syntax and evaluation semantics — unchanged
- Delegation and claim variable passing via `--var` — unchanged

## Migration

- **`outputs.json` is removed.** External tooling, shell scripts, CI pipelines, or MCP server components reading `.rundown/contexts/<ContextId>/outputs.json` directly must be updated to use `rd status` JSON output or variable injection via the new boundary contract.
- **`inputs:` is a breaking change.** All runbooks using `inputs:` must be updated. Previously they read from `outputs.json`; now they declare which variables to receive from a caller. Runbooks run standalone will silently receive nothing via `inputs:` — variables must arrive via CLI flags, env, config, or `vars:`.
- Step-level `- INPUTS` directives must be removed from existing runbooks. The `- INPUTS` form is removed from the parser; `rd check` will report a parse error on any runbook that still contains it.
- Run state schema is bumped; active runbooks must be completed before upgrading (consistent with the project's no-migration-of-live-state principle).
