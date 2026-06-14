---
version: 1.0.0
---

# Rundown URIs (`rd:` scheme)

## 1. Scope

This document is the normative reference for the Rundown URI scheme `rd:`. It
specifies:

- the registered scheme name and registered namespaces,
- the URI grammar in W3C EBNF,
- the constraints on each URI component (`contextId`, `runId`, `key`),
- the two URI forms — exact and selector — and when each is used,
- the deterministic mapping from URIs to filesystem paths under `WorkPath`,
- the per-context manifest format and scoping rules,
- the identity tuple and coalescing rule that governs duplicate manifest rows,
- the round-trip and canonicalization requirements for URI producers and
  consumers.

This document is the source of truth for the URI grammar, namespace
registration, key/component constraints, on-disk storage layout, the manifest
record shape, manifest scoping, and the coalescing rule. Where other Rundown
specifications mention URIs or manifests, they refer to terms defined here.

This document governs only the `rd:` *URI* scheme. It is unrelated to the
`namespace:name` runbook-discovery syntax (for example `rundown:write-plan`),
which selects a runbook *source* and is a separate mechanism documented under
Runbook Discovery; that syntax is not an `rd:` URI and is out of scope here.

**Run-scoping invariant.** Every artifact is owned by exactly one run,
identified by the producer's `runId`. The grammar (§4) and storage layout
(§7) reflect this: a URI identifies a `(contextId, runId, key)` triple, and
an artifact MUST NOT be addressable under a context without a `runId`
segment. Same-context delegation makes artifacts produced by sibling runs
visible through the shared manifest (§9), but ownership stays with the
producer. There is no artifact namespace under a context that exists
outside a run.

This invariant, and the `rd:` URI grammar in §3–§7 and §11, govern *managed*
artifacts. The manifest (§8) may also contain *file-reference* rows whose
`uri` field is a `file:` URI pointing at a pre-existing local file; those rows
are a separate record class, are not `rd:` URIs, and are specified in §8.

Non-normative cross-references:

