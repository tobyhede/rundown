---
version: 1.0.0
---

# Rundown URIs (`rd:` scheme)

## 1. Scope

This document is the normative reference for the Rundown URI scheme `rd:`. It
specifies:

- the registered scheme name and registered namespaces,
- the URI grammar in W3C EBNF,
- the constraints on each URI component (`contextId`, `runId`, `key`, query
  parameters),
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

**Run-scoping invariant.** Every artifact is owned by exactly one run,
identified by the producer's `runId`. The grammar (§4) and storage layout
(§7) reflect this: a URI identifies a `(contextId, runId, key)` triple, and
an artifact MUST NOT be addressable under a context without a `runId`
segment. Same-context delegation makes artifacts produced by sibling runs
visible through the shared manifest (§9), but ownership stays with the
producer. There is no artifact namespace under a context that exists
outside a run.

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

URI fragments are invalid in any namespace and MUST be rejected.

## 4. Grammar (EBNF)

The following EBNF defines the formal grammar for `rd:` URIs. Notation follows
[docs/spec/grammar.md](grammar.md#notation).

```ebnf
rd_uri              ::= artifact_uri

artifact_uri        ::= exact_artifact_uri | selector_artifact_uri

exact_artifact_uri  ::= "rd://artifacts/" context_segment "/" run_segment "/" key_segment

selector_artifact_uri
                    ::= "rd://artifacts/" context_segment "/" run_selector "/" key_segment query_string?

context_segment     ::= pct_encoded_safe_id   /* decoded value MUST satisfy ctx_ref */
run_segment         ::= pct_encoded_run_id    /* decoded value MUST match RUN_ID_PATTERN */
run_selector        ::= run_segment | "*"
key_segment         ::= pct_encoded_artifact_key  /* decoded value MUST satisfy exact_artifact_key */

query_string        ::= "?" query_param ( "&" query_param )*
query_param         ::= ( "status" | "runbook" | "source" | "latest" ) "=" query_value
query_value         ::= [^&#]*

pct_encoded_safe_id ::= (* RFC 3986 percent-encoded segment whose decoded value matches [A-Za-z0-9._-]+ *)
pct_encoded_run_id  ::= (* RFC 3986 percent-encoded segment whose decoded value matches RUN_ID_PATTERN *)
pct_encoded_artifact_key
                    ::= (* RFC 3986 percent-encoded segment whose decoded value matches exact_artifact_key *)
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

The `key` is the final path segment. Its decoded value MUST satisfy
`exact_artifact_key` (`[A-Za-z0-9._-]+`, with `.` and `..` rejected, slashes
rejected, traversal rejected, recursive `**` rejected, and empty rejected).

**Length:** No normative length cap is currently enforced. Implementations MAY
enforce a reasonable filesystem-compatible cap on key length (for example 255
bytes, matching POSIX `NAME_MAX`). This is flagged for possible future
tightening; until that decision is made, implementations SHOULD NOT reject
keys solely on length grounds below an obvious filesystem limit.

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

## 6. Forms

A URI is either exact or selector. The discriminator is structural: an
implementation MUST classify a URI as a selector when its `runId` segment is
`*` OR when it carries a non-empty query string. Otherwise the URI is exact.

### 6.1 Exact form

```text
rd://artifacts/<contextId>/<runId>/<key>
```

All components are concrete: no wildcards, no query string, all values fully
specified. An exact URI addresses exactly one artifact file (§7.1) and
references exactly one identity tuple (§8) in the owning manifest.

### 6.2 Selector form

```text
rd://artifacts/<contextId>/(<runId>|*)/<key>[?<query>]
```

A selector URI is the read-only query form. It is produced by `ARTIFACTS`
declarations that name an explicit selector URI (see
[language.md §10.1.1](./language.md#1011-expansion-rules)) and consumed by
manifest selector resolution. A selector URI resolves to zero or more
`ArtifactRecord` values and never writes a manifest row.

Selectors have no opinion on arity: the resolved value is an `ArtifactRecord`
when the manifest yields exactly one matching row, an `ArtifactRecord[]` when
it yields many, or an empty array when none. The runbook's structure
determines the expected number of records. Empty selector results are
meaningful and MUST NOT be collapsed to absence.

The exact form (§6.1), by contrast, is the producer surface: the bare-key
`ARTIFACTS` shortcut expands to an exact URI for the current context and
current run, and the resolver appends a manifest row for that identity at
directive evaluation. The artifact file itself is written by the agent, not
the resolver.

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
encodes one `ArtifactRecord` (§8). Implementations MUST open the manifest with
append semantics (e.g. `O_APPEND` on POSIX) so that concurrent writers do not
overwrite earlier rows.

## 8. Manifest record

The single structured artifact value is the `ArtifactRecord`. One manifest
line MUST encode exactly one `ArtifactRecord`.

The required field set is:

| Field | Type | Description |
|-------|------|-------------|
| `uri` | string | Canonical exact artifact URI (§6.1, §11). |
| `runId` | string | Concrete run id; MUST match `RUN_ID_PATTERN`. |
| `contextId` | string | Owning context id; MUST satisfy `ctx_ref`. |
| `runbook` | object | `{ source, path }` runbook reference. |
| `key` | string | Artifact key; MUST satisfy `exact_artifact_key`. |
| `timestamp` | string | RFC 3339 / ISO 8601 datetime. |

All fields are required.

**Canonical write order.** Manifest writers MUST emit the JSON object keys in
the order shown above (`uri`, `runId`, `contextId`, `runbook`, `key`,
`timestamp`) so manifest output is byte-stable across runs.

**Cross-field validation.** Manifest readers MUST validate that the URI's
decoded `contextId`, `runId`, and `key` segments equal the record's
corresponding structured fields, and MUST reject mismatched rows.

**Identity tuple.** The identity used for coalescing (§10) and de-duplication
is:

```text
(contextId, runId, runbook.source, runbook.path, key)
```

Two records share an identity when all five components are equal.

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
the identity tuple defined in §8.

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
4. **Manifest URI consistency.** Manifest rows whose `uri` field, when parsed,
   yields different `contextId`, `runId`, or `key` values than the row's
   structured fields MUST be rejected.

## 12. Future namespaces

This section is non-normative.

The following namespaces are reserved for possible future use. Their grammar
and semantics are undefined; implementations MUST reject URIs that use them
until they are registered in §3.1.

- `rd://contexts/...` — context-scoped resources.
- `rd://runs/...` — run-scoped resources outside the artifact namespace.

The current `rd://artifacts/...` form leaves room for these and other
namespace prefixes without grammar collisions.

## 13. Verified against

This specification has been verified against the following implementation
sources. The line ranges identify the canonical algorithms and constants that
back each section.

- `packages/core/src/runbook/artifact-uri.ts` — URI builder, parser, and
  filesystem mapping. Sections §3, §4, §5, §6, §7.1, §11.
  <!-- verified against artifact-uri.ts:10,68-109,121-178,225-243,253-304 -->
- `packages/core/src/runbook/artifact-manifest.ts` — manifest read scoping,
  canonical write order, and coalescing.
  Sections §7.2, §8, §9, §10.
  <!-- verified against artifact-manifest.ts:53-60,160-168,178-213,344-354,500-509 -->
- `packages/core/src/runbook/artifact-schema.ts` — `ArtifactRecord` field set
  and cross-field validation. Section §8.
  <!-- verified against artifact-schema.ts:56-115 -->
- `packages/core/src/runbook/run-id.ts` — `RUN_ID_PATTERN`. Section §4, §5.2.
- `packages/core/src/paths.ts` — `SAFE_ID_PATTERN` and `assertSafeId`.
  Sections §5.1, §5.3.
  <!-- verified against paths.ts:18,33-40 -->
