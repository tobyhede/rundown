---
'@rundown-org/core': patch
---

Fence the three already-terminal Run Release arms (claim confirm, claim
conflict, bare inline chain): the terminal determination and the presented
claim's authority are revalidated inside the session transaction that projects
the release, so a claim rotated between resolution and commit is refused as
`stale_claim` — or, on the bare chain, the cleanup is skipped with the
`already_terminal` outcome preserved — instead of being released under.
