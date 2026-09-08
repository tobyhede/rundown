---
'@rundown-org/core': minor
'@rundown-org/cli': minor
---

# Refuse a corrupt claim row as a typed class, and give it an error code

Issue #828 closed the unclassified-refusal hole for the `runs` table. The
`claims` table had the same hole in four shapes, and all four reached the
operator as RD-999 "Unknown error":

| Trigger                                              | Escaped as                                       |
| ---------------------------------------------------- | ------------------------------------------------ |
| `grants_json` is not valid JSON                      | bare `SyntaxError`                               |
| `grants_json` parses but fails its schema            | bare `ZodError`                                  |
| `delegation_json` is unparseable or fails its schema | bare `Error`                                     |
| mirrored columns disagree with the descriptor        | `InvalidPersistedClaimError`, classified nowhere |

The fourth is the surprising one: a purpose-built class existed for exactly this
and was referenced nowhere in `packages/cli/src`, so the one refusal that had a
class landed in the same place as the three that did not.

None of them was clearable. `complete` / `stop` / `prune` branch on refusal
class, so a corrupt claim row could not be cleared through the CLI at all.

## What changed

`deserializeClaim` now refuses every persisted edge of a row as
`InvalidPersistedClaimError`, including a malformed key, secret hash or
controlled run id, which the issue's table did not cover. The error carries an
`InvalidSessionStateDefect` naming the row and the check that refused it, so the
envelope reports the claim key in FIELDS rather than only in prose.

`RunbookStateManager.loadSession`'s bare `Error` becomes
`InvalidPersistedSessionError`. Its message already stated the recovery; only
the class was missing, and the envelope titled "Unknown error" contradicted the
instruction it was carrying.

Both classes are classified by `toRundownError` as the new **RD-310
`INVALID_PERSISTED_SESSION_STATE`**, and both are accepted by
`isRecoverableActiveStackError`, which is what authorizes `complete` / `stop` to
clear the entry.

RD-310 rather than RD-309 because the scope differs. RD-309 is one run row and
its recovery names that run; a claim refusal names a claim key and has no run id
to give, and RD-309's description names four causes — schema versions,
`templateVars`, the dynamic-step snapshot — that a claim row cannot have. Two
classes share the one code for the reason `InvalidRunbookStateError` and
`LegacySnapshotError` share RD-309: one recovery.

No migration and no fallback parse. The refusal stays a refusal.
