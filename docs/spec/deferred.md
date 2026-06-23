# Rundown — Deferred / Speculative Spec Content

> **Agent attention warning:** This document describes features that are NOT
> implemented in the current codebase. Agents MUST NOT use this document when
> implementing features, planning batches, writing tests, or answering questions
> about how the system works today. Refer to `docs/spec/language.md`,
> `docs/spec/uri.md`, `docs/spec/grammar.md`, and `docs/spec/cli-output.md` for
> the canonical current specification. Use this document ONLY when the user
> explicitly references "deferred", "speculative", "future", or "this
> deferred-spec doc" in their request.

This document collects spec language that describes
intended-but-not-yet-implemented behaviour. Each section names which canonical
spec section the content was previously embedded in, and what gates re-promotion
(typically: a future implementation batch landing the feature).

---

## Future URI namespaces

**Original location:** `docs/spec/uri.md §12`. **Re-promotion gate:** Each
namespace requires its own grammar definition and an implementation batch.

This section is non-normative.

The following namespaces are reserved for possible future use. Their grammar and
semantics are undefined; implementations reject URIs that use them — per the
normative grammar in `uri.md §4` — until they are registered in `uri.md §3.1`.

- `rd://contexts/...` — context-scoped resources.
- `rd://runs/...` — run-scoped resources outside the artifact namespace.

The current `rd://artifacts/...` form leaves room for these and other namespace
prefixes without grammar collisions.