- [docs/spec/language.md §10](language.md#10-context-passing) — `ARTIFACTS`
  directive semantics that consume URIs and read the manifest.
- [docs/spec/grammar.md](grammar.md) — Rundown markdown grammar; the URI
  grammar in §4 is the authoritative form.
- [docs/reference/runtime.md §8.6](../reference/runtime.md#86-built-in-variables)
  — runtime semantics of `ContextId`, `RunId`, and `WorkPath`.

## 2. Conformance

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as
described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

A conforming implementation:

1. MUST accept every URI permitted by the grammar in §4.
2. MUST reject every URI that violates a MUST-level rule in §3, §4, §5, §7,
   §8, §9, or §11.
3. MUST produce only canonical URIs (§11) when constructing URIs from concrete
   identity values.
4. MUST treat URIs as the dual reference: the same URI addresses both the
   on-disk artifact file (§7.1) and the manifest row (§7.2).

## 3. Scheme

The registered scheme name is `rd`. The general form of an `rd:` URI is:

```text
rd://<namespace>/<path>
```

where `<namespace>` is the URL hostname segment and is fixed, case-sensitive,
and required. Implementations MUST reject URIs whose scheme is not exactly
`rd:` and whose hostname is not a registered namespace.

### 3.1 Registered namespaces

| Namespace | Status | Defined in |
|-----------|--------|-----------|
| `artifacts` | Registered | This document, §4–§11 |

All other hostnames are reserved for future use. Implementations MUST reject
URIs whose hostname is not a currently registered namespace.

The `rd:` URI namespaces in this table are distinct from the `namespace:name`
runbook-discovery syntax (for example `rundown:write-plan`): that syntax is a
runbook-*source* selector, not an `rd:` URI, and is governed by Runbook
Discovery rather than by this document.

URI fragments are invalid in any namespace and MUST be rejected.

## 4. Grammar (EBNF)

The following EBNF defines the formal grammar for `rd:` URIs. Notation follows
[docs/spec/grammar.md](grammar.md#notation).

```ebnf
rd_uri              ::= artifact_uri

artifact_uri        ::= exact_artifact_uri | selector_artifact_uri

exact_artifact_uri  ::= "rd://artifacts/" context_segment "/" run_segment "/" key_segment

selector_artifact_uri
                    ::= "rd://artifacts/" context_segment "/" run_selector "/" selector_key_segment query_string?

context_segment     ::= pct_encoded_safe_id   /* decoded value MUST satisfy ctx_ref */
run_segment         ::= pct_encoded_run_id    /* decoded value MUST match RUN_ID_PATTERN */
run_selector        ::= run_segment | "*"
key_segment         ::= pct_encoded_artifact_key  /* decoded value MUST satisfy exact_artifact_key */
selector_key_segment
                    ::= pct_encoded_selector_key  /* decoded value MUST satisfy selector_artifact_key */

pct_encoded_safe_id ::= (* RFC 3986 percent-encoded segment whose decoded value matches [A-Za-z0-9._-]+ *)
pct_encoded_run_id  ::= (* RFC 3986 percent-encoded segment whose decoded value matches RUN_ID_PATTERN *)
pct_encoded_artifact_key
                    ::= (* RFC 3986 percent-encoded segment whose decoded value matches exact_artifact_key *)
pct_encoded_selector_key
                    ::= (* RFC 3986 percent-encoded segment whose decoded value matches selector_artifact_key *)

query_string        ::= "?" query_param ( "&" query_param )*
query_param         ::= runbook_filter | source_filter | latest_filter
runbook_filter      ::= "runbook=" query_value
source_filter       ::= "source=" ( "project" | "plugin" | "bundled" )
latest_filter       ::= "latest=true"
query_value         ::= (* RFC 3986 query value; decoded value MUST be non-empty *)
```

The scheme prefix `rd://artifacts/` is fixed and case-sensitive. Each
artifact URI has exactly three path segments after the namespace:
`contextId`, `runId`, and `key`. Implementations MUST reject URIs that use a
different scheme or hostname, or that present a number of path segments
other than three.

`RUN_ID_PATTERN` is defined as `rd_` followed by exactly 32 lowercase
hexadecimal characters. The canonical source for this pattern is
`packages/core/src/runbook/run-id.ts`.

`ctx_ref` and `exact_artifact_key` are defined in
[docs/spec/grammar.md §Lexical Rules](grammar.md#lexical-rules). They share the
same character class (`[A-Za-z0-9._-]+`) and reject `.`, `..`, empty values,
slashes, traversal, and recursive `**`.
`selector_artifact_key` is the union of `exact_artifact_key` and a wildcard
form: it permits `*` and `?` glob characters in addition to the exact
character class (`[A-Za-z0-9._*?-]+`), while still rejecting `.`, `..`, empty
values, slashes, traversal, and recursive `**`. A literal `?` written in a
hand-authored URI key MUST be percent-encoded (`%3F`) so it is not parsed as
the URI query-string delimiter.

## 5. Components

### 5.1 contextId

The `contextId` is the first path segment after the namespace. Its decoded
value MUST satisfy the `ctx_ref` production (`[A-Za-z0-9._-]+`, with `.` and
`..` rejected). It identifies the context that owns the artifact run scope and
selects the per-context manifest (§7.2).

A context segment of `*` is invalid: cross-context wildcards are not supported.
Implementations MUST reject URIs whose context segment is `*` or whose decoded
context segment fails `ctx_ref`.

### 5.2 runId

The `runId` is the second path segment after the namespace, between the
`contextId` segment and the `key` segment. In an exact URI (§6.1) its
decoded value MUST match `RUN_ID_PATTERN` — exactly `rd_` followed by 32
lowercase hexadecimal characters. In a selector URI (§6.2) it MAY be the
literal `*`.

Bare placeholders such as `RunId` and `ContextId` are invalid in any segment
and MUST be rejected, as are unresolved `{{template}}` markers.

### 5.3 key

The `key` is the final path segment. Its validation depends on the URI form
(§6):

- In an **exact** URI, the decoded key MUST satisfy `exact_artifact_key`
  (`[A-Za-z0-9._-]+`, with `.` and `..` rejected, slashes rejected, traversal
  rejected, recursive `**` rejected, empty rejected). An exact URI addresses
  exactly one artifact file, so its key MUST NOT carry `*` or `?`.
- In a **selector** URI, the decoded key MUST satisfy `selector_artifact_key`
  — the same character class extended with `*` and `?` glob characters
  (`[A-Za-z0-9._*?-]+`), with the same rejections (`.`, `..`, slashes,
  traversal, recursive `**`, empty). A selector key MAY be exact OR carry
  globs; an exact selector key simply matches one literal name across the
  selected runs.

A glob key (`*` or `?`) makes a URI a **selector** even when its run segment
is concrete (§6): the URI is then a selector scoped to that single run. A
glob key therefore never appears in an **exact** URI — the exact form is the
producer surface and addresses exactly one file, so its key MUST be exact.
`parseArtifactUri` classifies any glob-keyed URI as a selector; the exact-URI
builder is what rejects a glob key.

A literal `?` in a hand-written selector key MUST be percent-encoded (`%3F`);
an unencoded `?` is parsed as the URI query-string delimiter.

**Length:** No normative length cap is currently enforced. Implementations MAY
enforce a reasonable filesystem-compatible cap on key length (for example 255
bytes, matching POSIX `NAME_MAX`). This is flagged for possible future
tightening; until that decision is made, implementations SHOULD NOT reject
keys solely on length grounds below an obvious filesystem limit.

## 6. Forms

A URI is either exact or selector. The discriminator is structural: a URI is
**exact** iff its `runId` segment is concrete (matches `RUN_ID_PATTERN`), its
`key` segment is exact (no `*`/`?`), and it carries no query string. Any
wildcard in the `runId` or `key` segment, or any query string, makes the URI a
**selector**. Implementations MUST classify accordingly. A query string is
permitted only on selector URIs; an exact URI MUST NOT carry one.

### 6.1 Exact form

```text
rd://artifacts/<contextId>/<runId>/<key>
```

All components are concrete: no wildcards, no query string, all values fully
specified. An exact URI addresses exactly one artifact file (§7.1) and
references exactly one identity tuple (§8) in the owning manifest.

### 6.2 Selector form

```text
rd://artifacts/<contextId>/<run_selector>/<selector_key>
```

A selector URI is the read-only query form. It is a selector when its `runId`
segment is the literal `*`, OR its `key` segment carries `*`/`?` globs, OR it
carries a query string. The `contextId` segment is always concrete. It is
produced by `ARTIFACTS` declarations — by the shorthand forms (a bare token,
or a token with a leading `*/` cross-run prefix; see
[language.md §10.1.1](./language.md#1011-expansion-rules)) and by explicit
selector URI literals — and consumed by manifest selector resolution. A
selector URI resolves to zero or more `ArtifactRecord` values and never writes
a manifest row.

Selectors have no opinion on arity: the resolved value is an `ArtifactRecord`
when the manifest yields exactly one matching row, an `ArtifactRecord[]` when
it yields many, or an empty array when none. The runbook's structure
determines the expected number of records. Empty selector results are
meaningful and MUST NOT be collapsed to absence.

The exact form (§6.1), by contrast, is the producer surface: the shorthand
`ARTIFACTS` form with an exact key and no `*/` prefix expands to an exact URI
for the current context and current run, and the resolver appends a manifest
row for that identity at directive evaluation. The artifact file itself is
written by the agent, not the resolver. A glob key can never be a producer:
structurally, a glob key forces selector classification.

#### 6.2.1 Selector query parameters

Selector query parameters filter manifest metadata before the resolved
artifact working set is exposed to downstream query or assertion layers. They
do not read artifact content and MUST NOT embed JSONPath, JMESPath, schema
checks, or document-content predicates.

Allowed query keys are:

| Key | Meaning |
| --- | --- |
| `runbook` | Exact match on `record.runbook.path`. Repeated params are OR filters. |
| `source` | Exact match on `record.runbook.source`; allowed values are `project`, `plugin`, and `bundled`. Repeated params are OR filters. |
| `latest` | `latest=true` collapses matches to the newest manifest record per `(runbook.source, runbook.path, key)` group. |

Implementations MUST reject unsupported query keys, unsupported `source`
values, empty `runbook` values, any `latest` value other than `true`, and more
than one `latest` parameter.

Filters of different types are combined with AND: a record matches only if it
satisfies the `runbook` filter AND the `source` filter AND the `latest`
condition (when present). Repeated parameters of the same key remain OR filters
within that key, as noted in the table above.

`latest=true` is manifest-record based: it uses the record `timestamp` after
the selector's context/run/key/file-existence filters and any `runbook` /
`source` filters have been applied. If two records in the same latest group
share the same timestamp, the record with the lexicographically greater
canonical artifact URI wins.

## 7. Storage layout (mapping rules)

### 7.1 File path

For an exact URI of the form `rd://artifacts/<ctx>/<run>/<key>`,
implementations MUST resolve the artifact payload to:

```text
<WorkPath>/.rd-<ctx>/<run>/<key>
```

The on-disk layout mirrors the URI path 1:1. Implementations MUST resolve
artifact paths so that the resulting absolute path remains contained under
`<WorkPath>` after symlink resolution; symlinked segments within the artifact
subtree MUST be rejected.

`<WorkPath>` is project-shared by default and MUST NOT be derived from the git
branch, checkout path, or run id. See
[docs/reference/runtime.md §8.6](../reference/runtime.md#86-built-in-variables).

### 7.2 Manifest path

Each context owns exactly one manifest file:

```text
<WorkPath>/.rd-<ctx>/manifest.jsonl
```

The manifest is append-only JSON Lines (one JSON value per line). Each line
encodes one `ArtifactManifestRecord` (§8) — a managed row or a file-reference
row. Implementations MUST open the manifest with append semantics (e.g.
`O_APPEND` on POSIX) so that concurrent writers do not overwrite earlier rows.

## 8. Manifest record

A manifest line encodes one `ArtifactManifestRecord`. The record type is a
**union of two record classes** discriminated by the presence of a `kind`
field in the manifest:

- **Managed rows** — `rd://` artifacts produced and addressed by this URI
  scheme. A managed row has no `kind` field in the manifest.
- **File-reference rows** — references to a pre-existing local file declared
  by an `ARTIFACTS` directive. A file-reference row carries a persisted
  `kind: "file-artifact-record"` field.

One manifest line MUST encode exactly one record of either class. Readers MUST
classify a row by the presence of the manifest `kind` field before applying
the class-specific rules below. When a manifest row is loaded into the
runtime `ArtifactRecord` type, managed rows are tagged with
`kind: "artifact-record"` so the runtime union discriminates on `kind`; this
tag is added by the loader and is never written back to the manifest.

### 8.1 Managed rows

A managed manifest row has the following required field set, and MUST NOT carry
a `kind` field:

| Field | Type | Description |
|-------|------|-------------|
| `uri` | string | Canonical exact `rd://artifacts/...` artifact URI (§6.1, §11). |
| `runId` | string | Concrete run id; MUST match `RUN_ID_PATTERN`. |
| `contextId` | string | Owning context id; MUST satisfy `ctx_ref`. |
| `runbook` | object | `{ source, path }` runbook reference. |
| `key` | string | Artifact key; MUST satisfy `exact_artifact_key`. |
| `timestamp` | string | RFC 3339 / ISO 8601 datetime. |

All six fields are required. The managed row is intentionally limited to these
six fields; the `kind` discriminator (`artifact-record`) used by in-memory
`state.variables` values is added by the loader and is NOT persisted for
managed rows.

**Canonical write order.** Writers MUST emit the JSON object keys in the order
shown above (`uri`, `runId`, `contextId`, `runbook`, `key`, `timestamp`) so
manifest output is byte-stable across runs.

**Cross-field validation.** Readers MUST validate that the managed row's URI,
when parsed, has decoded `contextId`, `runId`, and `key` segments equal to the
record's corresponding structured fields, and MUST reject mismatched rows.

**Identity tuple.** The identity used for coalescing (§10) and de-duplication
of a managed row is the five-tuple:

```text
(contextId, runId, runbook.source, runbook.path, key)
```

Two managed rows share an identity when all five components are equal. `uri` is
omitted because it is deterministic given `(contextId, runId, key)` and adds no
discrimination.

### 8.2 File-reference rows

A file-reference manifest row references a pre-existing local file declared by
an `ARTIFACTS` directive (see [language.md §10](language.md#10-context-passing)).
It is a deliberately separate record class — a `file:` URI is not an `rd:`
URI, so the `rd:` URI invariants of §1 and §3–§7 do not govern these rows.

A file-reference row has the following required field set:

| Field | Type | Description |
|-------|------|-------------|
| `kind` | string | The literal `"file-artifact-record"`. Persisted on disk. |
| `uri` | string | Canonical `file:///...` URI (`pathToFileURL` form) for the referenced local file. |
| `runId` | string | Concrete run id of the run that made the declaration; MUST match `RUN_ID_PATTERN`. |
| `contextId` | string | Owning context id; MUST satisfy `ctx_ref`. |
| `runbook` | object | `{ source, path }` runbook reference. |
| `key` | string | Raw `ARTIFACTS` declaration token; a non-empty string. NOT an `exact_artifact_key`. |
| `timestamp` | string | RFC 3339 / ISO 8601 datetime. |

The differences from a managed row are normative:

- **`kind` is persisted.** Unlike a managed row, the `kind` field
  (`"file-artifact-record"`) is written to disk and is part of the on-disk
  record. Readers use it to classify the row.
- **`uri` is a `file:` URI.** It is a canonical `file:///...` URI, not an
  `rd://artifacts/...` URI. It does not satisfy the `rd:` URI grammar of §4
  and is not subject to the §7.1 `WorkPath` path-mapping rule.
- **`key` is a declaration token, not an artifact key.** It holds the raw
  token written in the `ARTIFACTS` declaration. It MAY contain slashes and
  other path-shaped characters; it MUST NOT be required to satisfy
  `exact_artifact_key`. It is not selector-addressable.
- **No URI/`key` cross-validation.** The §8.1 cross-field validation rule does
  NOT apply: a file-reference row's `file:` URI has no decoded `key` segment to
  compare against, and the row's `key` is a declaration token. Readers MUST NOT
  reject a file-reference row on URI/`key` mismatch grounds.

**Canonical write order.** Writers MUST emit `kind` first, followed by the
managed-row key order (`uri`, `runId`, `contextId`, `runbook`, `key`,
`timestamp`).

**Identity tuple.** The identity used for coalescing (§10) and de-duplication
of a file-reference row is the six-component tuple — the managed five-tuple
**plus `uri`**:

```text
(contextId, runId, runbook.source, runbook.path, key, uri)
```

Two file-reference rows share an identity when all six components are equal.
`uri` is part of the identity because the row's `key` is a raw declaration
token rather than a content-addressable identifier, so the canonical file
target is needed to distinguish rows.

## 9. Manifest scoping

The manifest is the artifact-visibility boundary.

A manifest at `<WorkPath>/.rd-<contextId>/manifest.jsonl` MUST contain only
rows whose `contextId` field equals the manifest's owning `<contextId>`.
Readers MUST reject any row whose `contextId` does not match the manifest's
owning context.

There is no cross-context flow. Artifacts written in one context are NOT
readable from another, even when both contexts share a `WorkPath`.
Same-context delegation (parent and child sharing a `ContextId`) sees a single
shared manifest.

## 10. Coalescing

When the manifest is read for resolution, repeated rows MUST be coalesced by
the identity tuple defined in §8. The identity tuple is kind-dependent:
managed rows (§8.1) use the five-tuple `(contextId, runId, runbook.source,
runbook.path, key)`; file-reference rows (§8.2) use the six-component tuple
that adds `uri`. Rows of different classes never share an identity.

**Selection rule:** the row with the newest `timestamp` wins.

**Tie-break rule:** when two rows share an identity AND share a timestamp, the
row appearing later in the manifest input order wins.

This rule is observable: appending a duplicate-identity row with an
equal-or-newer timestamp deterministically supersedes the earlier row on the
next coalesced read.

## 11. Round-trip and canonicalization

Implementations MUST satisfy the following round-trip and canonicalization
properties.

1. **Build/parse round-trip.** For any exact identity tuple
   `{ contextId, runId, key }` whose components satisfy §5,
   `parse(build(identity))` MUST return that same identity, and
   `build(parse(uri))` MUST return that same URI.
2. **No spurious percent-encoding.** Components whose decoded value matches
   the safe character class (`[A-Za-z0-9._-]+`) MUST be emitted without
   percent-encoding when produced by the canonical builder.
3. **Path-shape rejection.** URIs MUST be rejected when they:
   - contain a trailing slash,
   - contain consecutive slashes (`//`) inside the path,
   - present a number of path segments other than three after the namespace,
   - contain a fragment (`#...`),
   - use a scheme other than `rd:` or a hostname other than a registered
     namespace.
4. **Manifest URI consistency.** Managed manifest rows (§8.1) whose `uri`
   field, when parsed, yields different `contextId`, `runId`, or `key` values
   than the row's structured fields MUST be rejected. File-reference rows
   (§8.2) are exempt: their `uri` is a `file:` URI with no decoded `key`
   segment, and their `key` is a declaration token.

## 12. Verified against

This specification has been verified against the following implementation
sources. Each entry names the canonical symbols (functions, schemas, constants)
that back the cited sections; symbol names are used in preference to line
numbers, which drift as the files change.

- `packages/core/src/runbook/artifact-uri.ts` — URI builder, parser, and
  filesystem mapping. Sections §3, §4, §5, §6, §7.1, §11.
  Symbols: `buildArtifactUri`, `parseArtifactUri`, `parseExactArtifactUriParts`,
  `artifactUriToPath`, `assertConcreteRunId`.
- `packages/core/src/runbook/artifact-manifest.ts` — manifest read scoping,
  canonical write order, and coalescing. Sections §7.2, §8, §9, §10.
  Symbols: `manifestPathForContext`, `readArtifactManifest`,
  `appendArtifactManifestRecord`, `writeManifestLineSync`,
  `canonicalManifestRecord`, `coalesceManifestRecords`, `manifestRowIdentity`.
- `packages/core/src/runbook/artifact-schema.ts` — the two-class manifest
  record union and cross-field validation. Section §8.
  Symbols: `ArtifactManifestRecordSchema` (union of
  `ManagedArtifactManifestRecordSchema` and `FileArtifactRecordSchema`),
  `FileUriSchema`, `validateArtifactRecordIdentity`.
- `packages/core/src/runbook/artifact-directive-resolver.ts` — construction of
  file-reference rows. Section §8.2. Symbol: `resolveFileReferenceDeclaration`.
- `packages/core/src/runbook/run-id.ts` — `RUN_ID_PATTERN`. Sections §4, §5.2.
- `packages/core/src/paths.ts` — `SAFE_ID_PATTERN` and `assertSafeId`.
  Sections §5.1, §5.3.
