---
'@rundown-org/core': patch
---

# The exec-tracing differential no longer reports a run that did not happen as a pass

`tokenize-shell-exec-differential.integration.test.ts` asserts a security
property: no policy-ALLOWED command causes the real shell to execute an
unauthorized head. Its soundness rests entirely on the trace being ground truth,
and its observation path could not tell a shell that executed nothing apart from
a shell that never ran.

`runInSandbox` inspected `spawnSync`'s `result.error` only to detect a timeout
and discarded every other failure. The trace file is pre-created empty, so a
failed spawn read back as `''` and produced an empty head set. `runOracle` reads
an empty head set as "no unauthorized head ran" and returns `divergence: null` —
the invariant reported as HELD. The anti-vacuity guard does not catch it: it
counts policy decisions, which are pure in-process computation and unaffected by
a broken spawn.

`timedOut` was worse. It was computed correctly and read by no caller. Both
consumers destructured `{ heads }` only, so a truncated trace from a SIGKILLed
shell was treated as a complete observation.

**Measured, on macOS.** A cold spawn of `git status` under this harness cost
1435ms against the old 2000ms timeout, and the four-head self-check command hit
2002ms and was killed with a trace of `git, rm, curl` — the fourth head missing.
Warm spawns of the same command cost 16-18ms. The budget was being spent on
process start-up. This is the mechanism behind the intermittent self-check
failure seen under a full `pnpm run verify`, where worker fan-out makes every
spawn cold.

## What changed

- `runInSandbox` throws on any non-timeout spawn error, and on a result that
  neither exited nor was signalled. An infrastructure failure is no longer
  laundered into an observation.
- `runOracle` throws when a run times out without observing a divergence. A
  truncated trace stays authoritative for a bypass it DID see — a head that
  already exec'd is a real bypass — but silence in it is not evidence of
  soundness.
- `SHELL_TIMEOUT_MS` goes from 2000ms to 15000ms. It is a safety net against a
  wedged shell, not a performance budget, and it was acting as one. A guard that
  fires on healthy runs teaches people to ignore it.
- The self-check asserts `timedOut` first, so a timeout reports as itself rather
  than as a baffling `Set {}` versus four names.
- The sandbox and oracle move to `exec-trace-sandbox.ts` so the observation path
  can be unit-tested at all. That is why the defect survived: the code that had
  to be mocked to expose it lived inside the test file.

`exec-trace-sandbox.test.ts` carries the witnesses. Five of its seven cases fail
without the guards.
