---
'@rundown-org/core': minor
'@rundown-org/cli': minor
---

# Register the error codes `claim`, `run` and `resolve` already emitted

`ErrorResponseSchema` validates a CLI error envelope's `code` against
`RundownErrorCodeValues` plus `CLISymbolicErrorCodeValues`. Six codes that
commands actually emit were in neither list, so those envelopes failed the
schema they document.

- `DELEGATION_ALREADY_CLAIMED` — `rundown claim` renders this symbolic string,
  while only the RD-811 _value_ was registered. Its sibling
  `DELEGATION_ALREADY_RESOLVED` was registered; this one was not.
- `PARSE_ERROR`, `RUNBOOK_REF_RESOLUTION_ERROR`, `VARIABLE_RESOLUTION_ERROR`,
  `POLICY_DENIED`, `MISSING_REQUIRED_VARS` — every remaining arm of
  `PrepareFailure['code']`, forwarded verbatim into the envelope.

Issue #834 asked whether `claim` was the only affected command. It is not:
`run.ts` emits `prepResult.code` directly from the same union, and `resolve`
uses the same pipeline. One registry change covers all three.

`ClaimFailureEnvelope.code` narrows from `string` to `CLIErrorCode`, which is
what #832 recorded as the real fix and deliberately deferred, because
registering a code is a public-surface decision. The compiler now holds the link
between an emit site and the registry: a code added to an arm without being
registered is a build failure rather than a runtime envelope that fails its own
schema.

That link is the point. The defect went unseen because `claim.test.ts` validates
only the arms it exercises, and neither affected arm was one — nothing connected
the emit sites to the registry except a test that happened to look.
