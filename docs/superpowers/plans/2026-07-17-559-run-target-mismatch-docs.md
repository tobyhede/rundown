# RUN_TARGET_MISMATCH Documentation and Test-Assertion Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close issue 559 by documenting the already-registered `RUN_TARGET_MISMATCH` error envelope, deleting the stale HTML comment that falsely claims it is unregistered, and repairing the vacuous accident-barrier assertion in its CLI test.

**Architecture:** Issue 559 asked for an enum registration that already landed in commit `560d71fd5` (2026-07-09), five days after the issue was filed. `RUN_TARGET_MISMATCH` is present in `CLISymbolicErrorCodeValues` (`packages/core/src/output/zod-schemas.ts:51`), in `CLIErrorCodes` (`:125`), and is pinned by `packages/core/__tests__/output/schema.test.ts:294-308`. No schema change is needed. What remains is documentation drift plus one broken test assertion discovered during verification. The issue's alternative fix — consolidating into `RUN_TARGET_UNAVAILABLE` — is rejected; see "Rejected Alternative" below.

**Tech Stack:** TypeScript, **Jest** (this repo has no vitest — `vitest` is not a dependency in any package; `packages/cli` and `packages/core` both run `jest`), Zod, markdown docs under `docs/spec/` and `docs/reference/`.

## Global Constraints

- Do **not** modify `packages/core/src/output/zod-schemas.ts`. `RUN_TARGET_MISMATCH` is already registered at lines 51 and 125. A "one-line registration" would be a duplicate enum member and a TypeScript error.
- Do **not** modify any file under `packages/core/src/` or `packages/cli/src/`. This change is docs + one test file. Production source is already correct.
- Documentation prose must match the message strings emitted by the code verbatim. The canonical message is produced at `packages/core/src/runbook/lifecycle-command-service.ts` (`#issueRetry`, token branch) as `` `Run ${input.targetRunId} does not own the supplied delegation token.` ``
- The refusal message must **never** echo the token's actual owning run id. This accident barrier is documented at `lifecycle-command-service.ts:316-321` (union-member TSDoc) and `:1051-1054` (inline comment). Docs must state this property; tests must enforce it.
- The error envelope field is `error`, **not** `message`. `OutputEmitter.error()` builds an internal `ErrorOutput` carrying `message`, but `JSONRenderer.render` (`packages/cli/src/services/json-renderer.ts:150-162`) maps it to the wire as `error: event.message`. No `message` key is ever written to an error envelope. Any test reading `payload.message` from one is reading `undefined`.
- `ErrorResponseSchema` is `.loose()` (`packages/core/src/output/zod-schemas.ts:313`) — it validates `kind`/`error`/`code` and **passes unknown keys through**. Do not describe it as "closed" in code, commits, or prose. Its teeth are on `code`, which is enum-validated.
- Markdown is formatted by **Prettier**, not biome: use `pnpm run format:md` (`prettier --write "**/*.md"`). The root `format` script is `biome format --write .`, which does not touch `.md` files. `pnpm run verify` includes `check:md` (`prettier --check`), so unformatted markdown fails the gate.
- Run `pnpm run verify` before pushing (repo rule, CLAUDE.md § Development Commands).
- Use the example run id `rd_9e725b142d81dabcefb9e04919568fcd` in docs, matching the existing "Run target unavailable" section at `docs/spec/cli-output.md:1160`.

## Rejected Alternative

Issue 559's option 2 proposes consolidating `RUN_TARGET_MISMATCH` into `RUN_TARGET_UNAVAILABLE` on the theory that both mean "the named run is not a valid target." Verification refutes this:

- `RUN_TARGET_UNAVAILABLE` is what the CLI emits (`packages/cli/src/commands/delegate.ts:325`) when core returns the `unknown_run` outcome built by `unknownRunRefusal` (`packages/core/src/runbook/command-target-resolver.ts:400-422`). It has two branches: `not_on_stack` ("Run X is not part of this session's active stack.") and `not_running` (the run is stopped or completed).
- `RUN_TARGET_MISMATCH` is raised at `packages/core/src/runbook/lifecycle-command-service.ts:1055-1061`, only on the `locator.kind === 'token'` branch (guard at `:1049-1055`), when the run **resolves perfectly well and may be a live stack member**, but the retry token belongs to a different run.

Collapsing them would emit one of `RUN_TARGET_UNAVAILABLE`'s messages in a case where **neither is true** — the run is on the stack and it is running. The remediation ("use a run id from the active session stack") is one the caller has already satisfied. The two conditions demand different caller responses: *pick a stack member* versus *drop `--run` or name the token's owner*. This is precisely the pattern CLAUDE.md § Design Principles forbids under "No silent mapping." The core `run_target_mismatch` union member (`lifecycle-command-service.ts:322`) would also have to survive regardless, so consolidation buys no simplification — it only widens the gap between the typed core outcome and the wire contract.

