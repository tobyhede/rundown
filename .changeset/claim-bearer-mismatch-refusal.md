---
'@rundown-org/core': minor
'@rundown-org/cli': minor
---

Refuse a caller/target claim-bearer divergence instead of authorizing as the
target (#613).

`RunbookLifecycleCommandService.runTransition`, `runTerminal`, and
`resolveRunNavigation` took caller evidence and a target selector as independent
inputs, derived authority from the **target's** verified claim, and silently
ignored a mismatch. A claim id carries its own live secret segment, so naming
one is an act of presentation rather than mere selection: the two fields are one
fact. Each seam now reconciles them at entry, before resolving anything from the
claim, and refuses with the new `CLAIM_BEARER_MISMATCH` code.

**Behaviour change for programmatic consumers.** No `rundown` CLI path can
produce this refusal — `--claim-id` populates both the evidence and the target
at all three call sites, so they cannot disagree. A consumer driving the
exported core seam directly, and populating the two fields independently, will
now receive a `claim_bearer_mismatch` refusal where it previously succeeded.
That path was always authorizing on authority the caller had not demonstrated it
held, so the refusal is the fix rather than a regression — but it is observable,
hence the minor bump rather than a patch.

`CLAIM_BEARER_MISMATCH` is registered in `CLISymbolicErrorCodeValues` and
`CLIErrorCodes`, so error envelopes carrying it validate against the published
`--schema` output. It is deliberately distinct from `ACTOR_CONTEXT_REQUIRED`,
whose remediation ("pass `--claim-id`") would misdiagnose a caller that already
presented one.
