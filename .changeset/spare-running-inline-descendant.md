---
'@rundown-org/core': patch
---

# An already-terminal chain cleanup no longer strands a still-running inline descendant

`rundown complete` / `rundown stop` report `already_terminal` when the resolved
inline-cascade root was already terminal on entry, and the fenced chain release
is then the only effect the command owes. That release named **every** member of
the resolved chain, marking each non-root member `collateral` — which revokes:
`projectOne` deletes every claim controlling the run and filters it off
`defaultStack`.

On the forcing path that is exactly right. The aggregate's `compute` prepares a
terminal mutation for every captured member whose lifecycle is `running`, in the
same transaction that commits the releases, so by commit every member is
terminal and `collateral` — "swept up so that an addressed run could close" — is
true of all of them.

The already-terminal arms force nothing. The root reached terminal on an earlier
turn, so each descendant's lifecycle is whatever it already was, and a
descendant that is still `running` was never forced terminal under this root by
this command or any other. Naming it `collateral` asserted otherwise and revoked
its run-control claim, dropping a live run off the default stack while its
holder was mid-execution. This is the case ADR 0001 names — "a refusal can
release a still-running run even though it committed no terminal transition" —
against its own rule that such a path "leaves the running run targeted" and can
never "remove retry authority".

Reproduced by `rundown stop --claim-id <root's claim>`, which forces only the
root (the plan walks _up_ the inline chain, so a descendant below the anchor is
never in `forceOrder`), followed by any later ambient `rundown stop`: that
resolves the still-running descendant, walks up to the now-terminal root, takes
the already-terminal arm, and revokes the descendant it never touched — while
reporting success at exit 0.

The two already-terminal call sites now build their batch from a separate
`releasesForAlreadyTerminalInlineChain`, which keeps the root and only those
descendants that are already `completed` or `stopped`. A still-running
descendant is omitted from the batch entirely rather than demoted to a gentler
role: `addressed` would be a second untruth — the caller did not act on it — and
there is no role meaning "untouched", because a release _is_ the act of
finishing with a run. The forcing path keeps the original behaviour under the
name `releasesForForcedInlineChain`.

Two named functions rather than one with a flag, because what differs is a fact
about what the command did to each member — the same reason `ReleaseRole` is a
fact the caller states and not a policy it chooses. A boolean parameter can be
omitted, and omission would default to the revoking direction.

No outcome shape changes. `releaseAlreadyTerminal` reports `released` /
`claim_rotated` / `determination_lost` and never enumerates the batch, and
`projectRunReleases` returns nothing, so no caller could observe which members
were named. The only difference is the session that results — which is the fix.
