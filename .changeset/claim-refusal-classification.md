---
'@rundown-org/core': minor
'@rundown-org/cli': minor
---

# Permanent refusals reach the operator as themselves, not as TOKEN_NOT_FOUND or RD-999

Two refusals that were fully diagnosed inside the codebase arrived at the caller
wearing a code that named something else.

## `rundown claim` collapsed four permanent refusals onto `TOKEN_NOT_FOUND`

`claim` distinguishes `token-not-found`, `parent-missing`, `parent-ended`, and
`delegation-removed` correctly and then rendered all four as `TOKEN_NOT_FOUND`.
Three of them are not about the token — it was found, and it was valid — so the
holder was sent to check the one thing that was not wrong. Two are caused by a
concurrent actor, the category that must be passed through as itself.

Worse, two of them disagreed with core about the same fact. `claim` re-reads the
parent before preparing the child, so an ended parent (or a delegation that has
left the parent's step) is seen by that pre-read as often as by the claim
transaction — and core's in-transaction `classifyDelegationLiveness` reports
both as `DELEGATION_SUPERSEDED`. Which code a claimer received depended on where
in that window the call landed.

Core is now the single classification owner for all three:

- `parent-ended` and `delegation-removed` report `DELEGATION_SUPERSEDED`, the
  code core already reports for `parent-ended` / `cursor-advanced` /
  `token-reissued`, and the code `docs/reference/cli.md` already documented for
  a parent that has "ended". The envelope names the specific fact first
  (`lifecycle`, `stepId` in `details`) and then carries RD-825's own no-retry
  instruction verbatim from the registry.
- `parent-missing` reports the new `PARENT_RUN_MISSING` — the sibling of
  `CHILD_RUN_MISSING` at the other end of the same linkage, matching the
  `parent-unreadable` corruption signal core's classifier produces. Its recovery
  is `rundown prune` and a restart from source, not a report to the
  orchestrator.

`TOKEN_NOT_FOUND` now belongs to the one reason that is about the token.

## A diagnosed cursor mismatch arrived as RD-999 "Unknown error"

Core refuses a persisted completion that is not for the active cursor with a
typed `target_mismatch` carrying its own message. Both consumers re-threw it as
a bare `Error`: the inline parent-advance callable and the execution loop. The
throw unwound past the frontend's renderer and past `output.flush()`, so the
buffered parent stream was discarded, the reason was dropped at the throw, and
the operator was told "Unknown error" — an envelope that says nothing was
diagnosed, for a permanent condition whose only implied remedy is a retry that
cannot work.

The refusal now travels as data, the shape the neighbouring linkage-cycle trip
already uses:

- `AdvanceInlineParentOutcome` gains a `refused` arm carrying an
  `InlineParentAdvanceRefusal`, and `InlineUpwardPropagationResult` /
  `TerminalUpwardPropagationResult` gain `advance-refused`. The seam performs no
  release and no recursion on it, because nothing was applied.
- The CLI adapters and `rundown collect` render it through
  `emitAdvanceRefusalDiagnostic` before their flush, then collapse it onto the
  pre-existing fail-closed `blocked`.
- The execution loop emits a coded `ERROR_OCCURRED` plus a positioned
  `RUNBOOK_STOPPED` and takes its terminal release, matching the three frontier
  refusals beside it — so the refused run no longer strands on the session
  stack.

Both report the new `COMPLETION_TARGET_MISMATCH`, exported from core as
`COMPLETION_TARGET_MISMATCH_CODE`. It names the condition rather than the
command, so the two paths cannot describe the same fact differently.
`rundown collect` keeps `COLLECT_OPERATION_FAILED`: that surface reports the
collection that failed, not the cursor fact underneath it.