---

## File Structure

- `docs/spec/cli-output.md` — delete the stale exclusion comment (`:1112-1121`); add a "### Run target mismatch" envelope section after "### Run target unavailable" (which closes at `:1173`).
- `docs/reference/cli.md` — add a `RUN_TARGET_MISMATCH` row to the Common Errors table (after the `RUN_TARGET_UNAVAILABLE` row at `:1148`).
- `packages/cli/__tests__/commands/delegate.test.ts` — repair the vacuous assertion at `:481`; add envelope validation matching sibling tests.

---

### Task 0: Create the worktree

This work must not land on the current branch (`claim-progress-idle-detection`), which carries unrelated #519 commits. Do **not** try to switch branches in place: several untracked plan drafts under `docs/superpowers/plans/` exist on `origin/main` with different content, so `git switch` aborts with "untracked working tree files would be overwritten" rather than clobbering them. A worktree sidesteps the collision entirely and leaves the primary checkout untouched.

This repo keeps worktrees in `.worktrees/<issue>-<slug>` (gitignored at `.gitignore:20-21`; see siblings `498-scenario-capture-from-output`, `602-inline-parent-cycle-guard`). Plan-driven branches are named `plan-<issue>-<slug>` — `plan-602-inline-parent-cycle-guard` merged as #606.

**Files:** none modified.

- [ ] **Step 1: Create the worktree from origin/main**

```bash
git fetch origin
git worktree add -b plan-559-run-target-mismatch-docs \
  .worktrees/559-run-target-mismatch-docs origin/main
```

All subsequent commands run from `.worktrees/559-run-target-mismatch-docs`.

- [ ] **Step 2: Verify a clean baseline**

Run: `git -C .worktrees/559-run-target-mismatch-docs status --porcelain && git -C .worktrees/559-run-target-mismatch-docs diff --stat origin/main...HEAD`

Expected: both print nothing. This clean baseline is what makes Task 3 Step 3's diff check meaningful.

- [ ] **Step 3: Install and build**

```bash
cd .worktrees/559-run-target-mismatch-docs
pnpm install --frozen-lockfile
pnpm run build
```

Both are **required**, not optional. `delegate.test.ts` spawns the real CLI binary, so on a fresh worktree with no `packages/cli/dist/cli.js` every test in the suite fails during `createTestWorkspace` with `ENOENT: no such file or directory, chmod '…/packages/cli/dist/cli.js'` — a setup failure that looks nothing like an assertion failure. `pnpm install` emits `Failed to create bin … ENOENT` warnings for the plugin's `rundown`/`rd` bins before the build exists; they are harmless and resolve after `pnpm run build`.

---

### Task 1: Repair the vacuous accident-barrier assertion

The existing test at `packages/cli/__tests__/commands/delegate.test.ts` (the `RUN_TARGET_MISMATCH` test in the `delegate --run` describe block) asserts `expect(payload.message ?? '').not.toContain(parent.id)`. Error envelopes have no `message` field — only `error`. So `payload.message` is `undefined`, `undefined ?? ''` is `''`, and `''` never contains anything. The assertion passes unconditionally and guards nothing: a leaked owning-run id would go unnoticed. The accident barrier this test advertises is currently unenforced.

The fix reads the real field and adds a positive assertion alongside the negative one. A `.toContain(foreign)` and a `.not.toContain(parent.id)` on the same field cannot both be vacuous — if the field name were wrong, the positive assertion fails immediately. That is what gives the repaired test teeth, and it is why no deliberate sabotage of production source is needed to prove it. A third assertion pins the diagnosis itself: the envelope has no `message` property.

**Files:**
- Test: `packages/cli/__tests__/commands/delegate.test.ts` (the `RUN_TARGET_MISMATCH` test in the `delegate --run` describe block)

**Interfaces:**
- Consumes: `runCliInProcess`, `setupAutoIssuedDelegation`, `getActiveState`, `workspace` — all already defined in this test file. `ErrorResponseSchema` is already imported at `delegate.test.ts:2` and used by sibling tests at `:257`, `:285`, `:310`, `:402`; no import change is needed.
- Produces: nothing consumed by later tasks. Task 2 is documentation-only.

- [ ] **Step 1: Replace the assertion block**

Replace lines 479-481 of `packages/cli/__tests__/commands/delegate.test.ts`:

