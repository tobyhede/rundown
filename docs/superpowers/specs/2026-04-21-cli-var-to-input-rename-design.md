# Design: Rename `--var` → `--input` CLI Flags

**Date:** 2026-04-21
**Status:** Approved

## Summary

Rename the CLI variable-passing flags (`--var`, `--var-json`, `--var-file`) and the `RD_VAR_*` environment bridge to `--input`, `--input-json`, `--input-file`, and `RD_INPUT_*`. Rename internal TypeScript property names to match. No aliases, no deprecation — clean lift and shift.

## Motivation

The recent addition of `inputs:` and `outputs:` frontmatter fields establishes a runbook's declared interface. The CLI flags that provide values to that interface should use the same vocabulary. `--input` aligns with `inputs:`, making the mental model explicit:

- Frontmatter `inputs:` declares defaults and the runbook's variable interface
- `--input` provides values for that interface at invocation time
- `required:` declares which inputs the caller must provide

The old name `--var` was accurate (it sets template variables) but generic. `--input` is more precise about the role: you are providing inputs to a runbook. This also applies to built-in overrides (`--input ContextId=sprint-42`) — those are still inputs to the execution context.

## Rename Map

| Old (CLI) | New (CLI) |
|---|---|
| `--var <key=value>` | `--input <key=value>` |
| `--var-json <key=json>` | `--input-json <key=json>` |
| `--var-file <path>` | `--input-file <path>` |
| `RD_VAR_*` | `RD_INPUT_*` |

| Old (TypeScript) | New (TypeScript) |
|---|---|
| `varFile` | `inputFile` |
| `varJson` | `inputJson` |
| `var` (property) | `input` |
| `varOpts` | `inputOpts` |
| `ENV_VAR_PREFIX` | `ENV_INPUT_PREFIX` (value `'RD_INPUT_'`) |

## Scope

All changes are mechanical string/identifier replacements. No logic changes.

### packages/cli/src — 9 files
- `commands/run.ts` — option definitions, options interface, varOpts assignment
- `commands/claim.ts` — option definitions, options interface, varOpts passthrough
- `commands/delegate.ts` — option definitions, options interface, varOpts passthrough
- `commands/resolve.ts` — option definitions, options interface, varOpts passthrough
- `helpers/option-utils.ts` — comments, error messages referencing flag names
- `helpers/runbook-pipeline.ts` — VarOpts interface, error messages, comments
- `helpers/command-sequence.ts` — string literal `'--var-file'` used to scan scenario commands
- `helpers/scenario-workflow.ts` — `varFiles`/`varFileDirs` local variable names
- `services/variable-discovery.ts` — `ENV_VAR_PREFIX` constant → `ENV_INPUT_PREFIX`, interfaces, comments, error messages

### packages/claude-code-plugin/src — 1 file (live code)
- `workflow/hooks/delegation-dispatch.ts:86` — generates `--var key=value` flag strings passed to the CLI

### packages/core/src — 1 file (comments only)
- `runbook/types.ts` — JSDoc comments referencing `--var-json`

### packages/parser/src — 1 file (comments only)
- `reserved.ts` — JSDoc comment referencing `--var`

### Tests — 14 files (~200+ touch points)
- CLI argument strings in invocations
- `RD_VAR_*` → `RD_INPUT_*` env assignments in test setup/teardown
- `varFile`/`varJson` property names in option objects passed to service functions

### Documentation — 29 files (~175+ references)
- `CLAUDE.md` — command reference tables and examples
- `README.md` — quick-start examples
- `docs/SPEC.md`, `docs/RUNDOWN.md`, `docs/FORMAT.md`, `docs/SECURITY.md`, `docs/MCP.md`, `docs/PROJECT-INTEGRATION.md`, `docs/AGENT-ORCHESTRATION.md`
- `runbooks/` — 15+ example runbook files with `rd run --var` invocations
- `packages/claude-code-plugin/skills/` — `running-runbooks`, `writing-runbooks`, `delegating-runbooks` SKILL.md files
- Prior spec doc in `docs/cipherpowers/specs/`

**Total: ~55 files, ~400 references.**

## Decisions

- **No aliases.** No `--var` fallback, no `RD_VAR_*` fallback. Existing scripts will break and must update.
- **Internal props renamed.** `varFile`, `varJson`, `var` (property) renamed to `inputFile`, `inputJson`, `input` for full consistency. `var` as a property key is also a reserved word in JS, so renaming is a minor cleanup.
- **`RD_INPUT_*` renamed.** The env bridge prefix mirrors the flag name directly; inconsistency here would be confusing.
- **Stryker sandbox files excluded.** `.stryker-tmp/` directories are ephemeral mutation testing artifacts and will be regenerated; they do not need manual updates.

## Out of Scope

- Renaming `vars` field in `rd status` JSON output (`state.vars`, `context.vars.*`) — these are different concepts (the resolved variable space, not the CLI input mechanism) and are not affected by this rename.
- Renaming `vars:` frontmatter field (there is none — frontmatter uses `inputs:` already).
- Any logic changes. This is purely a naming change.
