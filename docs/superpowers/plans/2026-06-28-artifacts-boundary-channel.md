# Artifacts Boundary Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated artifact boundary channel (`--artifacts` / `--artifacts-json` CLI flags + frontmatter `artifacts:` declaration) so input artifacts are declared and supplied distinctly from input variables, replacing the implicit `rd://`-prefix runtime discriminant with an explicit `BoundaryChannel` discriminant.

**Architecture:** Pure prepare-time boundary ingress in `@rundown-org/core` plus thin CLI flag plumbing. No state-machine, actor, guard, or transition changes. The CLI parses and forwards typed values; core does all binding and manifest rehydration at variable-layer resolution (`variable-preparation.ts`, before `createActor`) — the same boundary where `--input rd://` resolves today. The boundary kind becomes a first-class `channel` field on `VariableLayer`, not a value-shape sniff.

**Tech Stack:** TypeScript (ESM), Zod (frontmatter schema), Commander (CLI option parsing), Jest, fast-check (property tests), `@rundown-org/parser`, `@rundown-org/core`, `@rundown-org/cli`.

**Reference spec:** `docs/superpowers/specs/2026-06-28-artifacts-boundary-channel-design.md`. This plan decomposes that spec; it does not restate its rationale. Read the spec's Core invariants, Design §1–§4, and Testing sections before starting.

---

## Global Constraints

Copied from the spec and CLAUDE.md. Every task's requirements implicitly include this section.

- **Single namespace.** `inputs ∪ artifacts` is one flat namespace; a name belongs to exactly one channel. A name in both `inputs:` and `artifacts:` is a collision error. `{{X}}` and `required: [X]` resolve to the single `X`.
- **Clean break.** Artifacts rehydrate **only** via the artifact channel. `--input X=rd://…` is now a plain string (no rehydration). This flips **every** variable layer, including `inherited`.
- **Read-only.** The channel rehydrates **existing** manifest rows. A non-`rd://artifacts/…` value (or array containing one) is a hard error. The channel never mints manifest rows.
- **`required:` is the only supply-time gate.** Channels are otherwise open/permissive, mirroring today's `inputs:`.
- **State machine drives logic / CLI is a thin wrapper.** No states, transitions, actions, guards, or actors are added or changed. Do not introduce a shadow implementation in the CLI.
- **Type-driven dispatch.** Encode the boundary as an explicit `BoundaryChannel` discriminant, never a boolean or string-shape sniff.
- **No persisted-state migration.** Artifact values land in `RunbookState.variables` / the snapshot exactly as `--input rd://` values do today. No `.rundown/` schema field changes type or meaning.
- **No `--artifacts-file`, no `RD_ARTIFACT_*` bridge, no *automatic* `--artifacts` delegation inheritance, no selector URIs** in this cut (see spec Out of scope). The env-inherit arm of `--artifacts` is suppressed. **Scope clarification:** "no delegation inheritance" means the `--artifacts` flag is *not* auto-passed from a parent run to a child runbook — that is deferred. It does **not** exclude **iteration-binding inheritance**, which the spec explicitly requires widening over `inputs ∪ artifacts` (Task 5): a loop variable declared in `artifacts:` must surface under delegation, per the single-namespace invariant. The two are different mechanisms; Task 5 is in scope, auto-pass-to-child is not.
- **TSDoc** on every new/changed exported symbol (description, `@param`, `@returns`, `@throws`).
- **JSON remains the CLI default.** No `--text`-only behaviour is introduced.
- **Per-task tests are focused** (`pnpm --filter <pkg> test -- <pattern>`), following the house convention. The clean break in Task 2 makes some `@rundown-org/cli` integration specs red until Task 10 migrates them; full-suite green is asserted only at the final verification task via `pnpm run verify`.

## Test Harness Reference (authoritative)

The code snippets below are **illustrative**; the helper names in some snippets were aliased for readability. When implementing, use these REAL helpers/signatures (verified against source). Where a snippet says otherwise, this table wins.

| Snippet shorthand | Real API | Notes |
| --- | --- | --- |
| `parseFrontmatter(md)` → `{ frontmatter, diagnostics }` | `extractFrontmatter(md)` (`packages/parser/src/frontmatter.ts:144`) | Returns `{ frontmatter: RunbookFrontmatter \| null, content, diagnostics }`. `frontmatter` is **nullable** — assert via `frontmatter?.artifacts`. |
| `seedManifestArtifact(cwd, key)` → URI string | `appendManagedManifestRow(contextId, key)` (`packages/core/__tests__/runbook/variable-preparation.test.ts:238`) | **Synchronous**; returns a row object — use `.uri`. Writes to the module-level `tmpDir`; pass `{ cwd: tmpDir }` to `resolveVariableLayers`, not a separate `cwd`. |
| `prepareVariables({ frontmatter, artifactLayers })` → `{ ok, code }` | `prepareParsedRunbook(input)` (`variable-preparation.ts:744`) | Takes **pre-resolved** `templateVars` + `providedKeys` (+ `rawRunbook`, `runbookRef`, `helperRegistry`, `identity`); it does **not** accept layers. The required gate reads `input.providedKeys`. See Task 5 for the two-seam wiring. |
| `runCli([...])` async → `{ stdout, code }` | `runCliInProcess(args, workspace)` (`packages/cli/__tests__/integration/artifact-variable-inputs.test.ts:8`) | Async, requires a `workspace`. Result field is **`exitCode`**, not `code`. (`runCli` itself is sync and returns `{ stdout, stderr, exitCode }`.) |
| `isTrustedArtifactRecord` / `isTrustedArtifactArray` | exported from `@rundown-org/core` (`index.ts:408-409`) | Import in core tests as today (`variable-preparation.test.ts:33-34`). |
| `resolveVariableLayers([layers], { cwd })` → `.vars` | confirmed real (`variable-preparation.ts:444`) | Returns `ResolvedVariables { vars, warnings, providedKeys }`. |

## File Structure

| File | Role | Change |
| --- | --- | --- |
| `packages/parser/src/frontmatter.ts` | Frontmatter parse + validation | Remove ARTIFACTS guard; add `artifacts?: string[]` field + schema entry; generalise `filterInputDeclarations` over `inputs\|artifacts`; collision check; widen `validateRequiredSubset`; normalise `ARTIFACTS:` casing |
| `packages/parser/src/ast.ts` | AST type exports | Add named alias `ArtifactInputName` with TSDoc contrasting it against the step-level `artifacts` directive |
| `packages/core/src/runbook/variable-preparation.ts` | Prepare-time variable routing | Add `BoundaryChannel`; make `VariableLayer` a channel-discriminated union (kind↔channel tied); add `channel` to `RouteVariableInput`; new `artifact-cli` layer kind; thread channel through **both** consume sites + the producer loop + `routeExtraVars`; must-resolve-or-throw (array-guarded at first site); cross-channel collision; required gate; widen `surfaceIterationBinding` call site to the union |
| `packages/core/src/runbook/index.ts` | Core barrel | Re-export `BoundaryChannel` beside `VariableLayer` |
| `packages/core/src/runbook/artifact-inputs.ts` | Manifest readers | Reused verbatim (no change) |
| `packages/core/src/runbook/delegation-context.ts` | Iteration-binding inheritance | Widen `surfaceIterationBinding` TSDoc to document `inputs ∪ artifacts` |
| `packages/cli/src/helpers/option-utils.ts` | CLI flag parsers | Parameterise the var-flag parsers with a label + env-inherit guard; add `parseArtifactOption` / `parseArtifactJsonOption` |
| `packages/cli/src/services/variable-discovery.ts` | CLI layer assembly | Carry `artifacts`/`artifactsJson`; collect a separate `channel: 'artifact'` layer; tag all existing layers `channel: 'variable'` |
| `packages/cli/src/commands/{run,delegate,claim,resolve}.ts` | CLI flag registration | Register `--artifacts` / `--artifacts-json` |
| `docs/spec/language.md`, `docs/reference/cli.md` | Descriptive docs | Document boundary channels + flags after code lands |

---

## Task 1: Frontmatter `artifacts:` declaration (parser)

**Files:**
- Modify: `packages/parser/src/frontmatter.ts`
- Modify: `packages/parser/src/ast.ts`
- Test: `packages/parser/__tests__/frontmatter.test.ts`
- Modify (message-pin): `packages/cli/__tests__/helpers/runbook-pipeline.test.ts:1041,1052`

**Interfaces:**
- Produces: `RunbookFrontmatter.artifacts?: string[]`; the widened `validateRequiredSubset(required, inputs, artifacts, diagnostics)`; the collision diagnostic; exported type alias `ArtifactInputName` (string).

- [ ] **Step 1: Write the failing parser tests**

Add to `packages/parser/__tests__/frontmatter.test.ts`:

