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
- No persisted-state migration. The channel changes ingress resolution, not the
  persisted shape: artifact values still land in `RunbookState.variables` / the
  snapshot exactly as `--input rd://` values do today, with identical type and
  shape (see Architectural alignment § Persistence). No `.rundown/` schema field
  changes type or meaning.

## Core invariants

1. **Single namespace.** `inputs ∪ artifacts` is one flat namespace. A name
   belongs to exactly one channel. A name declared in both `inputs:` and
   `artifacts:` is a **collision error**. `{{X}}` and `required: [X]` resolve to
   the single `X`, regardless of channel.
2. **Clean break.** Artifacts rehydrate **only** via the artifact channel.
   `--input X=rd://…` is now treated as a plain string (no rehydration). This
   removes the double duty of `--input` and makes the boundary unambiguous.
   Note the blast radius: this flips **every** variable layer, including the
   `inherited` layer that carries step OUTPUTS to child runbooks (existing
   behaviour, `docs/spec/language.md §7`). Inherited artifact values survive the
   flip only because they are re-branded at the snapshot seam
   (`effective-vars.ts:320-321`) and pass through `routeVariable`'s object/array
   branches by reference. This is non-obvious and MUST be reasoned about and
   test-pinned, not assumed (see Testing).
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
- Validate `artifacts:` the same way as `inputs:` — a YAML sequence of bare
  identifier strings, declarations-only (no values), with duplicate and
  non-string diagnostics. **Generalise rather than clone, but scope the merge
  correctly.** `filterInputDeclarations` (`frontmatter.ts:226`) is the right
  template: `artifacts:` shares its exact semantics (`raw: unknown`, array guard
  with the "must be a YAML sequence" diagnostic, and empty-array → `undefined`).
  Generalise it over `field: 'inputs' | 'artifacts'` and call it for both.
  **Do not** fold `filterIdentifierArray` (`frontmatter.ts:291`, used for
  `required`) into the same function: although its per-element loop is identical,
  its wrapper differs in load-bearing ways — it takes an already-`unknown[]` (no
  array guard, since the zod schema guarantees it) and maps empty-array →
  `[]` (intentionally preserved), not `undefined`. A naive three-way merge would
  silently flip `required: []` to `undefined`. The clean extraction is either
  (a) generalise `filterInputDeclarations` over `inputs|artifacts` and leave
  `filterIdentifierArray` alone, or (b) extract only the shared per-element
  validator (the four checks: non-string, `!isSafeIdentifier`,
  `isReservedTemplateName`, duplicate) and keep the two wrappers distinct.
- Add the new `artifacts?: string[]` field to the `RunbookFrontmatter` interface
  (`frontmatter.ts:74-84`, beside `inputs?: string[]` at `:80`) and a matching
  `artifacts: z.unknown().optional().catch(undefined)` entry to
  `RunbookFrontmatterSchema` (`frontmatter.ts:105`). Compute it at the existing
  validation call site (`frontmatter.ts:194-195`) and **splice it into the
  assembled return object** (`frontmatter.ts:201-209`, beside `inputs,`) — the
  validated value is otherwise discarded.
- Add `artifacts` to the `NORMALIZED_FRONTMATTER_KEYS` allowlist
  (`frontmatter.ts:25-34`, where `inputs` is at `:32`) so
  `normalizeKnownFrontmatterKeys` lowercases `ARTIFACTS:` like `INPUTS:`.
- **Collision check:** any name present in both `inputs` and `artifacts` emits an
  error diagnostic.
- **Required over the union:** widen `validateRequiredSubset`
  (`frontmatter.ts:200`/`343`, currently `required ⊆ inputs`) to
  `required ⊆ inputs ∪ artifacts`. The `must also be declared in "inputs"`
  diagnostic message widens to name both channels.
