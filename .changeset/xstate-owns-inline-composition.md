---
'@rundown-org/cli': patch
'@rundown-org/core': patch
---

Move inline child launch and upward completion flow-back behind the core Run
Progression activation. Fresh children and composing parents now re-enter the
same XState-owned progression seam, with exact linkage validation and run-scoped
delegation authority at every ancestor.