```typescript
describe('frontmatter artifacts channel', () => {
  it('accepts an artifacts sequence of bare identifiers', () => {
    const { frontmatter, diagnostics } = parseFrontmatter(
      `---\nname: x\nartifacts:\n  - PlanPath\n---\n# X\n`,
    );
    expect(frontmatter.artifacts).toEqual(['PlanPath']);
    expect(diagnostics).toEqual([]);
  });

  it('rejects a non-sequence artifacts value', () => {
    const { diagnostics } = parseFrontmatter(`---\nname: x\nartifacts: nope\n---\n# X\n`);
    expect(diagnostics.some((d) => /artifacts.*must be a YAML sequence/i.test(d.message))).toBe(true);
  });

  it('rejects a non-string artifacts entry', () => {
    const { diagnostics } = parseFrontmatter(`---\nname: x\nartifacts:\n  - 3\n---\n# X\n`);
    expect(diagnostics.some((d) => /artifacts\[0\].*must be a string/i.test(d.message))).toBe(true);
  });

  it('rejects duplicate artifacts entries', () => {
    const { diagnostics } = parseFrontmatter(
      `---\nname: x\nartifacts:\n  - P\n  - P\n---\n# X\n`,
    );
    expect(diagnostics.some((d) => /duplicate entry "P"/.test(d.message))).toBe(true);
  });

  it('errors when a name appears in both inputs and artifacts', () => {
    const { diagnostics } = parseFrontmatter(
      `---\nname: x\ninputs:\n  - P\nartifacts:\n  - P\n---\n# X\n`,
    );
    expect(diagnostics.some((d) => /"P".*both "inputs" and "artifacts"/.test(d.message))).toBe(true);
  });

  it('does NOT error when a name is in only one channel', () => {
    const { diagnostics } = parseFrontmatter(
      `---\nname: x\ninputs:\n  - A\nartifacts:\n  - B\n---\n# X\n`,
    );
    expect(diagnostics).toEqual([]);
  });

  it('validates required against inputs ∪ artifacts (artifacts-only name passes)', () => {
    const { diagnostics } = parseFrontmatter(
      `---\nname: x\nartifacts:\n  - PlanPath\nrequired:\n  - PlanPath\n---\n# X\n`,
    );
    expect(diagnostics).toEqual([]);
  });

  it('required diagnostic names both channels when unsatisfied', () => {
    const { diagnostics } = parseFrontmatter(
      `---\nname: x\ninputs:\n  - A\nrequired:\n  - Missing\n---\n# X\n`,
    );
    expect(diagnostics.some((d) => /must also be declared in "inputs" or "artifacts"/.test(d.message))).toBe(true);
  });

  it('no longer treats frontmatter ARTIFACTS as invalid', () => {
    const { diagnostics } = parseFrontmatter(`---\nname: x\nartifacts:\n  - P\n---\n# X\n`);
    expect(diagnostics.some((d) => /ARTIFACTS is invalid in frontmatter/.test(d.message))).toBe(false);
  });

  it('normalises ARTIFACTS: casing like INPUTS:', () => {
    const { frontmatter } = parseFrontmatter(`---\nname: x\nARTIFACTS:\n  - PlanPath\n---\n# X\n`);
    expect(frontmatter.artifacts).toEqual(['PlanPath']);
  });
});
```

Also update the two existing assertions that pin the old `required` message wording at `frontmatter.test.ts:527` and `:565` (change `must also be declared in "inputs"` → `must also be declared in "inputs" or "artifacts"`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rundown-org/parser test -- frontmatter`
Expected: FAIL — `artifacts` is undefined and the collision/required-union/casing behaviour does not exist.

- [ ] **Step 3: Add the `artifacts` field and schema entry, remove the guard, normalise casing**

In `packages/parser/src/frontmatter.ts`:

Add to `NORMALIZED_FRONTMATTER_KEYS` (line 25-34), beside `'inputs'`:

```typescript
  'inputs',
  'artifacts',
  'outputs',
```

Add to the `RunbookFrontmatter` interface (line 74-84), beside `inputs?`, and
define the `ArtifactInputName` alias **here** (not in `ast.ts`) so the field can
use it without an import cycle — `ast.ts` already imports from `frontmatter.ts`,
so the alias is re-exported from `ast.ts` in Step 6:

```typescript
/**
 * A boundary input-artifact name declared in frontmatter `artifacts:`.
 *
 * Distinct from the step-level `artifacts` directive (`ArtifactDeclaration[]`),
 * which produces artifacts during execution. `ArtifactInputName` names an
 * artifact the runbook expects to be *supplied* at its boundary via the
 * `--artifacts` channel. Do not conflate the two.
 */
export type ArtifactInputName = string;
```

```typescript
  inputs?: string[]; // Optional: declared template variable names
  artifacts?: ArtifactInputName[]; // Optional: declared input-artifact names (boundary artifact channel)
```

Add to `RunbookFrontmatterSchema` (line 105), beside `inputs`:

```typescript
    inputs: z.unknown().optional().catch(undefined),
    artifacts: z.unknown().optional().catch(undefined),
```

Delete the guard at lines 188-193 entirely:

```typescript
  // DELETE this block:
  if (Object.keys(data).some((key) => key.toLowerCase() === 'artifacts')) {
    diagnostics.push({
      severity: 'error',
      message: 'ARTIFACTS is invalid in frontmatter; declare ARTIFACTS on a step or substep',
    });
  }
```

- [ ] **Step 4: Generalise `filterInputDeclarations` over `inputs | artifacts`**

Rename `filterInputDeclarations` to `filterDeclarationArray` and add a `field` parameter. Per spec §1, do **not** fold `filterIdentifierArray` (used for `required`) into it — its empty-array semantics differ. In `packages/parser/src/frontmatter.ts`:

```typescript
/**
 * Validate a frontmatter declaration sequence (`inputs` or `artifacts`).
 *
 * Accepts a YAML sequence of bare identifier strings. Any non-sequence input
 * or non-string entry is rejected with a diagnostic. Valid entries are kept in
 * author order; duplicates are reported as errors. Empty arrays collapse to
 * `undefined`, matching the prior `inputs` behaviour.
 *
 * @param raw - Raw declaration value from frontmatter
 * @param field - Channel name (`inputs` or `artifacts`) used in diagnostic messages
 * @param diagnostics - Output array; validation errors are appended in-place
 * @returns The valid declared names, or `undefined` when absent, empty, or invalid
 */
function filterDeclarationArray(
  raw: unknown,
  field: 'inputs' | 'artifacts',
  diagnostics: ValidationDiagnostic[],
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    diagnostics.push({
      severity: 'error',
      message: `Frontmatter "${field}" must be a YAML sequence of names (for example: ${field}: [PlanPath] or ${field}:\n  - PlanPath)`,
    });
    return undefined;
  }
  if (raw.length === 0) return undefined;

  const kept: string[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter "${field}[${String(index)}]" must be a string identifier (got ${typeof entry})`,
      });
      return;
    }
    if (!isSafeIdentifier(entry)) {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter "${field}[${String(index)}]" — "${entry}" is not a valid identifier`,
      });
      return;
    }
    if (isReservedTemplateName(entry)) {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter "${field}[${String(index)}]" — "${entry}" is a reserved variable name (${formatReservedTemplateNames()} — case-insensitive)`,
      });
      return;
    }
    if (seen.has(entry)) {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter "${field}[${String(index)}]" — duplicate entry "${entry}" in "${field}" — each name should be listed once`,
      });
      return;
    }
    seen.add(entry);
    kept.push(entry);
  });
  return kept.length > 0 ? kept : undefined;
}
```

- [ ] **Step 5: Compute `artifacts`, add the collision check, widen `validateRequiredSubset`, splice into the return object**

At the validation call site (lines 194-209), compute `artifacts`, run a collision check, and splice the field in:

```typescript
  const inputs =
    parsed.inputs !== undefined ? filterDeclarationArray(parsed.inputs, 'inputs', diagnostics) : undefined;
  const artifacts =
    parsed.artifacts !== undefined
      ? filterDeclarationArray(parsed.artifacts, 'artifacts', diagnostics)
      : undefined;
  validateChannelCollision(inputs, artifacts, diagnostics);
  const required =
    parsed.required !== undefined
      ? filterIdentifierArray(parsed.required, 'required', diagnostics)
      : undefined;
  validateRequiredSubset(required, inputs, artifacts, diagnostics);
  const frontmatter: RunbookFrontmatter = {
    ...parsed,
    inputs,
    artifacts,
    required,
    outputs:
      parsed.outputs !== undefined
        ? filterOutputDeclarationArray(parsed.outputs, diagnostics)
        : undefined,
  };
```

Add the collision validator:

```typescript
/**
 * Reject any name declared in both `inputs` and `artifacts`.
 *
 * `inputs ∪ artifacts` is a single flat namespace; a name belongs to exactly
 * one channel.
 *
 * @param inputs - Filtered input declarations
 * @param artifacts - Filtered artifact declarations
 * @param diagnostics - Output array; one error per colliding name is appended
 */
function validateChannelCollision(
  inputs: string[] | undefined,
  artifacts: string[] | undefined,
  diagnostics: ValidationDiagnostic[],
): void {
  if (!inputs || !artifacts) return;
  const inputSet = new Set(inputs);
  for (const name of artifacts) {
    if (inputSet.has(name)) {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter name "${name}" is declared in both "inputs" and "artifacts"; a name belongs to exactly one channel`,
      });
    }
  }
}
```

Widen `validateRequiredSubset` (lines 343-358) to the union:

```typescript
/**
 * Validate that required variables are declared in `inputs ∪ artifacts`.
 *
 * @param required - Filtered required names from frontmatter
 * @param inputs - Filtered input declarations
 * @param artifacts - Filtered artifact declarations
 * @param diagnostics - Output array; validation errors are appended in-place
 */