- **Iteration-binding inheritance:** `surfaceIterationBinding` currently gates a
  surfaced loop variable on `frontmatter.inputs` only
  (`delegation-context.ts`). Widen it to `inputs ∪ artifacts` so a loop variable
  declared in `artifacts:` (`FOR plan IN {{ Plans }}`) surfaces under delegation,
  consistent with the single-namespace invariant.

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
  collected with the same `collect` accumulator. **Reuse, do not clone, the
  parsers.** `parseInputOption` / `parseInputJsonOption`
  (`packages/cli/src/helpers/option-utils.ts:41,77`) validate only the
  `key=value` / identifier shape; the `rd://` value check is a core
  responsibility (read-only invariant, §3), so a clone would be byte-identical.
  Register the new flags with the **existing** parsers. If a distinct error noun
  is wanted (`artifact` vs `variable`), parameterise the parser with a label
  argument rather than forking it.
- Register the flags on the same commands that accept `--input`: `run`,
  `delegate`, `claim`, `resolve`. There is no shared `addInputOptions(command)`
  helper today — each command registers its input flags ad hoc (`run.ts:64-79`,
  `delegate.ts:70-84`, `claim.ts:135-148`, `resolve.ts:72-85`). The symmetric move
  is to mirror those ad-hoc blocks for `--artifacts`; optionally extract a shared
  `addArtifactOptions` / `addInputOptions` helper (a DRY enhancement beyond strict
  symmetry, not required).
- **Deliberate surface asymmetry.** `--input` has three flags
  (`--input-file`, `--input`, `--input-json`); the artifact channel ships only
  `--artifacts` and `--artifacts-json`. There is **no `--artifacts-file`** — file
  and env/config artifact sources are deferred (see Out of scope). State this
  explicitly so the asymmetry is intentional, not an oversight.
- **Env-inherit arm must be disabled for the artifact channel.** `parseInputOption`
  supports the no-`=` form `--input KEY` → inherit `process.env[KEY]`
  (`option-utils.ts:54-66`). Reused verbatim, `--artifacts KEY` would silently
  inherit an env value — which contradicts the deferral of the `RD_ARTIFACT_*`
  bridge. Suppress the no-`=` arm for the artifact flags (e.g. via the same label
  parameter, or a guard), so an env value cannot leak in through this channel.
- JSON output remains the default; no `--text`-only behaviour is introduced.

### 3. Core routing — the clean break

`--artifacts` values form a **new layer** fed into the existing
`resolveVariableLayers` pipeline. Some of the rehydration machinery is reused
verbatim, but the layer wiring, the must-resolve contract, the required gate, and
collision detection are **new code** — not "reuse unchanged." Each is called out
explicitly below.

**Channel as a typed discriminant (not a boolean).** Today the flag is
`artifactInputs?: boolean` on the `RouteVariableInput` argument
(`variable-preparation.ts:253`), produced once by `resolveVariableLayers` as a
hardcoded `artifactInputs: true` for every layer (`:485`) and consumed at **two**
sites inside `routeVariable`: the scalar/object/JSON-transport path
(`:318`, via `resolveArtifactInputValue`) **and** the array-of-bare-strings branch
(`:361`, via `readExactArtifactRecordArrayFromManifest` directly). Both sites must
be converted. Encoding the boundary as a boolean just relocates value-shape
sniffing one layer up — the artifacts CLI layer and the variable CLI layer would
both be `kind: 'cli'` with opposite behaviour. Instead, lift the boundary to a
first-class discriminant. Add `channel` to `VariableLayer`
(`variable-preparation.ts:421-425`, which today carries only `kind` + `values`),
replace the boolean on `RouteVariableInput` (`:253`) with the same discriminant,
and thread `layer.channel` through:

```ts
type BoundaryChannel = 'variable' | 'artifact';
interface VariableLayer {
  readonly kind: VariableLayerKind;
  readonly channel: BoundaryChannel; // NEW — added beside kind/values
  readonly values: Readonly<Record<string, unknown>>;
}
```

