---
'@rundown-org/cli': patch
---

Order the inline-launch authority fence after target validation so a bad
`--step` reports the step, not the claim. The parent-authority capture added
with `INLINE_PARENT_CLAIM_SUPERSEDED` (RD-834) sat ahead of every target check
in `buildInlineLinkage`, so when a parent was session-active but controlled by
no live run-control claim the fence answered first and masked ten distinct
refusal codes: `DELEGATION_STEP_NOT_FOUND` (RD-801),
`DELEGATION_SUBSTEP_REQUIRED` (RD-803), `DELEGATION_STEP_NO_SUBSTEPS` (RD-815),
`DELEGATION_SUBSTEP_NOT_FOUND` (RD-806), `DELEGATION_STEP_NOT_CURRENT` (RD-802),
`INVALID_SYNTAX` / `CONFLICTING_INDEX`, `INVALID_INDEX`,
`DELEGATION_ALREADY_RESOLVED` (RD-812) and `DELEGATION_ALREADY_EXISTS` (RD-804).
Ten codes, not ten checks: RD-801 answers at two validation steps (an
unparseable `--step` and a step name no runbook step matches) but is one code,
and `INVALID_SYNTAX` / `CONFLICTING_INDEX` are two codes out of the single
`--index` resolution. A caller who mistyped a step id was told their parent's
claim had been superseded, sending them to diagnose the wrong system.

The capture now runs last among the refusals, immediately before linkage
construction. Every check it moved behind decides a property of the _target_ and
reads only the parent state already loaded by `getActive()`, so none of them
needed the capture; nothing between the new position and the fenced commit
awaits, so the window the fence guards is unchanged and a valid target still
refuses exactly as before. All the codes involved are permanent refusals, so no
refusal changed retryability — only which of two permanent refusals is reported
wins, and it is now the more actionable one.