function validateRequiredSubset(
  required: string[] | undefined,
  inputs: string[] | undefined,
  artifacts: string[] | undefined,
  diagnostics: ValidationDiagnostic[],
): void {
  if (!required || required.length === 0) return;
  const declared = new Set([...(inputs ?? []), ...(artifacts ?? [])]);
  for (const name of required) {
    if (!declared.has(name)) {
      diagnostics.push({
        severity: 'error',
        message: `Frontmatter "required" variable "${name}" must also be declared in "inputs" or "artifacts"`,
      });
    }
  }
}
```

- [ ] **Step 6: Re-export `ArtifactInputName` from `ast.ts`**

The alias is defined in `frontmatter.ts` (Step 3) and used by the field there.
Re-export it from `packages/parser/src/ast.ts` for consumers that import AST types
(do not add a frontmatter field here — the field lives on `RunbookFrontmatter`):

```typescript
export type { ArtifactInputName } from './frontmatter.js';
```

- [ ] **Step 7: Update the CLI runbook-pipeline message-pin assertions**

In `packages/cli/__tests__/helpers/runbook-pipeline.test.ts` at lines 1041 and 1052, update the expected `required` message to `must also be declared in "inputs" or "artifacts"`.

- [ ] **Step 8: Run the tests to verify they pass**

Run:
```bash
pnpm --filter @rundown-org/parser test -- frontmatter
pnpm --filter @rundown-org/cli test -- runbook-pipeline
```
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/parser/src/frontmatter.ts packages/parser/src/ast.ts \
        packages/parser/__tests__/frontmatter.test.ts \
        packages/cli/__tests__/helpers/runbook-pipeline.test.ts
git commit -m "feat(parser): declare artifacts boundary channel in frontmatter"
```

---

## Task 2: `BoundaryChannel` discriminant + clean break (core)

**Files:**
- Modify: `packages/core/src/runbook/variable-preparation.ts`
- Test: `packages/core/__tests__/runbook/variable-preparation.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export type BoundaryChannel = 'variable' | 'artifact';`; `VariableLayer.channel: BoundaryChannel`; `VariableLayerKind` gains `'artifact-cli'`; `RouteVariableInput.channel: BoundaryChannel` replaces `artifactInputs?: boolean`.

- [ ] **Step 1: Write the failing clean-break paired test (mutation gate)**

Add to `packages/core/__tests__/runbook/variable-preparation.test.ts` a single paired test so a mutation of the channel/flag kills at least one assertion (spec Testing → Clean-break paired test). Construct two layers over the same manifest URI and assert opposite outcomes:

```typescript
describe('boundary channel clean break', () => {
  it('artifact channel brands; variable channel passes the same URI as a string', async () => {
    const uri = await seedManifestArtifact(cwd, 'PlanPath'); // returns rd://artifacts/<ctx>/<run>/PlanPath

    const artifactLayer: VariableLayer = {
      kind: 'artifact-cli',
      channel: 'artifact',
      values: { PlanPath: uri },
    };
    const variableLayer: VariableLayer = {
      kind: 'cli',
      channel: 'variable',
      values: { PlanPath: uri },
    };

    const branded = await resolveVariableLayers([artifactLayer], { cwd });
    expect(isTrustedArtifactRecord(branded.vars.PlanPath)).toBe(true);

    const plain = await resolveVariableLayers([variableLayer], { cwd });
    expect(typeof plain.vars.PlanPath).toBe('string');
    expect(plain.vars.PlanPath).toBe(uri);
    expect(isTrustedArtifactRecord(plain.vars.PlanPath)).toBe(false);
  });

  it('array branch: artifact channel brands an array; variable channel leaves it plain', async () => {
    const a = await seedManifestArtifact(cwd, 'a');
    const b = await seedManifestArtifact(cwd, 'b');

    const branded = await resolveVariableLayers(
      [{ kind: 'artifact-cli', channel: 'artifact', values: { Plans: [a, b] } }],
      { cwd },
    );
    expect(isTrustedArtifactArray(branded.vars.Plans)).toBe(true);

    // The SAME array of valid rd:// URIs on the variable channel must NOT be branded —
    // this pins the second consume site (routeVariable array branch) so a mutant on its
    // `channel === 'artifact'` guard is killed.
    const plain = await resolveVariableLayers(
      [{ kind: 'cli', channel: 'variable', values: { Plans: [a, b] } }],
      { cwd },
    );
    expect(isTrustedArtifactArray(plain.vars.Plans)).toBe(false);
  });
});
```

This second test is the mutation counterpart to the scalar pair: together they
bracket **both** consume sites (`routeVariable:318` scalar and `:359` array), so a
mutation of either channel guard kills at least one assertion.