`routeVariable` narrows on `channel` at both consume sites (`:318` and `:361`).
The clean break is then: the artifacts layer is `channel: 'artifact'`; **every**
other layer (including `inherited`) is `channel: 'variable'`. This is the
type-driven-dispatch the design exists to deliver — end to end, no string-shape
discriminant survives. The must-resolve-or-throw wrapper (below) must likewise
wrap both consume sites.

**Must-resolve-or-throw (NEW — invariant #3).** The reused
`resolveArtifactInputValue` returns `null` for a non-`rd://` value, a missing
manifest row, or a partial array, and `routeVariable` then **falls through to
plain-string routing** (`variable-preparation.ts:316-324`, terminal
`vars[key] = String(value)` at `:408`). That silent fallthrough is correct for
the variable channel but **violates invariant #3** for the artifact channel. The
artifacts layer therefore needs a new must-resolve wrapper: a `null` from the
manifest readers on the `'artifact'` channel is a **hard error**, never a string.
This is the seam that enforces "non-`rd://` value rejected."

**Required gate plumbing (NEW — invariant #4).** `MISSING_REQUIRED_VARS` is
computed from `providedKeys` (`variable-preparation.ts:838`), which is populated
only for layer kinds in `EXTERNAL_PROVIDER_KINDS` (`:433`, `:487`). The new
artifacts layer kind MUST be added to `VariableLayerKind` and to
`EXTERNAL_PROVIDER_KINDS`, or a supplied required artifact will not enter
`providedKeys` and `required: [PlanPath]` will falsely report missing.

**Cross-channel value collision (NEW — invariant #2).** `resolveVariableLayers`
merges layers with unconditional last-wins assignment (`vars[key] = …`) and has
**no** collision detection today. Enforcing "same key via both `--input` and
`--artifacts` is an error" requires new per-key channel-provenance tracking
during the merge (e.g. a `Map<string, BoundaryChannel>` alongside `providedKeys`
that throws when a key arrives from both channels). This is distinct from the
parse-time `inputs ∩ artifacts` declaration collision in §1.

**Reused verbatim.** The manifest readers `resolveArtifactInputValue`
(`variable-preparation.ts:262`) and `readExactArtifactRecordArrayFromManifest`
(`packages/core/src/runbook/artifact-inputs.ts:113`) — including brand minting
via `brandTrustedArtifactRecord` / `brandTrustedArtifactArray` — are used
unchanged. Because both scalar and array forms flow through this path, **array
artifact inputs work without new transport** (e.g. `FOR plan IN {{ Plans }}`) —
but the FOR path must still be integration-tested, not assumed (see Testing).

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
  rehydration. The manifest read happens at **prepare-time variable resolution**
  in core (`variable-preparation.ts`, before `createActor`) — the same boundary
  where `--input rd://` resolves today. This is core boundary ingress, **not** a
  machine-invoked Category-B `fromPromise` actor under `actors/` (the A/B/C table
  reserves "Category B" for "machine invokes an actor"). The placement is correct
  and the CLI stays thin; the label is the only correction.
- **Type-driven dispatch.** Replaces an implicit `rd://`-prefix value-shape
  discriminant with an explicit `BoundaryChannel` discriminant on the layer
  (§3) — not a side boolean.
- **No silent mapping / no synthetic IDs / no machine changes.** No states,
  transitions, actions, guards, or actors are added or changed; the change is
  confined to prepare-time variable-layer resolution and the manifest URI scheme.
  So the `setup()`/graph/actor/guard sections of
  `docs/internal/xstate-patterns.md` are N/A, and the design adds no synthetic IDs
  and no action remapping.
- **Persistence (xstate-patterns §Persistence still binds).** Be precise: prepared
  artifact values are **not** confined to before `createActor`. A branded
  `TrustedArtifactValue` flows into machine `context.variables` and is serialised
  into the persisted snapshot — exactly as a `--input rd://` value does today
  (`variable-preparation.ts:566-567` → `state.ts:215` → `compiler.ts:662-666` →
  snapshot blob at `schemas.ts:732`). The new channel routes the **same value
  type into the same field**, so the persisted shape is unchanged. The
  "persisted context contains only data" rule is satisfied by reused machinery,
  not by avoiding persistence: `trustedArtifactBrand` is a non-enumerable
  `Symbol` (`effective-vars.ts:301-308`) that `JSON.stringify` strips on persist,
  and the brand is re-minted on load from the authoritative `RunbookState.variables`
  (`actor-service.ts:420-423`, `schemas.ts:1019`). No runtime reference, function,
  or service handle ever enters the persisted blob.
- **No persisted-state migration.** The clean break changes what resolves to a
  branded value **at ingress**, not the persisted representation. A
  `TrustedArtifactValue` in `RunbookState.variables` is byte-identical in shape
  whether produced by the old `--input rd://` path or the new `--artifacts`
  channel, so no persisted field changes type or meaning and no stale-state
  rejection is required. Frontmatter is parsed from source on every run and is
  never persisted as run state.

## Out of scope (deferred)

These are explicitly deferred to keep the first cut small; each is cheap to add
later because the transport already exists:

- `--artifacts-file` bulk file source (the third member of the flag family;
  `--input` has `--input-file`, the artifact channel ships only the two inline
  forms). When added, pin these semantics so it does not drift into a 1:1 copy of
  `--input-file`:
  - **Shape:** a YAML/JSON file mapping artifact names to `rd://` URIs (scalar or
    array of URIs), layerable like `--input-file` (`--artifacts-file a.yaml
    --artifacts-file b.yaml`).
  - **`rd://`-only — never `file:`.** Unlike `--input-file`, it must **not**
    accept `file:`-prefixed data-source paths. The artifact channel is read-only
    rehydration of existing manifest rows (Core invariant #3, Non-goals); it never
    mints manifest rows from on-disk files. A non-`rd://` value is the same hard
    error as the inline forms.
  - **Routing:** slots into the same `variable-discovery.ts` layering path as a
    `channel: 'artifact'` layer — no core change required (the transport already
    exists).
- `RD_ARTIFACT_*` environment-variable bridge and `.rundown/config.yaml` artifact
  sources. (The no-`=` env-inherit arm of `--artifacts` is suppressed until this
  lands — see §2.)
- Delegation **inheritance** of artifacts to child runbooks (the `--artifacts`
  flag exists on `delegate`/`claim`; auto-pass-to-child semantics are deferred).
- Selector / glob artifact URIs.

## Testing

Coverage is required across all four levels — unit, property, integration, and
scenario — matching this repo's conventions (`*.properties.test.ts`,
`integration/`, scenario runbooks with `expect.artifacts`).

### Unit

- **Parser** (`packages/parser`): `artifacts:` declaration validation (valid list,
  non-sequence, non-string entry, duplicates); `inputs`/`artifacts` collision
  diagnostic; **negative** case — a name in only one channel does **not** collide;
  `required` validated over `inputs ∪ artifacts` (including an artifacts-only
  required name passing); the former frontmatter-ARTIFACTS error is gone;
  `ARTIFACTS:` casing normalisation (parallel to the `INPUTS:` test at
  `frontmatter.test.ts:141`); the new frontmatter `artifacts` AST field extracts
  distinctly from the step-level `artifacts` directive.
- **Core** (`packages/core`): artifact-layer rehydration for scalar and array
  forms produces branded `TrustedArtifactValue`s; cross-channel value collision
  error; **negative** — same name in one channel only does not error;
  `MISSING_REQUIRED_VARS` fires for a required artifact that is not supplied;
  channel is permissive otherwise (an undeclared artifact name still supplies);
  non-`rd://` value rejected (hard error, not string fallthrough); non-`rd://`
  entry inside a `--artifacts-json` array rejected; naked consumer accepts the
  branded value unchanged.
- **Clean-break paired test (mutation gate).** The whole break is the per-layer
  `channel` discriminant (was the boolean at `variable-preparation.ts:485`). In a
  single test file assert **both** `--artifacts rd://… → branded value` **and**
  `--input rd://… (same URI) → plain string`, so a single mutation of the
  channel/flag kills at least one assertion. Without the pair, the mutant
  survives.
- **CLI** (`packages/cli`): `--artifacts` / `--artifacts-json` parsing and
  layering.

### Property (`packages/parser` + `packages/core`)

The Testing section previously named none; this surface is exactly what the repo
property-tests (`variable-preparation.properties.test.ts`,
`artifacts-routing.properties.test.ts`). Add:

- **Collision symmetry** — for disjoint name sets `A` (inputs), `B` (artifacts)
  plus an injected shared name `c`, the collision diagnostic fires iff
  `c ∈ A ∩ B`, independent of declaration order.
- **Required over union** — for arbitrary `inputs`, `artifacts`, and
  `required ⊆ inputs ∪ artifacts`, no diagnostic; for any `required` name outside
  the union, exactly one.
- **`artifacts:` parse round-trip** — an arbitrary valid identifier sequence
  parses to the same ordered, deduped list, with non-string handling identical to
  `inputs`.
- **Scalar/array rehydration parity** — for a set of valid manifest URIs, routing
  a single URI and routing the JSON array of those URIs through the artifact
  channel both yield branded `TrustedArtifact*` values
  (`isTrustedArtifactRecord` / `isTrustedArtifactArray`).

### Integration (`packages/cli`)

- End-to-end `rd run` with `--artifacts` / `--artifacts-json`; non-`rd://` value
  rejected at the boundary.
- **FOR-loop over array artifacts** — `rd run --artifacts-json Plans=[uri,uri]`
  over a runbook with `FOR plan IN {{ Plans }}`, asserting per-iteration
  projection. (The "for free" claim in §3 is verified here, not assumed.)
- **`delegate` / `claim` / `resolve`** — the flags register on these commands too;
  a smoke test per command that `--artifacts KEY=rd://…` parses and reaches core
  (delegation *inheritance* is out of scope, but flag plumbing is in scope).

### Scenario

- The motivating case (#467/#480): a standalone `execute-plan` runbook declaring
  `artifacts: [PlanPath]` + `required: [PlanPath]`, with a scenario driving
  `rd run execute-plan.md --artifacts PlanPath=rd://…` and asserting
  `expect.artifacts` (alias `PlanPath`, kind artifact-record, exists). This is the
  headline use case and warrants living scenario coverage.

### Tests to update / remove (clean break)

The break inverts the meaning of `--input X=rd://`; these existing suites assert
the **old** behaviour and must be migrated to `--artifacts` or re-asserted as
string passthrough:

- `packages/cli/__tests__/integration/artifact-variable-inputs.test.ts` — `:54`,
  `:70`, `:102`, `:127`, `:158`, `:205`, `:231` assert `--input*` rd:// → branded
  artifact (migrate to `--artifacts`). `:174`, `:190` (string passthrough) survive
  but need re-justification under the new contract.
- `packages/core/__tests__/runbook/variable-preparation.test.ts` — `:512`, `:529`,
  `:565`, `:609`, `:629`, `:678`, `:723`, `:732`, `:747`, `:762`, `:774`. **Triage
  each:** tests that call `routeVariable` /
  `readExactArtifactRecordArrayFromManifest` directly with an explicit
  `channel: 'artifact'` (formerly `artifactInputs: true`) are unaffected; tests
  driving the full `prepareVariables` pipeline that expect a `--input` rd:// to
  rehydrate are now wrong.
- `packages/parser/__tests__/frontmatter.test.ts:527`/`:565` and
  `packages/cli/__tests__/helpers/runbook-pipeline.test.ts:1041`/`:1052` — pin the
  `must also be declared in "inputs"` message; widening to `inputs ∪ artifacts`
  changes the wording.

A grep found **no** existing test asserting the frontmatter-`ARTIFACTS`-invalid
guard, so removing it breaks nothing — but it shipped untested; the new
"frontmatter-ARTIFACTS error is gone" test is the first coverage of that path and
should be kept.

## Files touched

- `packages/parser/src/frontmatter.ts` — the field and most parser work live
  here: remove guard (188-193); add `artifacts?: string[]` to the
  `RunbookFrontmatter` interface (74-84) and to `RunbookFrontmatterSchema` (105);
  generalise `filterInputDeclarations` (226) over `inputs|artifacts` (leave
  `filterIdentifierArray` (291) for `required` alone — see §1) and call it at the
  validation site (194-195); splice `artifacts` into the assembled return object
  (201-209); add collision check; widen `validateRequiredSubset` (200/343) to
  `inputs ∪ artifacts` and its diagnostic message; extend the
  `NORMALIZED_FRONTMATTER_KEYS` allowlist (25-34, `inputs` at 32) so
  `normalizeKnownFrontmatterKeys` covers `ARTIFACTS:`.
- `packages/parser/src/ast.ts` — **no field here** (the frontmatter field lives on
  `RunbookFrontmatter` in `frontmatter.ts`). Optionally export a named alias
  (e.g. `ArtifactInputName`) with TSDoc contrasting it against the step-level
  `artifacts` directive (`ArtifactDeclaration[]`, 195-197/289) to prevent future
  conflation.
- `packages/core/src/runbook/variable-preparation.ts` — replace
  `artifactInputs?: boolean` on `RouteVariableInput` (253) with a `BoundaryChannel`
  discriminant and add `channel` to `VariableLayer` (421-425); `routeVariable`
  narrows on `channel` at **both** consume sites (318 and 361); producer at 485;
  new artifacts layer (`channel: 'artifact'`, all others `'variable'`);
  must-resolve-or-throw wrapping both consume sites; new cross-channel
  value-collision detection in the merge; add the artifacts layer kind to
  `VariableLayerKind` (413-419) and `EXTERNAL_PROVIDER_KINDS` (433) so the required
  check (836-851, reads `providedKeys` populated at 487-488) covers it;
  `required ⊆ inputs ∪ artifacts`.
- `packages/core/src/runbook/artifact-inputs.ts` — reused verbatim:
  `readExactArtifactRecordArrayFromManifest` (defined at 93) + brand minting
  (`brandTrustedArtifactRecord` 81 / `brandTrustedArtifactArray` 113).
- `packages/core/src/runbook/artifact-directive-resolver.ts` — unchanged (naked
  consumer, 647).
- `packages/core/src/runbook/delegation-context.ts` — widen
  `surfaceIterationBinding` to gate on `inputs ∪ artifacts`.
- `packages/cli/src/helpers/option-utils.ts` — register `--artifacts` /
  `--artifacts-json` against the **existing** `parseInputOption` /
  `parseInputJsonOption` (41/77); add an optional label parameter only if a
  distinct error noun is wanted. No cloned parsers.
- `packages/cli/src/services/variable-discovery.ts` — parallel artifact layering
  path. Today `--input*` flags are merged into a single `{ kind: 'cli', values }`
  layer by `collectCliFlags` (223-268), emitted by `collectRawLayers` (470-477).
  Widen the `resolveVariables`/`collectRawLayers` options types to carry
  `artifacts`/`artifactsJson`, add an artifact collection step, and emit a
  **separate** layer with `channel: 'artifact'`.
- `packages/cli/src/commands/{run,delegate,claim,resolve}.ts` — register the
  flags.
- **TSDoc:** every new/changed exported symbol gets full TSDoc per the project
  standard — `BoundaryChannel`, the `channel` field on `VariableLayer`, the
  `artifacts` frontmatter field, `filterDeclarationArray`, and any new CLI option
  registration (description, `@param`, `@returns`, `@throws`).
- Docs: `docs/spec/language.md` (§9/§10 boundary channels), `docs/reference/cli.md`
  (`--artifacts` flags), and the `executing-plans` skill once built (current-state
  docs are descriptive and edited when the code lands).
