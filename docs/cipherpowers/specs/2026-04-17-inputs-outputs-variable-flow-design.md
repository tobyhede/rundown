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

**`inputs:` replaces `vars:`.** The `vars:` frontmatter field is removed. All variable declarations — whether received from a caller or defaulted for standalone use — are declared in `inputs:`.

Each `inputs:` entry is either:
- A bare name (`- PlanPath`) — no default; must be provided by the caller, CLI, env, or config
- A `name: default` pair (`- environment: staging`) — has a default value used when no higher-precedence source provides it

**Parsing rule for `outputs:` list entries:** the first whitespace-delimited token is the output variable name. Everything after the first whitespace is the value expression. If no whitespace is present, the entry is a bare variable reference: the variable name is both the key and the source variable looked up in the variable space by name.

---

**`inputs:`** — declares which variables this runbook accepts and, optionally, their defaults. The parent reads the child's `inputs:` declaration at **delegate time** and derives the `--var` flags to forward. Those flags travel with the delegation token and arrive at the child as level-1 CLI variables when the child is claimed. Variables not listed in `inputs:` are not forwarded by the parent.

- Forwarded `inputs:` variables arrive at **level 1 (CLI flags)** in the child's precedence order — passed as `--var` flags derived from the parent's variable space at delegate time.
- `inputs:` default values (bare `name: value` entries) sit at **level 5** — below runtime output injection and config, above built-in defaults.
- When run **standalone** (via `rd run` with no parent), no cross-boundary injection occurs. `inputs:` defaults apply normally; `required:` validation applies against all sources.
- Variables passed explicitly via CLI `--var` at claim time are not affected by `inputs:` filtering. Explicit `--var` flags always apply at level 1 regardless.
- `inputs:` is distinct from `required:`. `inputs:` declares the variables and optional defaults; `required:` enforces that a variable is present from any source at resolution time. Because forwarded `inputs:` variables arrive as level-1 CLI flags, a variable in both lists will satisfy `required:` if the caller provides it.
- **Variables expected from a child's `outputs:` cannot be declared in the parent's `required:`**. Child outputs are injected during execution; `required:` is validated at resolution time before execution begins.
- If `inputs:` is absent from frontmatter, no variables are declared and no cross-boundary forwarding occurs.
- **Breaking change:** `vars:` is removed. Existing frontmatter `vars:` blocks must be migrated to `inputs:` with the same key-value pairs.
- **Breaking change:** `inputs:` previously read from `outputs.json`. Under this design it defines the boundary contract and declares defaults.

---

**`outputs:`** — declares which variables are exported when the runbook terminates. Runbook `outputs:` are **orthogonal to runbook status**: they are evaluated and injected into the caller's variable space on **every** runbook termination — whether the runbook completes normally, completes early (`rd complete`), or is stopped (`rd stop`). The output represents the final state of the variable space at the point of termination.

- Value expression failures follow the same non-fatal rule as step OUTPUTS: logged, `ERROR_OCCURRED` emitted, that output silently omitted.
- If a declared output variable is absent from the variable space at termination time (e.g. because the producing step was never reached), that output is silently omitted — non-fatal.
- Injected `outputs:` values land at **level 4 (runtime output injection)** in the parent's precedence order — overriding the parent's `inputs:` defaults but overridden by CLI flags, env vars, and config.
- If `outputs:` is absent, nothing is exported to the caller.

### Variable precedence

The full precedence order (high to low). `vars:` is removed; `inputs:` defaults replace it at level 5.

| Level | Source |
|-------|--------|
| 1 | CLI flags (`--var`, `--var-json`, `--var-file`) — includes caller-derived `--var` from `inputs:` forwarding |
| 2 | `RD_VAR_*` environment variables |
| 3 | `.rundown/config.yaml` |
| **4** | **Runtime output injection** ← child `outputs:` land here (new) |
| 5 | `inputs:` defaults (declared in frontmatter, replaces `vars:`) |
| 6 | Built-in defaults |

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

[termination — COMPLETE or STOP]
  → parent reads child frontmatter outputs: declaration
  → parent evaluates and injects declared outputs into parent variable space at level 4
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

- **`vars:` is removed.** All variable declarations migrate to `inputs:`. Key-value pairs with defaults (`- environment: staging`) replace `vars:` entries.
- `inputs:` semantics change: previously injected from `outputs.json`; now defines the boundary contract, declares defaults, and is resolved at delegate time. Variables arrive in the child as level-1 `--var` flags.
- `outputs:` frontmatter field is new. Evaluated on **every** termination (COMPLETE, `rd complete`, `rd stop`) — orthogonal to runbook status.
- Step OUTPUTS evaluation changes: previously evaluated on PASS only; now evaluated on every step completion regardless of PASS or FAIL.
- Step OUTPUTS storage: previously `outputs.json`; now XState machine context. Syntax and evaluation semantics unchanged.
- Step-level `- INPUTS` directives removed from the format.
- `outputs.json` context store removed.
- Variable precedence: `vars:` level (previously 4) replaced by `inputs:` defaults at level 5; new runtime output injection level at 4.

## What does NOT change

- Template variable syntax (`{{ variableName }}`) — unchanged
- `required:` field semantics — unchanged (validated at resolution time from any source)
- Step OUTPUTS value expression syntax — unchanged
- Delegation and claim variable passing via explicit `--var` — unchanged

## Migration

- **`vars:` is removed.** All frontmatter `vars:` blocks must be rewritten as `inputs:` entries. A `vars: environment: staging` entry becomes `inputs: - environment: staging`.
- **`outputs.json` is removed.** External tooling reading `.rundown/contexts/<ContextId>/outputs.json` must be updated to use `rd status` JSON output or the new boundary contract.
- **`inputs:` semantics change.** Runbooks using `inputs:` to read from `outputs.json` must be updated; that behaviour is gone.
- **Step-level `- INPUTS` directives** must be removed. The parser rejects them; `rd check` will report a parse error.
- Run state schema bumped; active runbooks must be completed before upgrading.