(`seedManifestArtifact` is a local helper that writes a manifest row; reuse the existing manifest-seeding helper already present in this test file for the current artifact tests.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rundown-org/core test -- variable-preparation`
Expected: FAIL — `VariableLayer` has no `channel`; `'artifact-cli'` is not a `VariableLayerKind`.

- [ ] **Step 3: Add the `BoundaryChannel` type, layer kind, and `channel` field**

In `packages/core/src/runbook/variable-preparation.ts`:

```typescript
/**
 * Boundary channel through which a variable layer's values were supplied.
 *
 * `'variable'` values route as plain typed values; `'artifact'` values are
 * rehydrated from existing manifest rows into branded `TrustedArtifactValue`s
 * and must resolve or hard-fail. The channel is an explicit discriminant — the
 * artifact-vs-variable boundary is never inferred from a value's shape.
 */
export type BoundaryChannel = 'variable' | 'artifact';
```

Also re-export `BoundaryChannel` from the core barrel
(`packages/core/src/runbook/index.ts`, beside the existing `VariableLayer`
re-export ~line 399) so CLI/consumers can annotate against it.

Extend `VariableLayerKind` (lines 413-419):

```typescript
export type VariableLayerKind =
  | 'builtins'
  | 'frontend-defaults'
  | 'config'
  | 'inherited'
  | 'env'
  | 'cli'
  | 'artifact-cli';
```

Replace `VariableLayer` (lines 421-425) with a **discriminated union** that ties
`kind` ↔ `channel`, so an illegal combination (`{ kind: 'cli', channel: 'artifact' }`)
is unrepresentable rather than merely caught at runtime. `kind` still encodes
precedence/provenance; `channel` drives routing; the union forces them to agree:

```typescript
/** One precedence layer of variable values, discriminated by boundary channel. */
export type VariableLayer =
  | {
      readonly kind: 'builtins' | 'frontend-defaults' | 'config' | 'inherited' | 'env' | 'cli';
      readonly channel: 'variable';
      readonly values: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'artifact-cli';
      readonly channel: 'artifact';
      readonly values: Readonly<Record<string, unknown>>;
    };
```

`RouteVariableInput` keeps a bare `channel: BoundaryChannel` (it carries no
`kind`). Note the `VariableLayerKind` type alias above is still useful for
`EXTERNAL_PROVIDER_KINDS` membership and any `kind`-keyed logic; keep exporting it.

Add `'artifact-cli'` to `EXTERNAL_PROVIDER_KINDS` (line 433) so a supplied required artifact enters `providedKeys`:

```typescript
const EXTERNAL_PROVIDER_KINDS = new Set<VariableLayerKind>([
  'config',
  'inherited',
  'env',
  'cli',
  'artifact-cli',
]);
```

- [ ] **Step 4: Replace the boolean on `RouteVariableInput` and thread the channel**

Replace `artifactInputs?: boolean` (line 253) on `RouteVariableInput`:

```typescript
  readonly warnings?: string[];
  /** Boundary channel of the layer this value came from. */
  readonly channel: BoundaryChannel;
```

In `routeVariable` (line 316), narrow on `channel` at the **first** consume site (lines 318-324):

```typescript
  const { key, value, vars, cwd, projectRoot, security, warnings, channel } = input;

  if (channel === 'artifact') {
    const artifact = await resolveArtifactInputValue(value, { cwd });
    if (artifact !== null) {
      vars[key] = artifact;
      return 'routed';
    }
    // (Task 3 converts this fall-through into a hard error.)
  }
```

At the **second** consume site, the array-of-bare-strings branch (lines 359-373), replace the `artifactInputs` guard with `channel === 'artifact'`:

```typescript
  if (Array.isArray(value)) {
    if (
      channel === 'artifact' &&
      value.length > 0 &&
      value.every((entry): entry is string => typeof entry === 'string')
    ) {
      const artifacts = await readExactArtifactRecordArrayFromManifest(value, {
        cwd,
        workPath: WORK_DIR,
      });
      if (artifacts !== null) {
        vars[key] = artifacts;
        return 'routed';
      }
    }
    // ... unchanged JSON-array handling below ...
```

In the `resolveVariableLayers` producer loop (line 477-486), pass the layer's channel instead of the hardcoded boolean:

```typescript
      const routeResult = await routeVariable({
        key,
        value,
        vars,
        cwd: options.cwd,
        projectRoot,
        security: options.security,
        warnings,
        channel: layer.channel,
      });
```

There is a **second** `routeVariable` call site the producer loop snippet does
not cover: `routeExtraVars` (`variable-preparation.ts:529`) calls
`routeVariable({ key, value, vars, cwd, projectRoot, security, warnings })` with
no channel. Making `channel` required on `RouteVariableInput` turns this into a
type error — pass `channel: 'variable'` here (it is the non-artifact ad-hoc path).

- [ ] **Step 5: Migrate existing core variable-preparation tests for the clean break**

Triage each test the spec lists at `variable-preparation.test.ts:512,529,565,609,629,678,723,732,747,762,774`:
- Tests that call `routeVariable` / `readExactArtifactRecordArrayFromManifest` directly: replace `artifactInputs: true` with `channel: 'artifact'`, and add `channel: 'variable'` to any `routeVariable` calls that omitted the flag.
- Tests driving the full pipeline that expect a `--input` rd:// to rehydrate: re-assert as string passthrough (now correct) or move the URI into an `artifact-cli` layer.
- Add `channel: 'variable'` to every existing `VariableLayer` literal in the file (the field is now required). With the discriminated union, a literal whose `kind` is a variable kind **must** carry `channel: 'variable'` or it fails to typecheck.
- Also fix the one `VariableLayer` literal **outside** this file that the focused `test -- variable-preparation` pattern still compiles: `packages/core/__tests__/runbook/variable-preparation.properties.test.ts:146` (`{ kind: 'inherited', values: {…} }`) — add `channel: 'variable'`. (This file is migrated properly in Task 9, but the field add is needed here so Task 2's own gate compiles.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @rundown-org/core test -- variable-preparation`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runbook/variable-preparation.ts \
        packages/core/__tests__/runbook/variable-preparation.test.ts
git commit -m "feat(core): add BoundaryChannel discriminant and clean break"
```

---

## Task 3: Must-resolve-or-throw on the artifact channel (core)

**Files:**
- Modify: `packages/core/src/runbook/variable-preparation.ts`
- Test: `packages/core/__tests__/runbook/variable-preparation.test.ts`

**Interfaces:**
- Consumes: `BoundaryChannel`, `VariableLayer.channel` (Task 2).
- Produces: hard-error behaviour — a `channel: 'artifact'` value that does not resolve to a manifest row throws.

- [ ] **Step 1: Write the failing must-resolve tests**

```typescript
describe('artifact channel must resolve', () => {
  it('rejects a non-rd:// scalar on the artifact channel (no string fallthrough)', async () => {
    const layer: VariableLayer = {
      kind: 'artifact-cli',
      channel: 'artifact',
      values: { PlanPath: 'just-a-string' },
    };
    await expect(resolveVariableLayers([layer], { cwd })).rejects.toThrow(/Artifact input "PlanPath"/);
  });

  it('rejects a missing manifest row on the artifact channel', async () => {
    const layer: VariableLayer = {
      kind: 'artifact-cli',
      channel: 'artifact',
      values: { PlanPath: 'rd://artifacts/ctx/run/does-not-exist' },
    };
    await expect(resolveVariableLayers([layer], { cwd })).rejects.toThrow(/Artifact input "PlanPath"/);
  });

  it('rejects an array containing a non-rd:// entry on the artifact channel', async () => {
    const good = await seedManifestArtifact(cwd, 'A');
    const layer: VariableLayer = {
      kind: 'artifact-cli',
      channel: 'artifact',
      values: { Plans: [good, 'not-a-uri'] },
    };
    await expect(resolveVariableLayers([layer], { cwd })).rejects.toThrow(/Artifact input "Plans"/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rundown-org/core test -- variable-preparation`
Expected: FAIL — current code falls through to plain-string routing instead of throwing.

- [ ] **Step 3: Convert both artifact consume sites to throw on null**

In `routeVariable`, first consume site. **Guard the throw to non-arrays.**
`resolveArtifactInputValue` returns `null` for a real JS array of URI strings
(it only handles scalars and arrays of `{kind,uri}` objects), so an unguarded
throw here would reject valid `--artifacts-json Plans=[…]` values **before** they
reach the array reader at the second site. Arrays must fall through:

```typescript
  if (channel === 'artifact' && !Array.isArray(value)) {
    const artifact = await resolveArtifactInputValue(value, { cwd });
    if (artifact === null) {
      throw new Error(
        `Artifact input "${key}" did not resolve to an existing manifest row. ` +
          `The artifact channel requires an rd://artifacts/... URI (or a JSON array of such URIs); ` +
          `received: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
      );
    }
    vars[key] = artifact;
    return 'routed';
  }
```

Second consume site (array branch): when `channel === 'artifact'` the array
readers must also throw on null rather than fall through (this is where array
artifacts resolve):

```typescript
  if (Array.isArray(value)) {
    if (channel === 'artifact') {
      const allStrings = value.length > 0 && value.every(
        (entry): entry is string => typeof entry === 'string',
      );
      const artifacts = allStrings
        ? await readExactArtifactRecordArrayFromManifest(value, { cwd, workPath: WORK_DIR })
        : null;
      if (artifacts === null) {
        throw new Error(
          `Artifact input "${key}" did not resolve to existing manifest rows. ` +
            `Every entry must be an rd://artifacts/... URI; received: ${JSON.stringify(value)}`,
        );
      }
      vars[key] = artifacts;
      return 'routed';
    }
    // ... unchanged JSON-array handling for the variable channel ...
```

This guarantees no `channel: 'artifact'` value can reach the terminal `vars[key] = String(value)` fall-through. Keep the variable-channel paths unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @rundown-org/core test -- variable-preparation`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runbook/variable-preparation.ts \
        packages/core/__tests__/runbook/variable-preparation.test.ts
git commit -m "feat(core): hard-fail unresolved artifact-channel values"
```

---

## Task 4: Cross-channel value collision detection (core)

**Files:**
- Modify: `packages/core/src/runbook/variable-preparation.ts`
- Test: `packages/core/__tests__/runbook/variable-preparation.test.ts`

**Interfaces:**
- Consumes: `VariableLayer.channel` (Task 2).
- Produces: `resolveVariableLayers` throws when the same key is supplied from both channels.

- [ ] **Step 1: Write the failing collision tests**

```typescript
describe('cross-channel value collision', () => {
  it('errors when the same key arrives via both variable and artifact channels', async () => {
    const uri = await seedManifestArtifact(cwd, 'X');
    const variableLayer: VariableLayer = { kind: 'cli', channel: 'variable', values: { X: 'scalar' } };
    const artifactLayer: VariableLayer = { kind: 'artifact-cli', channel: 'artifact', values: { X: uri } };
    await expect(resolveVariableLayers([variableLayer, artifactLayer], { cwd })).rejects.toThrow(
      /"X".*both the variable and artifact channels/,
    );
  });

  it('does NOT error when a key is supplied via one channel only', async () => {
    const uri = await seedManifestArtifact(cwd, 'X');
    const variableLayer: VariableLayer = { kind: 'cli', channel: 'variable', values: { A: 'scalar' } };
    const artifactLayer: VariableLayer = { kind: 'artifact-cli', channel: 'artifact', values: { X: uri } };
    const result = await resolveVariableLayers([variableLayer, artifactLayer], { cwd });
    expect(result.vars.A).toBe('scalar');
    expect(isTrustedArtifactRecord(result.vars.X)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rundown-org/core test -- variable-preparation`
Expected: FAIL — last-wins merge has no collision detection.

- [ ] **Step 3: Track per-key channel provenance during the merge**

In `resolveVariableLayers`, declare a provenance map beside `providedKeys`, and check it in the per-key loop (before routing):

```typescript
  const keyChannel = new Map<string, BoundaryChannel>();
  // ... inside the `for (const layer of layers)` / `for (const [key, value] of entries)` loop:
    for (const [key, value] of entries) {
      if (!isValidVariableName(key)) {
        warnings.push(`Ignoring variable with invalid key: ${key}`);
        continue;
      }
      const priorChannel = keyChannel.get(key);
      if (priorChannel !== undefined && priorChannel !== layer.channel) {
        throw new Error(
          `Variable "${key}" was supplied via both the variable and artifact channels; ` +
            `a name belongs to exactly one channel.`,
        );
      }
      keyChannel.set(key, layer.channel);
      const routeResult = await routeVariable({ /* ...as Task 2... */ });
      if (EXTERNAL_PROVIDER_KINDS.has(layer.kind) && routeResult !== 'ignored') {
        providedKeys.add(key);
      }
    }
```

This is distinct from the parse-time `inputs ∩ artifacts` declaration collision in Task 1; this catches the supply-time case where a name reaches both `--input` and `--artifacts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @rundown-org/core test -- variable-preparation`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runbook/variable-preparation.ts \
        packages/core/__tests__/runbook/variable-preparation.test.ts
git commit -m "feat(core): reject cross-channel value collisions"
```

---

## Task 5: Required gate + iteration-binding inheritance over the union (core)

**Files:**
- Modify: `packages/core/src/runbook/variable-preparation.ts`
- Modify: `packages/core/src/runbook/delegation-context.ts`
- Test: `packages/core/__tests__/runbook/variable-preparation.test.ts`
- Test: `packages/core/__tests__/runbook/delegation-context.test.ts`

**Interfaces:**
- Consumes: `RunbookFrontmatter.artifacts` (Task 1), `'artifact-cli'` in `EXTERNAL_PROVIDER_KINDS` (Task 2).
- Produces: `MISSING_REQUIRED_VARS` fires for unsupplied required artifacts; loop variables declared in `artifacts:` surface under delegation.

- [ ] **Step 1: Write the failing tests**

Required-gate tests. There is **no `prepareVariables` function**: the required
gate spans two real seams — `resolveVariableLayers` populates `providedKeys` (only
for `EXTERNAL_PROVIDER_KINDS`, which now includes `'artifact-cli'`), and
`prepareParsedRunbook` (`variable-preparation.ts:744`) reads `input.providedKeys`
against `required`. Drive both seams (mirror the existing `prepareParsedRunbook`
tests at `variable-preparation.test.ts:137-151`, which already pass an explicit
`providedKeys: new Set([...])`):

```typescript
it('artifact-cli layer feeds providedKeys (required-gate input seam)', async () => {
  const { uri } = appendManagedManifestRow('producer-context', 'PlanPath');
  const resolved = await resolveVariableLayers(
    [{ kind: 'artifact-cli', channel: 'artifact', values: { PlanPath: uri } }],
    { cwd: tmpDir },
  );
  expect(resolved.providedKeys.has('PlanPath')).toBe(true);
  expect(isTrustedArtifactRecord(resolved.vars.PlanPath)).toBe(true);
});

it('reports MISSING_REQUIRED_VARS for an unsupplied required artifact', async () => {
  const result = await prepareParsedRunbook({
    /* ...existing prepareParsedRunbook harness args from the :137 test... */
    frontmatter: { artifacts: ['PlanPath'], required: ['PlanPath'] },
    providedKeys: new Set<string>(), // nothing supplied
  });
  expect(result.ok).toBe(false);
  expect(result.code).toBe('MISSING_REQUIRED_VARS');
});

it('passes when the required artifact is in providedKeys', async () => {
  const result = await prepareParsedRunbook({
    /* ...existing prepareParsedRunbook harness args... */
    frontmatter: { artifacts: ['PlanPath'], required: ['PlanPath'] },
    providedKeys: new Set(['PlanPath']),
  });
  expect(result.ok).toBe(true);
});

it('is permissive: an undeclared artifact name still supplies', async () => {
  const { uri } = appendManagedManifestRow('producer-context', 'Extra');
  const resolved = await resolveVariableLayers(
    [{ kind: 'artifact-cli', channel: 'artifact', values: { Extra: uri } }],
    { cwd: tmpDir },
  );
  expect(isTrustedArtifactRecord(resolved.vars.Extra)).toBe(true);
});
```

The first test pins the new `EXTERNAL_PROVIDER_KINDS` membership (the artifact
layer must feed `providedKeys`); the gate tests then exercise the existing
`prepareParsedRunbook` required check over the union from Task 1's frontmatter.

Iteration-binding test in `delegation-context.test.ts`:

```typescript
it('surfaces a loop variable declared in artifacts under delegation', () => {
  const surfaced = surfaceIterationBinding(
    { kind: 'item', variable: 'plan', index: 0, value: 'rd://artifacts/ctx/run/p0' },
    ['plan'], // child declares `plan` (here via artifacts ∪ inputs union supplied by the caller)
  );
  expect(surfaced.plan).toBeDefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rundown-org/core test -- variable-preparation delegation-context`
Expected: FAIL — the call site passes `frontmatter?.inputs` only; required is not yet satisfied by artifacts in the harness.

- [ ] **Step 3: Widen the `surfaceIterationBinding` call site to the union**

In `variable-preparation.ts` (lines 751-754):

```typescript
  const childDeclaredNames = [
    ...(input.frontmatter?.inputs ?? []),
    ...(input.frontmatter?.artifacts ?? []),
  ];
  const surfacedIterationVars = surfaceIterationBinding(
    input.iterationBinding,
    childDeclaredNames,
  );
```

- [ ] **Step 4: Update `surfaceIterationBinding` TSDoc**

In `delegation-context.ts`, update the `surfaceIterationBinding` doc comment (lines 268-279) so `childInputs` is documented as "the child's declared names across `inputs ∪ artifacts`", consistent with the single-namespace invariant. No signature change — the union is assembled at the call site.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @rundown-org/core test -- variable-preparation delegation-context`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runbook/variable-preparation.ts \
        packages/core/src/runbook/delegation-context.ts \
        packages/core/__tests__/runbook/variable-preparation.test.ts \
        packages/core/__tests__/runbook/delegation-context.test.ts
git commit -m "feat(core): gate required and iteration binding over inputs union artifacts"
```

---

## Task 6: CLI flag parsers (`option-utils`)

**Files:**
- Modify: `packages/cli/src/helpers/option-utils.ts`
- Test: `packages/cli/__tests__/helpers/option-utils.test.ts`

**Interfaces:**
- Produces: `parseArtifactOption(value, previous): string[]` and `parseArtifactJsonOption(value, previous): string[]` — same `key=value` / `key=json` shape validation as `parseInputOption` / `parseInputJsonOption`, but the no-`=` env-inherit arm is disabled and the error noun is "artifact".

- [ ] **Step 1: Write the failing parser tests**

```typescript
describe('parseArtifactOption', () => {
  it('accepts KEY=rd://... and accumulates', () => {
    expect(parseArtifactOption('PlanPath=rd://artifacts/c/r/PlanPath', [])).toEqual([
      'PlanPath=rd://artifacts/c/r/PlanPath',
    ]);
  });

  it('rejects the no-= env-inherit form (env arm disabled for artifacts)', () => {
    process.env.PlanPath = 'leak';
    expect(() => parseArtifactOption('PlanPath', [])).toThrow(/artifact.*KEY=<rd:\/\/ uri>/i);
    delete process.env.PlanPath;
  });

  it('rejects an invalid identifier with the artifact noun', () => {
    expect(() => parseArtifactOption('1bad=rd://x', [])).toThrow(/Invalid artifact/i);
  });
});

describe('parseArtifactJsonOption', () => {
  it('accepts KEY=<json array> and accumulates', () => {
    expect(parseArtifactJsonOption('Plans=["rd://a","rd://b"]', [])).toEqual([
      'Plans=["rd://a","rd://b"]',
    ]);
  });

  it('rejects invalid JSON with the artifact noun', () => {
    expect(() => parseArtifactJsonOption('Plans=not-json', [])).toThrow(/Invalid JSON for "Plans"/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rundown-org/cli test -- option-utils`
Expected: FAIL — `parseArtifactOption` is not defined.

- [ ] **Step 3: Parameterise the var-flag parser and add the artifact wrappers**

In `packages/cli/src/helpers/option-utils.ts`, extract the shared body behind a label + env-inherit guard (do not clone — spec §2), then export the existing and new parsers as thin wrappers:

```typescript
interface VarFlagParseOptions {
  /** Error noun used in diagnostics ("variable" or "artifact"). */
  readonly label: 'variable' | 'artifact';
  /** When false, the no-`=` env-inherit form is rejected. */
  readonly allowEnvInherit: boolean;
}

/**
 * Shared `key=value` flag parser for the variable and artifact channels.
 *
 * @param value - Raw flag value (`key=value` or, when allowed, a bare `KEY`)
 * @param previous - Previously accumulated entries
 * @param opts - Channel label and env-inherit policy
 * @returns Updated array with the new `key=value` entry
 * @throws {InvalidArgumentError} On invalid identifier, or a bare `KEY` when env-inherit is disabled
 */
function parseVarFlagOption(
  value: string,
  previous: string[],
  opts: VarFlagParseOptions,
): string[] {
  const eqIndex = value.indexOf('=');
  if (eqIndex !== -1) {
    const parsed = parseVarFlag(value);
    if (!parsed) {
      const key = value.slice(0, eqIndex);
      const msg = VALID_IDENTIFIER.test(key)
        ? `Reserved ${opts.label} name: "${key}" — cannot use __proto__, constructor, or prototype`
        : `Invalid ${opts.label}: "${value}" — key must match [a-zA-Z_][a-zA-Z0-9_]*`;
      throw new InvalidArgumentError(msg);
    }
    return [...previous, value];
  }
  if (!opts.allowEnvInherit) {
    throw new InvalidArgumentError(
      `Invalid ${opts.label}: "${value}" — the artifact channel requires KEY=<rd:// uri>`,
    );
  }
  if (!isValidVariableName(value)) {
    const msg = VALID_IDENTIFIER.test(value)
      ? `Reserved ${opts.label} name: "${value}" — cannot use __proto__, constructor, or prototype`
      : `Invalid ${opts.label} name: "${value}" — must match [a-zA-Z_][a-zA-Z0-9_]*`;
    throw new InvalidArgumentError(msg);
  }
  const envValue = process.env[value];
  if (envValue === undefined) {
    throw new InvalidArgumentError(
      `Environment variable "${value}" is not set (use --input ${value}=<value>)`,
    );
  }
  return [...previous, `${value}=${envValue}`];
}

/**
 * Commander argParser for `--input` (env-inherit allowed).
 *
 * @param value - Raw `key=value` or bare `KEY` (env-inherit) flag value
 * @param previous - Previously accumulated entries
 * @returns Updated array including the new entry
 * @throws {InvalidArgumentError} On invalid identifier or unset inherited env var
 * @see parseVarFlagOption
 */
export function parseInputOption(value: string, previous: string[]): string[] {
  return parseVarFlagOption(value, previous, { label: 'variable', allowEnvInherit: true });
}

/**
 * Commander argParser for `--artifacts` (env-inherit disabled).
 *
 * @param value - Raw `key=<rd:// uri>` flag value
 * @param previous - Previously accumulated entries
 * @returns Updated array including the new entry
 * @throws {InvalidArgumentError} On invalid identifier or a bare `KEY` (env-inherit is rejected for artifacts)
 * @see parseVarFlagOption
 */
export function parseArtifactOption(value: string, previous: string[]): string[] {
  return parseVarFlagOption(value, previous, { label: 'artifact', allowEnvInherit: false });
}
```

Apply the same full TSDoc (description + `@param` + `@returns` + `@throws`) to the
exported `parseInputJsonOption` / `parseArtifactJsonOption` wrappers.

Parameterise `parseInputJsonOption` the same way (add an internal `parseVarJsonOption(value, previous, label)` and export `parseInputJsonOption` + `parseArtifactJsonOption`), so the JSON error noun reads "artifact" for the artifact flag.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @rundown-org/cli test -- option-utils`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/helpers/option-utils.ts \
        packages/cli/__tests__/helpers/option-utils.test.ts
git commit -m "feat(cli): add artifact-channel flag parsers"
```

---

## Task 7: CLI artifact layering (`variable-discovery`)

**Files:**
- Modify: `packages/cli/src/services/variable-discovery.ts`
- Test: `packages/cli/__tests__/services/variable-discovery.test.ts`

**Interfaces:**
- Consumes: `BoundaryChannel`, `VariableLayer.channel`, `'artifact-cli'` kind (Task 2).
- Produces: `resolveVariables` / `collectRawLayers` accept `artifacts?: string[]` and `artifactsJson?: string[]`; emit a separate `{ kind: 'artifact-cli', channel: 'artifact', values }` layer; all existing layers carry `channel: 'variable'`.

- [ ] **Step 1: Write the failing layering test**

```typescript
it('emits a separate artifact layer with channel "artifact"', async () => {
  const uri = await seedManifestArtifact(cwd, 'PlanPath');
  const resolved = await resolveVariables(
    { artifacts: [`PlanPath=${uri}`] },
    cwd,
  );
  expect(isTrustedArtifactRecord(resolved.vars.PlanPath)).toBe(true);
});

it('tags every non-artifact layer as channel "variable"', async () => {
  const resolved = await resolveVariables({ input: ['name=value'] }, cwd);
  expect(resolved.vars.name).toBe('value');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rundown-org/cli test -- variable-discovery`
Expected: FAIL — `resolveVariables` does not accept `artifacts`; no artifact layer is produced.

- [ ] **Step 3: Add a `collectArtifactFlags` helper**

In `packages/cli/src/services/variable-discovery.ts`, add a collector that builds a raw record from the artifact flags (separate from `collectCliFlags`):

```typescript
/**
 * Collect raw artifact-channel values from `--artifacts` / `--artifacts-json`.
 *
 * @param options - Artifact flag arrays
 * @param options.artifacts - `key=rd://...` entries
 * @param options.artifactsJson - `key=<json array of rd:// uris>` entries
 * @returns Raw artifact record (rd:// URIs preserved; core validates and rehydrates)
 */
function collectArtifactFlags(
  options: { artifacts?: string[]; artifactsJson?: string[] },
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const flag of options.artifacts ?? []) {
    const parsed = parseVarFlag(flag);
    if (!parsed) {
      throw new Error(`Unexpected invalid --artifacts entry: ${flag} (parser should have rejected this)`);
    }
    result[parsed.key] = parsed.value;
  }
  for (const flag of options.artifactsJson ?? []) {
    const eqIndex = flag.indexOf('=');
    const key = flag.slice(0, eqIndex);
    if (!isValidVariableName(key)) {
      throw new Error(`Unexpected invalid --artifacts-json key: ${key} (parser should have rejected this)`);
    }
    const parsed: unknown = JSON.parse(flag.slice(eqIndex + 1)); // annotate to stop `any` escaping
    result[key] = parsed;
  }
  return result;
}
```

The re-validation here (`parseVarFlag` / `isValidVariableName`) is defensive — the
argParser already enforced it — so these `throw`s are invariant guards, not the
primary validation. Core does all `rd://` resolution; this collector only shuttles
raw values.

- [ ] **Step 4: Widen the options types, tag existing layers, append the artifact layer**

In `collectRawLayers` (lines 460-477), add `channel: 'variable'` to all five existing layers and append the artifact layer:

```typescript
async function collectRawLayers(
  options: {
    inputFile?: string[];
    input?: string[];
    inputJson?: string[];
    inheritedVars?: Record<string, VariableValue>;
    artifacts?: string[];
    artifactsJson?: string[];
  },
  cwd: string,
  warnings?: string[],
): Promise<VariableLayer[]> {
  return [
    { kind: 'builtins', channel: 'variable', values: getBuiltinVariables() },
    { kind: 'config', channel: 'variable', values: await discoverRawVariables(cwd) },
    { kind: 'inherited', channel: 'variable', values: options.inheritedVars ?? {} },
    { kind: 'env', channel: 'variable', values: collectEnvBridgeVars(warnings) },
    { kind: 'cli', channel: 'variable', values: await collectCliFlags(options, cwd) },
    { kind: 'artifact-cli', channel: 'artifact', values: collectArtifactFlags(options) },
  ];
}
```

Widen `resolveVariables` options (lines 512-518) with `artifacts?: string[]` and `artifactsJson?: string[]` so they thread into `collectRawLayers`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @rundown-org/cli test -- variable-discovery`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/services/variable-discovery.ts \
        packages/cli/__tests__/services/variable-discovery.test.ts
git commit -m "feat(cli): collect a separate artifact-channel layer"
```

---

## Task 8: Register `--artifacts` flags on commands

**Files:**
- Modify: `packages/cli/src/commands/run.ts`
- Modify: `packages/cli/src/commands/delegate.ts`
- Modify: `packages/cli/src/commands/claim.ts`
- Modify: `packages/cli/src/commands/resolve.ts`
- Test: `packages/cli/__tests__/commands/run.test.ts`

**Interfaces:**
- Consumes: `parseArtifactOption` / `parseArtifactJsonOption` (Task 6); `resolveVariables` artifact options (Task 7).

- [ ] **Step 1: Write the failing registration test**

```typescript
it('run accepts --artifacts and forwards it to resolution', async () => {
  const uri = await seedManifestArtifact(cwd, 'PlanPath');
  const { stdout } = await runCli(['run', runbookPath, '--artifacts', `PlanPath=${uri}`]);
  const out = JSON.parse(stdout);
  expect(out.ok).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rundown-org/cli test -- commands/run`
Expected: FAIL — `--artifacts` is an unknown option.

- [ ] **Step 3: Register the flags on each command**

In `packages/cli/src/commands/run.ts`, after the `--input-json` option (line 79), add (import `parseArtifactOption` / `parseArtifactJsonOption` and `Option`):

```typescript
    .addOption(
      new Option('--artifacts <key=uri>', 'Supply an input artifact by rd:// URI (repeatable)')
        .argParser(parseArtifactOption)
        .default([])
        .helpGroup('Input options:'),
    )
    .addOption(
      new Option('--artifacts-json <key=json>', 'Supply input artifacts as a JSON array of rd:// URIs (repeatable)')
        .argParser(parseArtifactJsonOption)
        .default([])
        .helpGroup('Input options:'),
    )
```

Thread `options.artifacts` / `options.artifactsJson` into the `resolveVariables(...)` call in the action handler, and widen the action's `options` type to include `artifacts?: string[]; artifactsJson?: string[]`.

Mirror the same two `addOption` blocks and the same threading in `delegate.ts` (after line 84), `claim.ts` (after line 148), and `resolve.ts` (after line 85). There is no `--artifacts-file` (spec §2 deliberate asymmetry).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rundown-org/cli test -- commands/run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/run.ts packages/cli/src/commands/delegate.ts \
        packages/cli/src/commands/claim.ts packages/cli/src/commands/resolve.ts \
        packages/cli/__tests__/commands/run.test.ts
git commit -m "feat(cli): register artifacts flags on run delegate claim resolve"
```

---

## Task 9: Property tests (parser + core)

**Files:**
- Test: `packages/parser/__tests__/frontmatter.properties.test.ts`
- Test: `packages/core/__tests__/runbook/variable-preparation.properties.test.ts` (or `artifacts-routing.properties.test.ts`)

**Interfaces:**
- Consumes: all behaviour from Tasks 1–5.

- [ ] **Step 1: Write the parser property tests**

Per spec Testing → Property:

```typescript
import fc from 'fast-check';

const ident = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]*$/).filter((s) => !isReservedTemplateName(s));

it('collision symmetry: error iff shared name in both channels (order-independent)', () => {
  fc.assert(
    fc.property(fc.uniqueArray(ident), fc.uniqueArray(ident), ident, (a, b, c) => {
      const inputs = [...a, c];
      const artifacts = [...b, c];
      const { diagnostics } = parseFrontmatter(buildFm({ inputs, artifacts }));
      const collided = new Set(inputs).has(c) && new Set(artifacts).has(c);
      expect(diagnostics.some((d) => /belongs to exactly one channel/.test(d.message))).toBe(collided);
    }),
  );
});

it('required over union: no diagnostic iff required ⊆ inputs ∪ artifacts', () => {
  fc.assert(
    fc.property(fc.uniqueArray(ident), fc.uniqueArray(ident), ident, (inputs, artifacts, extra) => {
      fc.pre(!inputs.includes(extra) && !artifacts.includes(extra));
      const union = [...inputs, ...artifacts];
      const okReq = parseFrontmatter(buildFm({ inputs, artifacts, required: union }));
      expect(okReq.diagnostics.filter((d) => /must also be declared/.test(d.message))).toEqual([]);
      const badReq = parseFrontmatter(buildFm({ inputs, artifacts, required: [extra] }));
      expect(badReq.diagnostics.filter((d) => /must also be declared/.test(d.message)).length).toBe(1);
    }),
  );
});

it('artifacts parse round-trip: dedup, order-preserved, parity with inputs', () => {
  fc.assert(
    fc.property(fc.array(ident), (names) => {
      const { frontmatter } = parseFrontmatter(buildFm({ artifacts: names }));
      const expected = [...new Set(names)];
      expect(frontmatter.artifacts ?? []).toEqual(expected.length ? expected : (frontmatter.artifacts ?? []));
    }),
  );
});
```

(`buildFm` and any existing `parseFrontmatter` import mirror the harness already used in the parser property suite; ensure collision/required filters in `buildFm` produce disjoint base sets where the property requires it.)

- [ ] **Step 2: Write the core rehydration-parity property test**

```typescript
it('scalar/array rehydration parity on the artifact channel', async () => {
  await fc.assert(
    fc.asyncProperty(fc.uniqueArray(ident, { minLength: 1, maxLength: 4 }), async (keys) => {
      const uris = await Promise.all(keys.map((k) => seedManifestArtifact(cwd, k)));
      const scalar = await resolveVariableLayers(
        [{ kind: 'artifact-cli', channel: 'artifact', values: { One: uris[0] } }],
        { cwd },
      );
      expect(isTrustedArtifactRecord(scalar.vars.One)).toBe(true);
      const array = await resolveVariableLayers(
        [{ kind: 'artifact-cli', channel: 'artifact', values: { Many: uris } }],
        { cwd },
      );
      expect(isTrustedArtifactArray(array.vars.Many)).toBe(true);
    }),
  );
});
```

- [ ] **Step 3: Run the property tests**

These are **characterization/property-pinning** tests written after Tasks 1–7, so
they should **PASS immediately** — that is not a TDD violation (property tests
legitimately pin already-built behaviour). Any failure is a real defect to fix in
the owning task, not the test.

```bash
pnpm --filter @rundown-org/parser test -- frontmatter.properties
pnpm --filter @rundown-org/core test:property
```

Note: parser has no `test:property` script — the new parser property file runs
under parser's normal `test` (and `verify`), not the root `test:property` gate
(which covers core + plugin only). This is fine; just don't expect it in the
property phase.

- [ ] **Step 4: Commit**

```bash
git add packages/parser/__tests__/frontmatter.properties.test.ts \
        packages/core/__tests__/runbook/variable-preparation.properties.test.ts
git commit -m "test: property-pin artifacts channel collision required and rehydration"
```

---

## Task 10: Integration tests + clean-break migration (cli)

**Files:**
- Test: `packages/cli/__tests__/integration/artifacts-channel.test.ts` (new)
- Migrate: `packages/cli/__tests__/integration/artifact-variable-inputs.test.ts`

**Interfaces:**
- Consumes: the full CLI surface (Tasks 6–8).

- [ ] **Step 1: Write the new end-to-end integration tests**

```typescript
describe('artifacts channel (integration)', () => {
  it('rd run --artifacts rehydrates and projects a local path', async () => {
    const uri = await seedManifestArtifact(cwd, 'PlanPath');
    const { stdout } = await runCli(['run', planRunbook, '--artifacts', `PlanPath=${uri}`]);
    expect(JSON.parse(stdout).ok).toBe(true);
  });

  it('rejects a non-rd:// --artifacts value at the boundary', async () => {
    const { stdout, exitCode } = await runCliInProcess(['run', planRunbook, '--artifacts', 'PlanPath=just-a-string'], workspace);
    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout).error).toMatch(/Artifact input "PlanPath"/);
  });

  it('is read-only: a successful --artifacts run mints no new manifest rows', async () => {
    const uri = await seedManifestArtifact(cwd, 'PlanPath');
    const before = readManifestRowCount(cwd); // count rows in the artifact manifest
    const { exitCode } = await runCliInProcess(['run', planRunbook, '--artifacts', `PlanPath=${uri}`], workspace);
    expect(exitCode).toBe(0);
    expect(readManifestRowCount(cwd)).toBe(before); // invariant #3: channel never mints rows
  });

  it('FOR loop over an array of artifacts projects per iteration', async () => {
    const a = await seedManifestArtifact(cwd, 'p0'); // rd://artifacts/<ctx>/<run>/p0
    const b = await seedManifestArtifact(cwd, 'p1');
    const { stdout, exitCode } = await runCliInProcess(
      ['run', forLoopRunbook, '--artifacts-json', `Plans=["${a}","${b}"]`],
      workspace,
    );
    expect(exitCode).toBe(0);

    // Follow the established FOR-loop assertion pattern (for-loop-data-sources.test.ts:96-112):
    // parse the JSON event stream and assert one command per iteration, each projecting its
    // own artifact's LOCAL PATH (spec §4: {{plan}} → local path). The fixture's command is
    // `rd echo plan={{ path plan }} index={{ Index }}`.
    const events = parseJsonEvents(stdout);
    const commandStarted = events.filter((e) => e.type === 'command_started');
    expect(commandStarted).toHaveLength(2);

    const localPathOf = (uri: string) => uri.split('/').pop()!; // p0 / p1 — the manifest key segment
    expect(commandStarted[0].command).toContain(`plan=`);
    expect(commandStarted[0].command).toContain(localPathOf(a));
    expect(commandStarted[0].command).toContain('index=1');
    expect(commandStarted[1].command).toContain(localPathOf(b));
    expect(commandStarted[1].command).toContain('index=2');

    // No unresolved template survives — proves per-iteration projection, not a passthrough.
    expect(JSON.stringify(events)).not.toContain('{{');
  });

  // Flag-plumbing smoke test (spec §2 / Testing → Integration): each command must REGISTER
  // --artifacts (Task 8) — i.e. NOT reject it as an unknown option. Delegation *inheritance*
  // (auto-pass to a child run) is out of scope, so the assertion is flag acceptance, not
  // artifact propagation. Each command takes its own real minimal args (claim needs a token,
  // delegate a --step, resolve a name); a command may still exit non-zero for unrelated setup
  // reasons, but an "unknown option" error is exactly what registration must prevent.
  it.each<[string, string[]]>([
    ['delegate', ['delegate', '--step', '1.1']],
    ['claim', ['claim', '__no_such_token__']],
    ['resolve', ['resolve', 'PlanPath']],
  ])('%s registers --artifacts (parses, not an unknown option)', async (_cmd, baseArgs) => {
    const uri = await seedManifestArtifact(cwd, 'PlanPath');
    const { stdout, stderr } = await runCliInProcess(
      [...baseArgs, '--artifacts', `PlanPath=${uri}`],
      workspace,
    );
    expect(`${stdout}\n${stderr}`).not.toMatch(/unknown option.*--artifacts/i);
  });
});
```

(Use a `forLoopRunbook` fixture declaring `artifacts: [Plans]`, `FOR plan IN {{ Plans }}`, and a
per-iteration command `rd echo plan={{ path plan }} index={{ Index }}`; this verifies the spec §3
"array artifacts work for free" claim and §4 projection rather than assuming them. Import
`parseJsonEvents` from the integration test helpers, as `for-loop-data-sources.test.ts` does.)

- [ ] **Step 2: Migrate the clean-break integration suite**

In `packages/cli/__tests__/integration/artifact-variable-inputs.test.ts` (use `runCliInProcess(args, workspace)` and read `.exitCode`):
- Lines `:54, :70, :158, :205, :231` assert `--input*` rd:// → branded artifact. Change each to `--artifacts` (or `--artifacts-json`) and keep the branded-value assertion.
- Lines `:102` (`--input-json`) and `:127` (`--input-file`) are **forgery-rejection** tests, not branded-artifact tests. `:102` → re-target to `--artifacts-json` and keep the forgery rejection. `:127` uses `--input-file`, which has **no `--artifacts-file` equivalent** (deliberate asymmetry): do **not** "migrate to `--artifacts`" — re-assert it as variable-channel behaviour (a forged `rd://`-shaped value supplied via `--input-file` is now a plain string under the clean break, no longer rehydrated/forgery-checked).
- Lines `:174, :190` assert string passthrough — these now describe the *new* correct behaviour of `--input rd://`; keep them but update the comment/justification to state that `--input` no longer rehydrates (clean break).

- [ ] **Step 3: Run the integration tests to verify they pass**

Run: `pnpm --filter @rundown-org/cli test -- integration/artifacts-channel integration/artifact-variable-inputs`
Expected: PASS. The `@rundown-org/cli` package suite is green again from here.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/__tests__/integration/artifacts-channel.test.ts \
        packages/cli/__tests__/integration/artifact-variable-inputs.test.ts
git commit -m "test(cli): integration-cover artifacts channel and migrate clean break"
```

---

## Task 11: Scenario coverage (execute-plan, #467/#480)

> **Harness prerequisite.** The existing scenario harness only captures
> **produced** artifacts (`STEP_ENTERED.artifacts`) and substitutes `${TOKEN}` /
> claim-IDs in commands (`packages/cli/__tests__/.../command-sequence.ts:165-168,426-428`);
> it has **no way to seed a manifest row or template a captured `rd://` URI into a
> later `--artifacts` command**. A true boundary-channel scenario therefore
> requires a small harness extension first (Steps 1–2). The existing
> `runbooks/artifacts/artifacts-scenario.runbook.md` produces+consumes within one
> run via the naked consumer — it does **not** exercise the boundary channel.

**Files:**
- Modify: the scenario command-substitution layer (`command-sequence.ts`) — add an artifact-seed/URI-capture directive.
- Modify: `scenario-runner.test.ts` (or its support module) — wire the seed step.
- Create: a scenario runbook fixture under repo-root `runbooks/` (scenarios are discovered there, per `scenario-runner.test.ts:60`).

**Interfaces:**
- Consumes: the full feature + the new scenario-seed directive.

- [ ] **Step 1: Extend the scenario harness to seed + template an artifact URI**

Add a scenario directive that (a) seeds a manifest row (reusing the same
`appendArtifactManifestRecordSync` path the test helpers use) and (b) exposes its
`rd://` URI as a substitution token, so a scenario command can write
`--artifacts PlanPath=${ARTIFACT:PlanPath}`. Mirror the existing `${TOKEN}`
substitution mechanism (`command-sequence.ts:165-168`); keep it within the
scenario harness only (no production-code change).

- [ ] **Step 2: Unit-test the harness extension**

Add a focused test that the new seed directive writes a row and that
`${ARTIFACT:…}` resolves to its URI, so the extension itself is pinned before a
scenario depends on it.

- [ ] **Step 3: Write the failing scenario fixture**

Create `runbooks/artifacts/execute-plan.runbook.md` declaring the artifact channel.
**Critical:** the step MUST contain a naked `- ARTIFACTS\n  - PlanPath` consumer.
The `expect.artifacts` assertion matches against `step_entered.artifacts` (see the
TSDoc on `ArtifactAssertionSchema`, `packages/cli/src/schemas/scenarios.ts:63-64`:
"The `alias` field names the ARTIFACTS variable in a `step_entered.artifacts`
working set"). That working set is populated by the **step-level** ARTIFACTS
directive — *not* by boundary supply alone. Without the naked consumer block the
`expect.artifacts` assertion matches nothing and the scenario silently asserts
emptiness. The naked consumer is also exactly what proves **naked-consumer
acceptance** of a `--artifacts`-supplied branded value (it early-returns the
branded value by reference). Follow the existing producer/consumer shape in
`runbooks/artifacts/artifacts-scenario.runbook.md` (map-keyed `scenarios:`, `at:`
step index):

```markdown
---
name: execute-plan
artifacts:
  - PlanPath
required:
  - PlanPath
scenarios:
  consume-plan-artifact:
    description: a boundary --artifacts value is consumed by a naked ARTIFACTS step
    seed:
      - artifact: PlanPath          # new directive: seeds a manifest row, exposes ${ARTIFACT:PlanPath}
    commands:
      - "rd run execute-plan.runbook.md --artifacts PlanPath=${ARTIFACT:PlanPath}"
    expect:
      result: COMPLETE
      artifacts:
        - at: "1"                   # matches step_entered.artifacts on step 1
          alias: PlanPath
          kind: artifact-record
          exists: true
---
# Execute Plan

## 1. Read the plan

- ARTIFACTS
  - PlanPath
- PASS COMPLETE

```bash
rd echo --result pass plan={{ path PlanPath }}
```
```

**The step MUST carry a command block.** A prompt-only step (no command) returns
`'waiting'` at `packages/cli/src/services/execution.ts:1297`
(`expandedCommandCode === undefined`), so `- PASS COMPLETE` never auto-fires from
`rd run` alone and `expect.result: COMPLETE` would hang/fail. The command above
(mirroring step 3 of `artifacts-scenario.runbook.md`) produces the pass result that
`PASS COMPLETE` maps to COMPLETE, and interpolating `{{ path PlanPath }}` exercises
projection without coupling completion to the file existing on disk.

**Why not `test -f "{{ path PlanPath }}"`?** The seed directive (Step 1) writes a
**manifest row**, and manifest-based rehydration produces a branded record from
that row alone — it does **not** require the backing file to exist. `rd echo
--result pass` therefore keeps the run's COMPLETE result decoupled from whether the
seed harness also wrote a file. If Step 1 is extended to write the backing file
too, `test -f "{{ path PlanPath }}"` becomes a valid stronger alternative that also
asserts the projected path resolves to a real file. (The other option — a
prompt-only step plus a second scenario command `"rd pass"` — also works, but the
command-block form matches the existing fixture.)

This exercises three things end-to-end: (1) the boundary channel rehydrates the
`--artifacts` value to a branded record; (2) the **naked consumer** (`- ARTIFACTS\n
  - PlanPath`) accepts that branded value and surfaces it into
`step_entered.artifacts.PlanPath`, which the `at: "1"` / `alias: PlanPath`
assertion pins; (3) §4 projection (`{{ path PlanPath }}` local path /
`{{artifact PlanPath}}` canonical URI).

- [ ] **Step 4: Run the scenario to verify it fails then passes**

Run: `pnpm --filter @rundown-org/cli test -- scenario`
Expected: FAIL before the harness extension + fixture exist; PASS once wired.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/__tests__ runbooks/artifacts/execute-plan.runbook.md
git commit -m "test(cli): scenario-cover execute-plan artifacts channel (+ harness seed directive)"
```

---

## Task 12: Descriptive docs

These are **descriptive** edits (per CLAUDE.md: `docs/` describes code that now
exists). Each insertion below names its exact section anchor and the text to add
or correct. Do not paraphrase the spec — describe the shipped behaviour.

**Files:**
- Modify: `docs/spec/language.md` (§3.1, §9.1, §10, §10.1)
- Modify: `docs/reference/cli.md` (`rundown run` §, `rundown resolve` §, delegate/claim §§)

- [ ] **Step 1: `docs/spec/language.md` — frontmatter `artifacts:` field (§3.1, line ~49-69)**

Add `artifacts` to the frontmatter field description beside `inputs`, e.g.:

> `artifacts` — a YAML sequence of bare identifier names declaring input
> artifacts the runbook expects to be **supplied at its boundary** via the
> `--artifacts` channel (distinct from the step-level `ARTIFACTS` directive,
> §10.1). `inputs` and `artifacts` form one flat namespace: a name declared in
> both is an error. `required` validates over `inputs ∪ artifacts`.

- [ ] **Step 2: `docs/spec/language.md` — correct the "not valid in frontmatter" claim (§10.1, lines 464-466)**

The current text reads "It is an execution-unit directive only; it is valid on
steps and substeps and is **not valid in frontmatter**." This is now wrong for
the *frontmatter declaration* (the step-level **directive** is still
step/substep-only). Reword to distinguish the two:

> The step-level `ARTIFACTS` **directive** is an execution-unit directive, valid
> on steps and substeps only — it is not a step-level directive in frontmatter.
> Frontmatter `artifacts:` is a separate, boundary-channel **declaration** (names
> only, no keys; see §3.1 and §9.1): it declares artifacts supplied to the run,
> whereas the directive consumes/produces them during execution.

- [ ] **Step 3: `docs/spec/language.md` — variable precedence note (§9.1, line ~370)**

After the CLI input precedence list, add a note that the artifact channel is
**separate** from the variable precedence stack:

> Artifacts supplied via `--artifacts` / `--artifacts-json` are a distinct
> boundary channel, not part of this variable precedence stack. A name is
> resolved by exactly one channel; supplying the same name via both `--input` and
> `--artifacts` is an error.

- [ ] **Step 4: `docs/reference/cli.md` — `rundown run` flags (after line 202-204)**

Add to the `run` flag list, immediately after the `--input*` bullet:

> - `--artifacts <key=rd://uri>` / `--artifacts-json <key=json-array>` — Supply
>   **input artifacts** (both repeatable). Values MUST be `rd://artifacts/...`
>   URIs (or, for `--artifacts-json`, a JSON array of such URIs) naming **existing**
>   manifest rows — the channel is read-only and never mints rows; a non-`rd://`
>   value is a hard error. There is intentionally **no `--artifacts-file`** and no
>   `KEY`-only env-inherit form (deferred). Declared via frontmatter `artifacts:`.

Add an example beside lines 189-191:

```bash
rundown run execute-plan.runbook.md --artifacts PlanPath=rd://artifacts/ctx/run/PlanPath
rundown run fanout.runbook.md --artifacts-json 'Plans=["rd://artifacts/ctx/run/p0","rd://artifacts/ctx/run/p1"]'
```

- [ ] **Step 5: `docs/reference/cli.md` — `rundown resolve` + delegate/claim (line ~561-573 and the delegate/claim sections)**

In the `resolve` section, mirror the same `--artifacts` / `--artifacts-json`
bullet and note all input/artifact flags are repeatable. For `delegate` and
`claim`, add the flags to their option lists with a one-line note: the flags
register and reach core, but **automatic** inheritance of artifacts to a child
run is deferred (flag plumbing only).

- [ ] **Step 6: Run doc checks**

Run:
```bash
pnpm run check:spell
pnpm run check:format
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add docs/spec/language.md docs/reference/cli.md
git commit -m "docs: describe artifacts boundary channel and flags"
```

---

## Task 13: Final verification

- [ ] **Step 1: Run the full pre-PR gate**

Run:
```bash
pnpm run verify
```
Expected: PASS (check format, spell, lint, build, full test suite). The clean break is fully migrated by this point, so the full suite is green.

- [ ] **Step 2: Spot-check the mutation gate (optional but recommended)**

Run a scoped mutation pass over the changed core seam to confirm the clean-break paired test (Task 2 Step 1) kills the channel mutant:
```bash
pnpm run test:mutate:core -- --mutate packages/core/src/runbook/variable-preparation.ts
```
Expected: the `channel` discriminant mutants are killed (no survivors on the artifact/variable branch).

- [ ] **Step 3: Commit any verification-driven fixes**

```bash
git add -A
git commit -m "chore: verification fixes for artifacts boundary channel"
```

---

## Self-Review Notes

Spec coverage map (every spec section → task):

- Frontmatter §1 (field, schema, casing, guard removal, generalise filter, collision, required-union, iteration-binding) → Tasks 1 + 5.
- CLI surface §2 (flags, reuse parsers, env-arm suppression, deliberate asymmetry) → Tasks 6 + 8.
- Core routing §3 (BoundaryChannel discriminant, must-resolve, required gate, cross-channel collision, reused readers) → Tasks 2 + 3 + 4 + 5.
- Consumer/projection §4 (unchanged) → no task needed; the naked-consumer acceptance of a `--artifacts`-supplied branded value and projection (`{{PlanPath}}` / `{{artifact PlanPath}}`) are verified end-to-end by Task 11.
- Testing matrix (unit/property/integration/scenario + clean-break migration) → Tasks 1–5 (unit), 9 (property), 10 (integration + migration, incl. read-only never-mints assertion), 11 (scenario, incl. a small scenario-harness seed-directive extension). Mutation: Task 2's paired tests bracket **both** consume sites (scalar + array); Task 13 runs the scoped mutation pass.
- Files touched → covered across Tasks 1–8 + 12; `artifact-inputs.ts` and `artifact-directive-resolver.ts` are reused verbatim (no task).
- TSDoc → required inline in every task that adds/changes an exported symbol (`BoundaryChannel`, `VariableLayer.channel`, `artifacts` field, `ArtifactInputName`, `filterDeclarationArray`, `parseArtifactOption` / `parseArtifactJsonOption`).
- No persisted-state migration → guaranteed by Task 2 reusing the existing branded-value path into `RunbookState.variables`; no `.rundown/` schema change in any task.