```typescript
      const payload = JSON.parse(result.stdout) as { code?: string; message?: string };
      expect(payload.code).toBe('RUN_TARGET_MISMATCH');
      expect(payload.message ?? '').not.toContain(parent.id);
```

with:

```typescript
      const raw: unknown = JSON.parse(result.stdout);
      // Error envelopes carry `error`, never `message` (json-renderer.ts:150-162
      // maps ErrorOutput.message onto the wire as `error`). Asserting on
      // `payload.message` reads undefined and passes vacuously — pin that here so
      // the field name cannot silently drift back.
      expect(raw).not.toHaveProperty('message');

      const parsed = ErrorResponseSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) throw new Error('Expected a schema-valid error envelope');
      expect(parsed.data.code).toBe('RUN_TARGET_MISMATCH');
      // Accident barrier: the refusal names only the caller-supplied id and never
      // echoes the token's actual owning run (lifecycle-command-service.ts:316-321).
      // The positive assertion is what keeps the negative one honest — together
      // they cannot both pass on a misspelled field.
      expect(parsed.data.error).toContain(foreign);
      expect(parsed.data.error).not.toContain(parent.id);
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/commands/delegate.test.ts -t 'RUN_TARGET_MISMATCH'`

Expected: PASS, `1 passed, 82 skipped`. Two of these assertions carry the proof and should be read as results, not ceremony: `not.toHaveProperty('message')` passing is the empirical confirmation that the envelope has no `message` field — i.e. that the assertion this task replaces was genuinely reading `undefined`. `toContain(foreign)` passing confirms the replacement reads a real, populated field.

If `parsed.data.error` does not contain `foreign`, the message template in `lifecycle-command-service.ts` (`#issueRetry`, the `locator.kind === 'token'` branch) has changed — stop and reconcile the plan with the code rather than weakening the assertion.

- [ ] **Step 3: Run the full delegate suite for regressions**

Run: `pnpm --filter @rundown-org/cli exec jest __tests__/commands/delegate.test.ts`

Expected: PASS, no failures.

> **Do not add a scoped Stryker step here.** An earlier revision of this plan called for
> `stryker run --mutate src/runbook/lifecycle-command-service.ts --testFiles __tests__/runbook/lifecycle-command-service.test.ts`
> to prove the repaired assertion catches a leaked run id. It cannot: the mutants live in
> `packages/core`, that run executes **only core's** test file, and the assertion under
> discussion is in `packages/cli` — which the run never loads. It would cost minutes and
> return a score about unrelated core coverage. Step 2's paired assertions already carry
> the proof directly. If you later want mutation signal for this specific barrier, the
> mutant must be killed by a test the run actually executes.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/__tests__/commands/delegate.test.ts
git commit -m "test(cli): assert the RUN_TARGET_MISMATCH accident barrier on the real envelope field (#559)

The accident-barrier assertion read payload.message, but error envelopes
carry `error` (json-renderer.ts:150-162 maps ErrorOutput.message onto the
wire as `error`). undefined ?? '' never contains the parent id, so the
assertion passed unconditionally and a leaked owning-run id would have gone
unnoticed. Read `error`, pair the negative assertion with a positive one so
neither can go vacuous, and pin the absent `message` property directly."
```

---

### Task 2: Document the RUN_TARGET_MISMATCH envelope

`docs/spec/cli-output.md:1112-1121` carries an HTML comment asserting `RUN_TARGET_MISMATCH` is "NOT registered in CLISymbolicErrorCodeValues ... so its envelope fails ErrorCodeSchema / --schema validation." That premise is false as of commit `560d71fd5`. The comment is the sole thing blocking documentation, and it blocks on a condition already satisfied.

The spec section and the reference-table row land together: both describe one error code and must agree on its semantics. A reviewer cannot sensibly accept one and reject the other, and splitting them would create exactly the two-artifacts-that-must-agree drift this plan exists to fix. Two commits inside the one task keep the `docs(spec)` / `docs(reference)` scopes clean.

**Files:**
- Modify: `docs/spec/cli-output.md` — delete `:1112-1121`; insert a new section after `:1173`
- Modify: `docs/reference/cli.md:1148` — insert the new row directly after

**Interfaces:**
- Consumes: the message string and accident-barrier property enforced by Task 1's repaired test.
- Produces: nothing downstream.

- [ ] **Step 1: Delete the stale HTML comment**

Remove these lines in full from `docs/spec/cli-output.md` (they sit between the `RUNBOOK_NOT_FOUND` JSON block closing at `:1110` and `### Actor context required` at `:1123`):

