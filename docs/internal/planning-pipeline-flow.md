# Planning Pipeline Flow

The `planning` runbook is a three-stage pipeline — **write the plan**, **review
the plan**, **execute the plan** — composed from smaller runbooks under
`packages/claude-code-plugin/runbooks/planning/` (with the four reviewer
runbooks and the collator under the `planning/review/` subdirectory). The
discipline is consistent: the top-level orchestrator
(`planning/planning.runbook.md`) and `execute-plan` push real work to
**delegated children** (a `- DELEGATE` step hands a child runbook to a separate
agent/context, whose terminal lifecycle maps back to the parent's result — child
`COMPLETE` → parent `pass`, child `STOP` → parent `fail`), while orchestration
runbooks that simply sequence other runbooks **compose** them (a substep list
with no `- DELEGATE` marker runs inline in the same context). A delegated step
that lists a single child is a _leaf delegate_; a fan-out step lists several
children and aggregates them with `PASS ALL` / `FAIL ANY`.

The gates worth tracking are all in `execute-plan`: the **code-review verdict
loop** (code review fails → address findings → re-review) and the **verify
loop** (verify fails → address findings → re-review → re-verify). The
code-review child owns its own verdict via a final prompted gate step; there is
no separate `jq` gate in `execute-plan`.

## Legend

```mermaid
flowchart LR
  D["DELEGATE child<br/>(separate context)"]:::delegate
  C["composed stage<br/>(inline)"]:::compose
  G["command / prompt gate"]:::gate
  T(["terminal: COMPLETE / STOP"]):::terminal
  A["step n"] -. "GOTO back-edge" .-> B["step m"]

  classDef delegate fill:#dbeafe,stroke:#2563eb,color:#1e3a8a;
  classDef compose fill:#dcfce7,stroke:#16a34a,color:#14532d;
  classDef gate fill:#fef9c3,stroke:#ca8a04,color:#713f12;
  classDef terminal fill:#f3e8ff,stroke:#9333ea,color:#581c87;
```

- **DELEGATE child** (blue): step hands a child runbook to a separate
  agent/context; the child's terminal status maps back to the parent —
  `COMPLETE` → parent `pass`, `STOP` → parent `fail`.
- **composed stage** (green): substep list runs inline in the current context.
- **command / prompt gate** (yellow): a step whose result comes from a shell
  command or a prompted human/agent verdict.
- **GOTO back-edge** (dotted): a `GOTO <n>` jump, usually looping backward.
- **terminal** (purple, stadium): `COMPLETE` (success) or `STOP` (failure) ends
  the runbook.

## 1. Top-level: `planning` (write → review → execute)

`planning/planning.runbook.md`. Step 1 is a leaf DELEGATE; steps 2 and 3 compose
their stage runbooks inline. Every step stops the pipeline on failure
(`FAIL ANY STOP`); the final stage completes it (`PASS ALL COMPLETE`).

```mermaid
flowchart TD
  start([planning]) --> s1

  s1["1. Write the plan<br/>(DELEGATE write-plan)"]:::delegate
  s2["2. Review the plan<br/>(composes review-plan)"]:::compose
  s3["3. Execute the plan<br/>(composes execute-plan)"]:::compose

  s1 -- "PASS ALL→CONTINUE" --> s2
  s1 -- "FAIL ANY→STOP" --> stop1(["STOP"]):::terminal

  s2 -- "PASS ALL→CONTINUE" --> s3
  s2 -- "FAIL ANY→STOP" --> stop2(["STOP"]):::terminal

  s3 -- "PASS ALL→COMPLETE" --> done(["COMPLETE"]):::terminal
  s3 -- "FAIL ANY→STOP" --> stop3(["STOP"]):::terminal

  classDef delegate fill:#dbeafe,stroke:#2563eb,color:#1e3a8a;
  classDef compose fill:#dcfce7,stroke:#16a34a,color:#14532d;
  classDef terminal fill:#f3e8ff,stroke:#9333ea,color:#581c87;
```

## 2. Review stage: `review-plan` (fan-out + collate)

`planning/review-plan.runbook.md`. Steps 1–2 are inline find/context checks.
Step 3 is a DELEGATE **fan-out** to four reviewer runbooks, aggregated
`PASS ALL CONTINUE` / `FAIL ANY STOP`. Step 4 is a leaf DELEGATE to the
collator, which completes the stage.

```mermaid
flowchart TD
  start([review-plan]) --> r1

  r1["1. Find plan<br/>(read PlanPath)"]:::gate
  r2["2. Context and scope"]:::gate
  r1 -- "PASS→CONTINUE" --> r2
  r1 -- "FAIL→STOP" --> stopA(["STOP"]):::terminal
  r2 -- "PASS→CONTINUE" --> r3
  r2 -- "FAIL→STOP" --> stopB(["STOP"]):::terminal

  r3["3. Delegate subagents to review<br/>(DELEGATE × 4, fan-out)"]:::delegate

  r3 --> ra["review-plan-technical-accuracy"]:::delegate
  r3 --> rb["review-plan-structural-integrity"]:::delegate
  r3 --> rc["review-plan-build-runtime"]:::delegate
  r3 --> rd["review-plan-risk-safety"]:::delegate

  r3 -- "FAIL ANY→STOP" --> stopC(["STOP"]):::terminal
  r3 -- "PASS ALL→CONTINUE" --> r4

  r4["4. Collate review findings<br/>(DELEGATE review-plan-collate)"]:::delegate
  r4 -- "PASS ALL→COMPLETE" --> doneR(["COMPLETE"]):::terminal
  r4 -- "FAIL ANY→STOP" --> stopD(["STOP"]):::terminal

  classDef delegate fill:#dbeafe,stroke:#2563eb,color:#1e3a8a;
  classDef gate fill:#fef9c3,stroke:#ca8a04,color:#713f12;
  classDef terminal fill:#f3e8ff,stroke:#9333ea,color:#581c87;
```

