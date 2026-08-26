# ADR 0002: Fence inline launch under the parent's claim generation

- **Status:** Accepted
- **Date:** 2026-08-26

## Scope

This decision governs the inline-launch mutation: `rundown run --step` (and
auto-launched inline substeps) attaching a child run to a pre-existing composing
parent by writing that parent's `substepStates`. It does not govern the
flow-back advance after a child terminates, which is machine-owned progression
(ADR 0001) and is audited under the progression extraction, not here.

## Context

Post-R1, every mutation of a delegation-exposed run names its authority; bare
mutations refuse `ACTOR_CONTEXT_REQUIRED`. The inline-launch write was the one
exemption: it resolved the parent from the active session and wrote its
`substepStates` under a version-only compare-and-swap, with no claim term. The
exemption was implicit, which is how it survived a design issue that ostensibly
covered it (#574 criterion 6 passed literally while the property a reader would
infer did not hold). Issue #714 requires the decision to be explicit: documented
trust boundary, or authorized path.

## Decision

The mutation is fenced under the parent's own run-control claim generation —
authorized minimally, with the trust boundary that remains documented
explicitly.

- At linkage determination, the launch captures the parent's active controlling
  claim (`captureRunAuthority`); a parent with no active controlling claim
  refuses the launch.
- The `substepStates` write commits only under that captured claim generation
  and state version. A parent claim rotated between determination and commit is
  a permanent refusal: the parent now belongs to a different orchestrator, and
  attaching under the new authority silently is exactly what the fence exists to
  prevent. A concurrent state write without a claim rotation re-derives and
  retries inside the store's bounded budget, as every derive-inside-CAS write
  does.
- No new CLI surface. The caller does not present a claim; the fence derives the
  parent's controlling claim from the session. A single-orchestrator flow never
  observes a refusal.

## What this records, and what it does not

The fence records **which** authority was current when the launch attached — the
claim generation the commit was validated against — and refuses stale
determinations. It does **not** prove the caller **held** that authority. A
same-cwd sibling that launches first still attaches, under the then-current
generation. That residual is the documented trust boundary: within one working
directory, same-user processes are trusted to cooperate, and the SQLite file
itself — not the claim system — is the actual access boundary.
`docs/reference/security.md` states this. Requiring possession (a `--claim-id`
on `rundown run` routed through the bearer gate) was rejected for now: inline
composition is the zero-ceremony axis, and the accident class worth closing is
stale-authority attachment, not hostile local processes the file system already
admits.

## Consequences

- The inline-launch write moves behind a core seam that owns capture,
  derivation, and the claim-fenced commit; the CLI maps its typed refusals to
  output codes and stays thin.
- A rotated parent claim surfaces as a permanent refusal with its own code,
  never a retryable envelope.
- The write-scope invariant — the launch touches only the linkage-named substep
  row of the named parent — is pinned by test, so the exemption this replaces
  cannot silently widen.
