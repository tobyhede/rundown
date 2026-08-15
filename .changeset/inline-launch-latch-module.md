---
'@rundown-org/core': minor
'@rundown-org/cli': minor
---

# Give the inline-launch latch its own interface

The latch that makes an inline child launch exactly-once was a private function
inside a 2,100-line CLI service. That is not a style complaint: the module had
no seam of its own, so its test surface fell back to the package boundary
beneath it, and the only test claiming to exercise contention mocked
`@rundown-org/core` wholesale and drove a second observer by re-entry from
inside the first's launch span. A sequential implementation passed it. The
exactly-once property — the one thing stopping two observers racing a bare
`INSERT INTO runs` for the intent's fixed child run id — had never been tested
against a real store.

`latchInlineLaunch` now lives in `services/inline-launch-latch.ts` with the
linkage classification, the ownership read and the compare-and-swap cycle behind
it: the intent and its two seams in, one outcome union out. Contention is driven
through that interface — two state managers over one real SQLite store, each
held inside its build callback until both have read, so the commit that lands
second is genuinely stale. Exactly one observer wins, the loser stands down
naming the live owner, and one child run is created.

Three changes to the interface itself, none of them behavioural:

- The outcome is one union. `Promise<InlineLaunchLatch | null>` gained a
  `missing` arm, so "may this launch proceed, and if not, why not" is answered
  in one value a caller can narrow exhaustively rather than partly through a
  nullable second channel. The caller still routes `missing` and `inactive` to
  the same refusal, deliberately — a run that vanished mid-launch is no more
  launchable than one that ended.
- The only argument is the intent. The parent run, the child run id and the
  linkage are all projections of it, so accepting them alongside made "an intent
  and a child id that disagree" representable. Both call sites derive through
  one exported `inlineLinkageFromIntent`.
- The persisted-intent shape check is core's, not a CLI copy.
  `isInlineLaunchIntentWithoutParentEntry` is now re-exported from
  `@rundown-org/core`; core drives it from a field-guard map keyed by
  `keyof InlineLaunchIntentWithoutParentEntry`, so the runtime check breaks
  compilation when the intent grows a field — a property the hand-rolled `&&`
  chain in the CLI would have lost the first time that happened.

Also closes a second gap of the same kind at the run-start `afterInit` cycle.
Its contention test injected the interleaved write before the compare-and-swap
opened, so no losing attempt was ever created; the added variant lands the write
inside the cycle and pins that the derivation re-runs against the committed row
and the unrelated substep survives.