```markdown
<!--
  RUN_TARGET_MISMATCH is intentionally NOT documented here. It is emitted by
  `rundown delegate --retry <token> --run <rd_…>`
  (packages/cli/src/commands/delegate.ts, case 'run_target_mismatch') when the
  selected run does not own the token, but it is
  NOT registered in CLISymbolicErrorCodeValues (packages/core/src/output/zod-schemas.ts),
  so its envelope fails ErrorCodeSchema / --schema validation. Documenting it would
  document a schema-invalid envelope. Pending the follow-up enum-registration issue
  (see the R2 plan, Open Question 1), it is deliberately left out.
-->
```

Leave exactly one blank line between the closing fence of the `RUNBOOK_NOT_FOUND` JSON block and `### Actor context required`.

- [ ] **Step 2: Add the "Run target mismatch" section**

Insert immediately after the `### Run target unavailable` JSON block (closing fence at `:1173`) and before `### Invalid run id` (`:1175`). This placement keeps the two `--run` refusals adjacent so their distinction is legible:

````markdown
### Run target mismatch

`rundown delegate --retry <token> --run <rd_…>` where the `--run` id is a valid
target but is **not** the run that owns the supplied delegation token. Distinct
from `RUN_TARGET_UNAVAILABLE`: the named run may be a perfectly healthy,
running member of the active stack — the refusal is about token ownership, not
stack membership. Named authority is never silently discarded, so the retry is
refused rather than redirected to the token's real owner.

The message names only the caller-supplied id. It **never** echoes the run that
actually owns the token (accident-proofing: the caller learns their `--run` is
wrong without learning which run to name instead).

**Text:**

```text
Error: Run rd_9e725b142d81dabcefb9e04919568fcd does not own the supplied delegation token.
Code: RUN_TARGET_MISMATCH
```

**JSON:**

```json
{
  "kind": "error",
  "error": "Run rd_9e725b142d81dabcefb9e04919568fcd does not own the supplied delegation token.",
  "code": "RUN_TARGET_MISMATCH",
  "command": "delegate"
}
```
````

- [ ] **Step 3: Verify the documented message matches the emitted string exactly**

Run: `grep -n "does not own the supplied delegation token" packages/core/src/runbook/lifecycle-command-service.ts docs/spec/cli-output.md`

Expected: the emitted template and both new doc occurrences (text + JSON) render identically once `${input.targetRunId}` is substituted. Any wording divergence is a bug in the doc — fix the doc, not the code.

- [ ] **Step 4: Confirm the stale comment is gone**

Run: `grep -rn "intentionally NOT documented\|NOT registered in CLISymbolicErrorCodeValues" docs/spec/ docs/reference/`

Expected: no output. Scope the grep to these two directories — a bare `docs/` also matches this plan file, which quotes the comment verbatim in Step 1 and can never go quiet.

- [ ] **Step 5: Format the markdown and commit the spec change**

Run: `pnpm run format:md && pnpm run check:spell`

Expected: no errors. Accept Prettier's rewrapping of the new section rather than hand-wrapping.

```bash
git add docs/spec/cli-output.md
git commit -m "docs(spec): document the RUN_TARGET_MISMATCH envelope (#559)

The exclusion comment claimed the code was unregistered and its envelope
schema-invalid. It has been registered since 560d71fd5; the comment blocked
documentation on an already-satisfied condition. Document the envelope next
to RUN_TARGET_UNAVAILABLE and spell out how the two differ."
```

- [ ] **Step 6: Add the reference-table row**

`docs/reference/cli.md:1139-1151` is the operator-facing Common Errors table. Add this row immediately below the `RUN_TARGET_UNAVAILABLE` row at `:1148`, keeping the two adjacent so the contrast is visible. The remediation must not tell the caller to pick a different stack member — that is `RUN_TARGET_UNAVAILABLE`'s advice and is unactionable here:

```markdown
| `RUN_TARGET_MISMATCH`                       | `delegate --retry <token> --run <rd_…>` where the named run is a valid target but does not own the token                                              | Drop `--run` to let the token resolve its own owner, or name the run that actually owns the token — the refusal does not disclose it                              |
```

- [ ] **Step 7: Format, verify, and commit the reference change**

Run: `pnpm run format:md && pnpm run check:spell && grep -c "RUN_TARGET_MISMATCH" docs/reference/cli.md`

Expected: no errors from the first two; the grep prints `1`. Prettier normalises the table's column padding — accept its output rather than hand-aligning.

```bash
git add docs/reference/cli.md
git commit -m "docs(reference): add RUN_TARGET_MISMATCH to the common errors table (#559)

Its remediation is distinct from RUN_TARGET_UNAVAILABLE's: the caller's --run
may be a fine stack member, so 'use a run id from the active stack' would be
unactionable advice."
```

