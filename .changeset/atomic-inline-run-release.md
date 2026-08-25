---
'@rundown-org/cli': patch
---

Fold inline-composed parent Run Release into the transaction that commits each
parent terminal, so process death cannot leave a terminal run targeted and
nested inline flow-back cannot repeat the upward walk.
