# Rundown — Deferred / Speculative Spec Content

> **Agent attention warning:** This document describes features that are NOT implemented in the current codebase. Agents MUST NOT use this document when implementing features, planning batches, writing tests, or answering questions about how the system works today. Refer to `docs/spec/language.md`, `docs/spec/uri.md`, `docs/spec/grammar.md`, and `docs/spec/cli-output.md` for the canonical current specification. Use this document ONLY when the user explicitly references "deferred", "speculative", "future", or "this deferred-spec doc" in their request.

This document collects spec language that describes intended-but-not-yet-implemented behaviour. Each section names which canonical spec section the content was previously embedded in, and what gates re-promotion (typically: a future implementation batch landing the feature).

---

## Selector URI query parameters

**Original location:** `docs/spec/uri.md §5.4`.
**Re-promotion gate:** A future batch implementing query-parameter dispatch in `packages/core/src/runbook/artifact-directive-resolver.ts`. The current state is partial: the parser accepts query keys but the resolver does not filter on them.

### Current status (Batch 2 onward)

- **Parser:** `parseArtifactUri` in `packages/core/src/runbook/artifact-uri.ts` accepts the four supported keys (`status`, `runbook`, `source`, `latest`) and rejects any other key.
- **Resolver:** `resolveSelector` in `packages/core/src/runbook/artifact-directive-resolver.ts` IGNORES `selector.query` and returns unfiltered selector results — every coalesced manifest row that matches `(contextId, runId, key)` plus the per-row file-existence check.
- **Why deferred:** The filtering engine itself already exists — `findArtifactMatches` in `packages/core/src/runbook/artifact-manifest.ts` fully implements all four query keys (`status`, `runbook`, `source`, `latest`) and the sibling-run lifecycle filter, and is covered by tests. What is deferred is wiring that engine into the ARTIFACTS directive path: `resolveSelector` in `packages/core/src/runbook/artifact-directive-resolver.ts` does not call `findArtifactMatches`, so `findArtifactMatches` currently has no production caller.

### Acceptance criteria for the future implementation

- Filtering applies to selector results before they are surfaced as the resolved `ArtifactVarValue`.
- Unknown query keys remain rejected at parse time (`parseQuery`).
- Tests cover each supported key in isolation and in combination (`status=any` + `latest=true`, multiple `runbook=` filters, etc.).
- The "lifecycle eligibility" section below lands at the same time so authors have the documented escape hatch.

### 5.4 Query parameters (selector form only)

Query parameters appear only on selector URIs (§6.2). The complete set of
allowed query keys is:

| Key | Meaning |
|-----|---------|
| `status` | Lifecycle filter for sibling-run eligibility (e.g. `any`). |
| `runbook` | Filter manifest rows by `runbook.path`. |
| `source` | Filter manifest rows by `runbook.source`. |
| `latest` | When `true`, reduce matches to the latest match per group. |

Implementations MUST reject URIs that contain any query parameter outside this
allow-list. Repeated keys are permitted; values are interpreted in source
order.

The selector URI grammar accordingly admits an optional `query_string`:

```ebnf
selector_artifact_uri
                    ::= "rd://artifacts/" context_segment "/" run_selector "/" key_segment query_string?

query_string        ::= "?" query_param ( "&" query_param )*
query_param         ::= ( "status" | "runbook" | "source" | "latest" ) "=" query_value
query_value         ::= [^&#]*
```

The classifier rule that "a URI is a selector when its `runId` segment is `*`
OR when it carries a non-empty query string" is part of this deferred surface.
In current behaviour the parser sees query strings on selector URIs and routes
them through the unfiltered resolver path; the discriminator is therefore the
`runId === '*'` form for now.

---

## Sibling-run lifecycle eligibility filtering

**Original location:** `docs/spec/language.md §10.1` (sentence at line 447 of the version prior to this refactor).
**Re-promotion gate:** Lands together with the `status` query parameter (above) so authors have a spec-blessed override.

The deferred sentence read:

> Records from other runs are eligible only when their run state is completed
> and has `terminalAt`.

This sentence was paired with the `status=any` query parameter: lifecycle
filtering would be the default for cross-run selector matches, and authors
could override per-selector by appending `?status=any`. Without the override
the rule was the worst of both worlds — enforcement with no escape hatch — so
the lifecycle filter was withdrawn alongside the query-parameter surface. When
the `status` query parameter lands, this sentence (or its replacement)
re-enters `language.md §10.1` next to the override clause.

In the meantime the same-context guard and per-row file-existence check remain
the active safety mechanisms for cross-run selector results.

---

## Future URI namespaces

**Original location:** `docs/spec/uri.md §12`.
**Re-promotion gate:** Each namespace requires its own grammar definition and an implementation batch.

This section is non-normative.

The following namespaces are reserved for possible future use. Their grammar
and semantics are undefined; implementations MUST reject URIs that use them
until they are registered in `uri.md §3.1`.

- `rd://contexts/...` — context-scoped resources.
- `rd://runs/...` — run-scoped resources outside the artifact namespace.

The current `rd://artifacts/...` form leaves room for these and other
namespace prefixes without grammar collisions.