---

### Task 3: Full verification and PR

**Files:** none modified.

- [ ] **Step 1: Run the pre-PR gate**

Run: `pnpm run verify`

Expected: PASS — format, spell, lint, test all green. This is the mandatory pre-push gate (CLAUDE.md § Development Commands). If `check:md` fails, Task 2's `format:md` was skipped.

- [ ] **Step 2: Confirm the schema test still pins the code**

Run: `pnpm --filter @rundown-org/core exec jest __tests__/output/schema.test.ts -t 'RUN_TARGET_MISMATCH'`

Expected: PASS, `1 passed, 51 skipped`. This test (`schema.test.ts:294-308`) predates this plan and must remain green — it is the proof no schema change was needed.

- [ ] **Step 3: Confirm only the intended files changed**

Run: `git status --porcelain && git diff --stat origin/main...HEAD`

Expected: `git status` prints nothing; the diff lists exactly `docs/spec/cli-output.md`, `docs/reference/cli.md`, `packages/cli/__tests__/commands/delegate.test.ts`, and this plan file. Any file under `packages/core/src/` or `packages/cli/src/` violates this plan's Global Constraints — production source is already correct and must not be touched. This check is only meaningful because Task 0 created the worktree from a clean `origin/main`.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "docs(spec): document RUN_TARGET_MISMATCH; repair its vacuous test assertion (#559)" --body "$(cat <<'EOF'
Closes #559.

## The issue was stale

Issue 559 asked for `RUN_TARGET_MISMATCH` to be registered in
`CLISymbolicErrorCodeValues`. That landed in 560d71fd5 (2026-07-09), five days
after the issue was filed — see `zod-schemas.ts:51` and `:125`, pinned by
`schema.test.ts:294-308`. No schema change was needed here.

What remained was documentation drift: `docs/spec/cli-output.md` still carried
an HTML comment asserting the code was unregistered and its envelope
schema-invalid, blocking its own documentation on an already-satisfied
condition. The registering commit never updated the doc that contradicted it.

## Option 2 rejected

The issue's alternative — consolidating into `RUN_TARGET_UNAVAILABLE` — is
rejected on the merits. `RUN_TARGET_UNAVAILABLE` means the run is either absent
from the session stack or no longer running; `RUN_TARGET_MISMATCH` fires on a
run that may be a perfectly healthy, running stack member but does not own the
retry token. Collapsing them would emit a message that is false in that case,
with a remediation the caller has already satisfied. It would violate "No
silent mapping," and would leave the core `run_target_mismatch` union member in
place anyway.

## Bonus defect found and fixed

`delegate.test.ts:481` asserted `expect(payload.message ?? '').not.toContain(parent.id)`.
Error envelopes carry `error`, not `message` (`json-renderer.ts:150-162` maps
`ErrorOutput.message` onto the wire as `error`), so the assertion read
`undefined` and passed unconditionally — the accident barrier it advertised was
unenforced. It now reads `error`, pairs the negative assertion with a positive
`toContain(foreign)` so neither can go vacuous, and pins the absent `message`
property directly.

## Verification

`pnpm run verify` passes.
EOF
)"
```

- [ ] **Step 5: File the follow-up on the root cause**

The root cause is the absent docs↔enum coupling, not the missing enum entry. The entry was fixed in a day; the doc contradicted it for eight and would have indefinitely. Nothing parses `docs/spec/cli-output.md` — no test reads the markdown, and no `package.json` script checks its content. A test asserting documented codes are registered would have caught this class of drift. That belongs in its own issue, not this PR:

```bash
gh issue create --title "Add a docs↔enum drift check for documented CLI error codes" --body "Nothing couples \`docs/spec/cli-output.md\` to \`CLISymbolicErrorCodeValues\` (\`packages/core/src/output/zod-schemas.ts\`). No test parses the markdown; no script checks its content.

This let #559's stale exclusion comment survive the very commit (560d71fd5) that invalidated it — the doc asserted RUN_TARGET_MISMATCH was unregistered for eight days after it was registered, and would have indefinitely.

Proposal: a test that extracts \`\"code\": \"…\"\` values from the JSON fences in \`docs/spec/cli-output.md\` and asserts each is a member of \`CLISymbolicErrorCodeValues\` or \`RundownErrorCodeValues\`. Set-inclusion in one direction (documented ⊆ registered) catches documenting invalid codes. The reverse direction (registered ⊆ documented) would be stricter but needs an opt-out for codes deliberately left undocumented." --label "P3: low"
```
