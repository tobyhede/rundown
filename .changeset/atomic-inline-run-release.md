---
'@rundown-org/cli': patch
'@rundown-org/core': patch
---

Fold inline-composed parent Run Release into the transaction that commits each
parent terminal, so process death cannot leave a terminal run targeted and
re-entrant inline flow-back cannot repeat the upward walk.
