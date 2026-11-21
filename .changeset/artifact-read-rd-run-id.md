---
'@rundown-org/cli': patch
---

`rundown artifact ls|inspect|path|uri` now fall back to `RD_RUN_ID` when `--run`
is absent, as `rundown echo` already does. Core injects `RD_RUN_ID` into every
step command, but the artifact commands ignored it and used only the
single-running-run rule, so a step that ran `rundown artifact ls` was refused
`INVALID_SYNTAX` and stopped its runbook whenever any other run was in progress.
Precedence is `--run`, then `RD_RUN_ID`, then the single running run. The
environment value is validated like `--run`: malformed is `INVALID_RUN_ID`,
unknown is `RUN_TARGET_UNAVAILABLE`, and neither falls through to the
single-running-run rule. It is a read-only selector, not mutation authority.