Each reviewer runbook writes a `*-review-plan-*-*.json` file and self-completes;
the four findings flagged in their step 3 use `FAIL CONTINUE` so a finding
records into the JSON rather than failing the reviewer — a reviewer only `STOP`s
on operational failure (e.g. missing schema). `review-plan-collate` merges and
deduplicates those files into `ReviewPlanPath`.

## 3. Execute stage: `execute-plan` (review loop + verify loop)

`planning/execute-plan.runbook.md`. Step 1 reads the skill inline. Steps 2–4 are
DELEGATE children; step 5 is a shell-command gate. Two loops:

- **Code-review verdict loop:** step 3 delegates `code-review`. Its child's
  terminal status _is_ the verdict (its step 7 prompted gate: clean →
  `COMPLETE`, blocking findings → `STOP`). Child `COMPLETE` → step 3 `pass` →
  `GOTO 5` (skip straight to verify). Child `STOP` → step 3 `fail` → `CONTINUE`
  to step 4 (address). Step 4 (`address-review`) on success loops `GOTO 3` to
  re-review.
- **Verify loop:** step 5 runs `npm run verify`. Pass → `COMPLETE`. Fail →
  `GOTO 4` to address the verify failure, which re-reviews (`GOTO 3`) and
  re-verifies.

```mermaid
flowchart TD
  start([execute-plan]) --> e1

  e1["1. Invoke executing-plans skill"]:::gate
  e1 -- "PASS→CONTINUE" --> e2
  e1 -- "FAIL→STOP" --> stopE1(["STOP"]):::terminal

  e2["2. Implement the plan<br/>(DELEGATE implement-plan)"]:::delegate
  e2 -- "PASS ALL→CONTINUE" --> e3
  e2 -- "FAIL ANY→STOP" --> stopE2(["STOP"]):::terminal

  e3["3. Code review<br/>(DELEGATE code-review)"]:::delegate
  e4["4. Address review findings<br/>(DELEGATE address-review)"]:::delegate
  e5["5. Verify<br/>(npm run verify)"]:::gate

  e3 -- "PASS ALL→GOTO 5<br/>(review clean)" --> e5
  e3 -- "FAIL ANY→CONTINUE<br/>(blocking findings)" --> e4

  e4 -- "PASS ALL→GOTO 3<br/>(re-review)" -.-> e3
  e4 -- "FAIL ANY→STOP" --> stopE4(["STOP"]):::terminal

  e5 -- "PASS→COMPLETE" --> doneE(["COMPLETE"]):::terminal
  e5 -- "FAIL→GOTO 4<br/>(fix & re-verify)" -.-> e4

  classDef delegate fill:#dbeafe,stroke:#2563eb,color:#1e3a8a;
  classDef gate fill:#fef9c3,stroke:#ca8a04,color:#713f12;
  classDef terminal fill:#f3e8ff,stroke:#9333ea,color:#581c87;
```

### How `code-review`'s verdict drives execute-plan step 3

`planning/code-review.runbook.md` records findings then renders the verdict in
its **final prompted gate** (step 7), which is what the parent reads:

```mermaid
flowchart TD
  start([code-review]) --> c1
  c1["1. Read review schema"]:::gate --> c2["2. Read the plan"]:::gate
  c2 --> c3["3. Review changes<br/>(FAIL CONTINUE — record, don't gate)"]:::gate
  c3 --> c4["4. Output path"]:::gate
  c4 --> c5["5. Write the review (JSON)"]:::gate
  c5 --> c6["6. Check schema<br/>(FAIL→GOTO 5)"]:::gate
  c6 -. "FAIL→GOTO 5" .-> c5
  c6 --> c7["7. Gate the review (PROMPTED verdict)"]:::gate

  c7 -- "PASS→COMPLETE<br/>(clean → parent step 3 pass → GOTO 5)" --> doneC(["COMPLETE"]):::terminal
  c7 -- "FAIL→STOP<br/>(blocking → parent step 3 fail → CONTINUE)" --> stopC(["STOP"]):::terminal

  classDef gate fill:#fef9c3,stroke:#ca8a04,color:#713f12;
  classDef terminal fill:#f3e8ff,stroke:#9333ea,color:#581c87;
```

`implement-plan` (step 2 child) and `address-review` (step 4 child) are both
straightforward executing-plans children: read the plan (and, for
`address-review`, the recorded findings), do the work committing per task, then
`COMPLETE` on success or `STOP` when blocked.
