---
'@rundown-org/core': patch
'@rundown-org/cli': patch
---

Keep running runs targeted when execution refuses without applying a terminal
transition, and hand inline-parent refusals back as typed data instead of
reporting a false stop upward.
