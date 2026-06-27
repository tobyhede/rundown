# Artifacts Boundary Channel — Design

- **Date:** 2026-06-28
- **Status:** Approved (design)
- **Issue:** [#480](https://github.com/tobyhede/rundown/issues/480) — `--artifacts` boundary channel for input artifacts
- **Motivating issue:** [#467](https://github.com/tobyhede/rundown/issues/467) — standalone `execute-plan` consuming a plan artifact

## Problem

Artifacts can already enter a run by being produced by a step or by overloading
the variable channel: `--input KEY=rd://artifacts/<ctx>/<run>/<key>`. Core
rehydrates any `rd://` value into a branded `TrustedArtifactValue` unconditionally
— `resolveVariableLayers` passes `artifactInputs: true` for **every** layer
(`packages/core/src/runbook/variable-preparation.ts:485`), and the naked
`ARTIFACTS - KEY` consumer accepts a `TrustedArtifactValue` by reference
(`packages/core/src/runbook/artifact-directive-resolver.ts:647`).

The capability works, but the **boundary contract is implicit**:

- The artifact-vs-variable distinction is recovered at runtime by sniffing the
  `rd://` prefix of a string value — a runtime string discriminant, contrary to
  the project's type-driven-dispatch principle.
- A runbook cannot **declare** that it expects an artifact: frontmatter
  `artifacts:` is currently a hard error
  (`packages/parser/src/frontmatter.ts:188-193`).
- The expected-artifact surface is invisible to `rd ls` / discovery and cannot
  be marked required.
- `--input` quietly does double duty (scalar variables *and* artifact imports),
  which is the very ambiguity that blocks a clean `execute-plan` contract (#467).

This is a clarity / contract / discoverability defect, not a missing capability.

## Goals

- Introduce a dedicated **artifact channel** at the runbook boundary, symmetric
  with the variable channel, so input artifacts are declared and supplied
  distinctly from input variables.
- Make the boundary kind **explicit and declarable**, not inferred from a value's
  shape.
- Reuse existing components (typed-value routing, manifest rehydration, frontmatter
  declaration validation, CLI option parsing) rather than building a parallel
  subsystem.

## Non-goals

- No change to the step-level naked `ARTIFACTS - KEY` consumer.
- No change to template projection (`{{X}}` vs `{{artifact X}}`).
- No minting of manifest rows from external on-disk files via this channel
  (read-only rehydration only; the producer form `ARTIFACTS - KEY "{{...}}"`
  remains the path for that rare case).
- No persisted-state migration (this is a boundary/parse-time contract; it does
  not touch `.rundown/` run state).

## Core invariants

1. **Single namespace.** `inputs ∪ artifacts` is one flat namespace. A name
   belongs to exactly one channel. A name declared in both `inputs:` and
   `artifacts:` is a **collision error**. `{{X}}` and `required: [X]` resolve to
   the single `X`, regardless of channel.
2. **Clean break.** Artifacts rehydrate **only** via the artifact channel.
   `--input X=rd://…` is now treated as a plain string (no rehydration). This
   removes the double duty of `--input` and makes the boundary unambiguous.
3. **Read-only.** The channel rehydrates **existing** manifest rows. A value that
   is not an `rd://artifacts/…` URI (or JSON array of such URIs) is a hard error.
   The channel never mints new manifest rows.
4. **`required:` is the only supply-time gate.** Channels are otherwise
   open/permissive, mirroring today's `inputs:`. Declaration documents a name and
   defines membership for `required:`; it does not gate what may be supplied.

## Design

### 1. Frontmatter `artifacts:`

- Remove the guard at `packages/parser/src/frontmatter.ts:188-193` that emits
  `"ARTIFACTS is invalid in frontmatter; …"`. **This intentionally reverses a
  prior decision** that ARTIFACTS is frontmatter-invalid; the original decision
  did not consider the import-at-boundary case that #467 surfaced.
- Add an `artifacts:` validator cloned from `filterInputDeclarations`
  (`frontmatter.ts:226`): a YAML sequence of bare identifier strings,
  declarations-only (no values), with duplicate and non-string diagnostics.
- Add `artifacts` to the frontmatter key allowlist / `RunbookFrontmatterSchema`
  and to `normalizeKnownFrontmatterKeys` casing normalization.
- **Collision check:** any name present in both `inputs` and `artifacts` emits an
  error diagnostic.
- **Required over the union:** widen `validateRequiredSubset` (currently
  `required ⊆ inputs`) to `required ⊆ inputs ∪ artifacts`.

Example:

```yaml
---
name: execute-plan
inputs:
  - environment
artifacts:
  - PlanPath
required:
  - PlanPath        # validated against inputs ∪ artifacts
---
```

### 2. CLI surface

- Add `--artifacts KEY=<rd:// uri>` and `--artifacts-json KEY=<json array of uris>`,
  cloned from `parseInputOption` / `parseInputJsonOption`
  (`packages/cli/src/helpers/option-utils.ts:41,77`) and collected with the same
  `collect` accumulator.
- Register the flags on the same commands that accept `--input`: `run`,
  `delegate`, `claim`, `resolve`.
- JSON output remains the default; no `--text`-only behaviour is introduced.

### 3. Core routing — the clean break

- `--artifacts` values form a **new layer** fed into the existing
  `resolveVariableLayers` pipeline.
- The artifacts layer routes with `artifactInputs: true`; **all variable layers
  now route with `artifactInputs: false`** — the change at
  `variable-preparation.ts:485`, which currently hardcodes `true` for every layer.
- Existing rehydration is reused unchanged: `resolveArtifactInputValue` (scalar
  `rd://` and JSON-array transport) and `readExactArtifactRecordArrayFromManifest`
  (`packages/core/src/runbook/artifact-inputs.ts`). Because both scalar and array
  forms already flow through this path, **array artifact inputs are supported for
  free** (e.g. `FOR plan IN {{ Plans }}`).
- **Cross-channel value collision:** the same key supplied via both `--input` and
  `--artifacts` is an error, consistent with the single-namespace invariant.

### 4. Consumer & projection — unchanged

- The naked `ARTIFACTS - KEY` consumer (`resolveNakedDeclaration`,
  `artifact-directive-resolver.ts:647`) is unchanged: it already early-returns a
  branded `TrustedArtifactValue` by reference and rejects unbranded
  artifact-shaped values. A `--artifacts`-supplied value reaches it branded, via
  the manifest reader, exactly as a `--input rd://` value does today.
- Projection is unchanged: `{{PlanPath}}` → local path; `{{artifact PlanPath}}` →
  canonical `rd://` URI.

## Architectural alignment

- **State machine drives logic / CLI is a thin wrapper.** `--artifacts` is pure
  ingress: the CLI parses and forwards typed values; core does all binding and
  rehydration. This is a Category B side effect (machine-owned filesystem read of
  the manifest). No runbook logic moves to the CLI.
- **Type-driven dispatch.** Replaces an implicit `rd://`-prefix value-shape
  discriminant with an explicit declared channel.
- **No silent mapping / no synthetic IDs.** The channel reuses XState-native
  layering and the existing manifest URI scheme.
- **No persisted-state migration.** Boundary/parse-time contract only.

## Out of scope (deferred)

These are explicitly deferred to keep the first cut small; each is cheap to add
later because the transport already exists:

- `RD_ARTIFACT_*` environment-variable bridge and `.rundown/config.yaml` artifact
  sources.
- Delegation **inheritance** of artifacts to child runbooks (the `--artifacts`
  flag exists on `delegate`/`claim`; auto-pass-to-child semantics are deferred).
- Selector / glob artifact URIs.

## Testing

- **Parser** (`packages/parser`): `artifacts:` declaration validation (valid list,
  non-sequence, non-string entry, duplicates); `inputs`/`artifacts` collision
  diagnostic; `required` validated over `inputs ∪ artifacts`; the former
  frontmatter-ARTIFACTS error is gone.
- **Core** (`packages/core`): clean break — `--input X=rd://…` is no longer
  rehydrated (stays a string); artifact-layer rehydration for scalar and array
  forms produces branded `TrustedArtifactValue`s; cross-channel value collision
  error; `MISSING_REQUIRED_VARS` fires for a required artifact that is not
  supplied; naked consumer accepts the branded value unchanged.
- **CLI** (`packages/cli`): `--artifacts` / `--artifacts-json` parsing and
  layering; end-to-end `rd run` with `--artifacts`; non-`rd://` value rejected.

## Files touched

- `packages/parser/src/frontmatter.ts` — remove guard (188-193); add `artifacts`
  validator (clone of `filterInputDeclarations`, 226); add collision check; widen
  `validateRequiredSubset` (200/337); extend key allowlist (31-32) and
  `RunbookFrontmatterSchema`.
- `packages/parser/src/ast.ts` — frontmatter `artifacts` field type (distinct from
  the existing step-level `artifacts` directive at 190-197).
- `packages/core/src/runbook/variable-preparation.ts` — per-layer `artifactInputs`
  (clean break at 485); new artifacts layer; cross-channel collision; widened
  required check (836-851); `required ⊆ inputs ∪ artifacts`.
- `packages/core/src/runbook/artifact-inputs.ts` — reused unchanged
  (rehydration readers).
- `packages/core/src/runbook/artifact-directive-resolver.ts` — unchanged (naked
  consumer).
- `packages/cli/src/helpers/option-utils.ts` — `--artifacts` / `--artifacts-json`
  parse helpers (clone of `parseInputOption` / `parseInputJsonOption`).
- `packages/cli/src/services/variable-discovery.ts` — parallel artifact layering
  path.
- `packages/cli/src/commands/{run,delegate,claim,resolve}.ts` — register the
  flags.
- Docs: `docs/spec/language.md` (§9/§10 boundary channels), `docs/reference/cli.md`
  (`--artifacts` flags), and the `executing-plans` skill once built (current-state
  docs are descriptive and edited when the code lands).
