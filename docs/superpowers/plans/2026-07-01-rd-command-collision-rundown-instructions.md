# Fix `rd`/`rmdir` Collision — Instruct `rundown` in Agent-Facing Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop instructing agents and humans to type the two-letter `rd` command (which oh-my-zsh shadows with `alias rd=rmdir`) by switching all agent-facing content to the collision-proof full name `rundown`, while keeping the `rd` bin for humans with clean shells.

**Architecture:** `rd` is a duplicate `bin` entry in `packages/cli/package.json` (a real PATH executable, not a shell alias) pointing at the same `dist/cli.js` as `rundown`. The oh-my-zsh core lib defines `alias rd=rmdir`, and shell alias resolution beats PATH lookup, so `rd …` expands to `rmdir …`. We do **not** rename or remove the bin (that would break existing users and risk a new collision). Instead we change *what we instruct*: every executable, agent-facing `rd …` invocation (runtime-emitted hook strings, skills, reference docs) becomes `rundown …`. `isInternalRdCommand`/`parseRdCommand` in the CLI already accept both `rd` and `rundown`, and the plugin does **not** classify Bash commands by `rd`/`rundown` for gate decisions, so this change is text-only with zero functional coupling to gate behavior. A new guard test prevents regression back to bare `rd` in skills/runbooks. Humans who want the short name back add one documented line: `alias rd=rundown`.

**Tech Stack:** TypeScript, Jest, pnpm workspaces, Markdown. Mechanical replacements use `perl -0pi -e 's/\brd /rundown /g'` (the `\b` boundary is essential — a naive `s/rd /rundown /` corrupts words ending in "rd ", e.g. "standard output").

## Global Constraints

- **Do NOT change `packages/cli/package.json` bin entries.** The `rd` bin stays. This task changes instructions, not the shipped binary. (Verbatim decision from investigation: "Keep the `rd` bin.")
- **Do NOT change command *detection*, only *guidance*.** `packages/cli/src/services/internal-commands.ts:32` (`trimmed.startsWith('rd ')`) and `:34` (`trimmed === 'rd'`) are the runtime detectors that let humans keep typing `rd`. They MUST continue to match `rd`. Blind file-level sweeps of any CLI source file are therefore **forbidden** — CLI emitted-string edits (Task 2) are surgical, per-string `Edit`s, never `perl -0pi` over a whole file (which would also rewrite the detector and internal JSDoc). Whole-file `perl` sweeps are only for skills, runbooks, and docs (Tasks 3–6), which contain no detectors.
- **`rd://` is a URI scheme, not a command.** The artifact scheme `rd://…` (e.g. `delegate.ts:596`) stays. `\brd ` does not match it (colon, not space, follows), and per-string edits must leave it intact.
- **Word-boundary replacement only.** Any scripted replace MUST anchor as `\brd ` (perl `\b`). Verify on macOS/BSD with perl, not `sed` (BSD sed lacks `\b`). Confirmed safe: `standard`→unchanged, `rdpath`/`rdx`/`rdtk_…`/`rd://`→unchanged, ` rd `→`rundown `. **Known limitation:** `\brd ` does NOT match `rd` preceded by a word char — including the two-character literal `\n` in a source string (`'…\nrd claim…'`), where the `n` is a word char. Such cases (Task 1's `on-delegation-dispatch.test.ts` fixtures) survive every `\brd`-based sweep AND every `\brd\b` residual grep, so they need a manual edit if consistency is wanted.
- **JSON is the default output contract.** Do not add `--text` to any agent-facing command while editing. The one allow-listed human `--text` example moves with its command (Task 3).
- **Prospective docs are write-once.** Do **not** edit dated files under `docs/superpowers/` (specs/plans/notes). They are historical records. Only descriptive docs (`docs/reference/`, `docs/internal/`, `docs/guides/`, `docs/spec/`), skills, runbooks, `README.md`, and `CLAUDE.md` are in scope.
- **Every string change paired with its test.** Runtime hook strings are pinned by exact-substring Jest assertions; the source edit and the test edit land in the same task/commit.
- Run `pnpm run verify` before opening the PR (checks format, spell, lint, test).

---

### Task 1: Switch runtime-emitted hook/gate strings to `rundown`

The highest-risk surface: these strings are injected into the live agent conversation as executable recovery commands. All are pinned by exact-substring tests, so source and test edits land together.

**Files:**
- Modify: `packages/claude-code-plugin/src/workflow/hooks/delegation-dispatch.ts` (lines 94, 137, 138, 166-172, 177)
- Modify: `packages/claude-code-plugin/src/workflow/hooks/subagent-stop.ts` (lines 139, 149, 155-157, 181, 196)
- Modify: `packages/claude-code-plugin/src/gates/on-delegation-dispatch.ts:48`
- Modify: `packages/claude-code-plugin/src/gates/on-subagent-stop.ts:30`
- Modify: `packages/claude-code-plugin/src/shared/schemas.ts` (comments at 100, 115, 124)
- Test: `packages/claude-code-plugin/__tests__/workflow/hooks/delegation-dispatch.test.ts`
- Test: `packages/claude-code-plugin/__tests__/workflow/hooks/subagent-stop.test.ts`
- Test: `packages/claude-code-plugin/__tests__/gates/on-delegation-dispatch.test.ts` (fixtures at 45, 56)
- Test: `packages/claude-code-plugin/__tests__/minimal-dispatch.contract.test.ts` (assertion at 61, fixture at 84)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the runtime context now emits `rundown claim <token>`, `rundown status --claim-id <claim_id>`, `rundown pass/fail/stash/pop/stop/complete --claim-id <claim_id>`. Task 2's guard test does not scan `src/`, so no cross-task dependency; downstream tasks rely only on the observable string `rundown` replacing `rd` in these messages.

- [ ] **Step 1: Confirm the tests currently pin the old `rd` strings (baseline RED-after-edit setup)**

Run:
```bash
cd packages/claude-code-plugin
pnpm exec jest __tests__/workflow/hooks/delegation-dispatch.test.ts __tests__/workflow/hooks/subagent-stop.test.ts __tests__/gates/on-delegation-dispatch.test.ts __tests__/minimal-dispatch.contract.test.ts
```
Expected: PASS (they assert the current `rd …` strings). This is the baseline; after Step 2 they will FAIL until Step 3 updates them.

- [ ] **Step 2: Replace `rd ` with `rundown ` in the four source files (boundary-anchored)**

Run:
```bash
cd /Users/tobyhede/psrc/rundown
perl -0pi -e 's/\brd /rundown /g' \
  packages/claude-code-plugin/src/workflow/hooks/delegation-dispatch.ts \
  packages/claude-code-plugin/src/workflow/hooks/subagent-stop.ts \
  packages/claude-code-plugin/src/gates/on-delegation-dispatch.ts \
  packages/claude-code-plugin/src/gates/on-subagent-stop.ts \
  packages/claude-code-plugin/src/shared/schemas.ts
```

Then verify no stray `rd` command tokens remain (should print nothing except `rundown`, `rdtk_`, identifiers like `parseRdCommand`):
```bash
grep -nE '\brd\b' \
  packages/claude-code-plugin/src/workflow/hooks/delegation-dispatch.ts \
  packages/claude-code-plugin/src/workflow/hooks/subagent-stop.ts \
  packages/claude-code-plugin/src/gates/on-delegation-dispatch.ts \
  packages/claude-code-plugin/src/gates/on-subagent-stop.ts
```
Expected: empty output. If any `\brd\b` remains (e.g. `rd` at end of a line), edit it to `rundown` by hand.

Spot-check the key literal in `delegation-dispatch.ts` now reads:
```typescript
const claimCommand = `rundown claim ${token}`;
```
and the closure list reads `rundown status --claim-id <claim_id>`, `rundown pass --claim-id <claim_id>`, etc.

- [ ] **Step 3: Run the paired tests to confirm they now FAIL, then update assertions**

Run:
```bash
cd packages/claude-code-plugin
pnpm exec jest __tests__/workflow/hooks/delegation-dispatch.test.ts __tests__/workflow/hooks/subagent-stop.test.ts __tests__/gates/on-delegation-dispatch.test.ts __tests__/minimal-dispatch.contract.test.ts
```
Expected: FAIL — assertions still expect `rd …` but source now emits `rundown …`.

Apply the same boundary-anchored replace to the four test files:
```bash
cd /Users/tobyhede/psrc/rundown
perl -0pi -e 's/\brd /rundown /g' \
  packages/claude-code-plugin/__tests__/workflow/hooks/delegation-dispatch.test.ts \
  packages/claude-code-plugin/__tests__/workflow/hooks/subagent-stop.test.ts \
  packages/claude-code-plugin/__tests__/gates/on-delegation-dispatch.test.ts \
  packages/claude-code-plugin/__tests__/minimal-dispatch.contract.test.ts
```

This updates, e.g.:
- `delegation-dispatch.test.ts`: `expect(result.context).toContain(\`rundown claim ${VALID_TOKEN}\`)` and the `rundown status/pass/fail/... --claim-id <claim_id>` list.
- `subagent-stop.test.ts:39,41`: the two full expected-message constants now say `rundown status`, `rundown pass --claim-id`, `rundown delegate --retry`, `rundown abort <token>`.
- `minimal-dispatch.contract.test.ts:61`: `.toMatch(/rundown claim/)`; line 84 fixture becomes `command: 'rundown pass'` (still an arbitrary pass-through command — intent preserved).

**Manual edit — `on-delegation-dispatch.test.ts:45,56` will NOT be touched by the sweep.** These fixtures are `'## Delegation Context\nrundown claim rdtk_ABC123'`-shaped *inputs* fed into the gate, where the literal `\n` puts a word char immediately before `rd`, so `\brd ` skips them. They are inputs, not assertions on dispatch output, so leaving them as `rd claim` does not fail any test. For consistency with the swept source, edit both lines by hand:
```typescript
context: '## Delegation Context\nrundown claim rdtk_ABC123',
```
```typescript
additionalContext: '## Delegation Context\nrundown claim rdtk_ABC123',
```
(The `rdtk_ABC123` token is unrelated to the `rd` command and stays.) Note the `\brd\b` residual grep in Step 2 also cannot catch these — the manual edit is the only path.

Note the regex assertions that use `|` alternation (`minimal-dispatch.contract.test.ts:69` `/rundown status|claim-id|close/i`, `subagent-stop-fail-closed.regression.test.ts:49,60` `/rundown status|close|verify/i`) still pass either way; the replace keeps them consistent.

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd packages/claude-code-plugin
pnpm exec jest __tests__/workflow/hooks/delegation-dispatch.test.ts __tests__/workflow/hooks/subagent-stop.test.ts __tests__/gates/on-delegation-dispatch.test.ts __tests__/minimal-dispatch.contract.test.ts __tests__/subagent-stop-fail-closed.regression.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code-plugin/src packages/claude-code-plugin/__tests__
git commit -m "fix(plugin): emit \`rundown\` not \`rd\` in runtime recovery guidance (#459)

The two-letter \`rd\` collides with oh-my-zsh's \`alias rd=rmdir\`.
Runtime-injected recovery commands now use the collision-proof full name."
```

---

### Task 1B: CLI and MCP package emitted `rd` guidance strings

The `@rundown-org/cli` and `@rundown-org/mcp` packages emit their *own* `rd …` guidance at runtime (usage lines, error messages, hints) — an agent-facing surface the plugin-focused Task 1 does not cover. These are **surgical, per-string edits**: the same files also contain the `rd` command *detector* (`internal-commands.ts`) and internal JSDoc, which MUST NOT change. Do **not** `perl -0pi` these files.

**Files (edit only the emitted string on each line):**
- Modify: `packages/cli/src/cli.ts:60,61`
- Modify: `packages/cli/src/commands/collect.ts:383`
- Modify: `packages/cli/src/commands/run.ts:338,376`
- Modify: `packages/cli/src/commands/delegate.ts:596` (two command occurrences; leave `rd://` intact)
- Modify: `packages/cli/src/helpers/runbook-pipeline.ts:432`
- Modify: `packages/cli/src/helpers/transitions.ts:420,450`
- Modify: `packages/mcp/src/tools.ts:166`
- **Do NOT touch:** `packages/cli/src/services/internal-commands.ts:32,34` (detector — keeps `rd` working), `packages/cli/src/helpers/command-sequence.ts:187,265` (JSDoc comments)
- Test: paired CLI/MCP tests — located via grep in Step 2

**Interfaces:**
- Consumes: nothing.
- Produces: CLI/MCP runtime output instructs `rundown …`; the `rd` detector and `rd://` scheme are unchanged.

- [ ] **Step 1: Apply the per-string edits**

Make exactly these replacements (each is one `Edit`; the surrounding line is otherwise unchanged):

| File:line | `rd` (old) | `rundown` (new) |
| --- | --- | --- |
| `cli.ts:60` | `'Usage: rd <command> --schema'` | `'Usage: rundown <command> --schema'` |
| `cli.ts:61` | `'Example: rd status --schema'` | `'Example: rundown status --schema'` |
| `collect.ts:383` | `'rd collect requires an actor that controls the target delegating run.'` | `'rundown collect requires an actor that controls the target delegating run.'` |
| `run.ts:338` | `"Try 'rd ls --all' to list available runbooks."` | `"Try 'rundown ls --all' to list available runbooks."` |
| `run.ts:376` | `'rd run: --text is human-readable output; omit it for the JSON events agents parse to drive runbooks.'` | `'rundown run: --text is human-readable output; omit it for the JSON events agents parse to drive runbooks.'` |
| `runbook-pipeline.ts:432` | `` Try 'rd ls --all' to list available runbooks. `` | `` Try 'rundown ls --all' to list available runbooks. `` |
| `transitions.ts:420` | `` Cannot run bare rd ${command}: … Use `rd ${command} --claim-id <claim_id>` … `` | `` Cannot run bare rundown ${command}: … Use `rundown ${command} --claim-id <claim_id>` … `` |
| `transitions.ts:450` | `` Cannot run bare rd ${command}: ${message} … run rd collect. `` | `` Cannot run bare rundown ${command}: ${message} … run rundown collect. `` |
| `tools.ts:166` (mcp) | `` retry an existing delegation, run `rd delegate` directly in a trusted terminal. `` | `` retry an existing delegation, run `rundown delegate` directly in a trusted terminal. `` |

For `delegate.ts:596`, change both command occurrences and leave the URI scheme untouched:
```typescript
`rundown delegate does not support supplying input artifacts: delegation-inheritance of artifacts to the child runbook is not yet implemented. Supply artifacts to the child directly with \`rundown claim --artifacts <key=rd://...>\` instead.`,
```
(`rd://` stays — it is the artifact URI scheme, not the CLI command.)

- [ ] **Step 2: Find and run the paired tests (expect FAIL), then update assertions**

Locate tests that pin these exact strings:
```bash
cd /Users/tobyhede/psrc/rundown
grep -rlnE "rd (run:|collect|ls --all|<command>|status --schema|delegate|\\\$\{command\})|Usage: rd|bare rd" \
  packages/cli/__tests__ packages/cli/src/**/*.test.ts packages/mcp/__tests__ packages/mcp/src/**/*.test.ts 2>/dev/null
```
Run the CLI + MCP suites and update any assertion that still expects `rd …` to `rundown …`, editing each string to match its source counterpart exactly:
```bash
pnpm --filter @rundown-org/cli test
pnpm --filter @rundown-org/mcp test
```
Expected before edits: FAIL on the strings changed in Step 1. After matching the assertions: PASS. (Guard against over-reach: do not change any test asserting the *detector* still accepts `rd`, e.g. an `isInternalRdCommand('rd …')` case — that behavior is intentionally preserved.)

- [ ] **Step 3: Verify the detector is intact**

```bash
cd /Users/tobyhede/psrc/rundown
grep -n "startsWith('rd '\|=== 'rd'" packages/cli/src/services/internal-commands.ts
```
Expected: both lines still present (unchanged). `rd` detection must survive.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src packages/mcp/src packages/cli/__tests__ packages/mcp/__tests__
git commit -m "fix(cli,mcp): emit \`rundown\` not \`rd\` in usage/error guidance (#459)

Detector (internal-commands.ts) and the rd:// artifact scheme are unchanged."
```

---

### Task 1C: Core package emitted `rd` error, refusal, and generated-command strings

The `@rundown-org/core` package emits agent-facing `rd …` guidance inside **error/refusal messages** — the same runtime-string class as Tasks 1/1B, and among the most frequently surfaced messages an agent sees (e.g. the "no runbook running" error, the bare-transition refusals). These are **not** JSDoc. Verified: none of these files detect commands by an `rd` prefix (the only `startsWith('rd…')` in core is the unrelated `rd://` artifact scheme), so edits are guidance-only — but keep them **surgical per-string**, because the files also contain `rd`-referencing comments and the `rd://` scheme that must stay.

**Files (edit only the emitted message on each line):**
- Modify: `packages/core/src/errors/codes.ts:93,101,115,332,371`
- Modify: `packages/core/src/errors/factory.ts:116`
- Modify: `packages/core/src/runbook/command-target-resolver.ts:218`
- Modify: `packages/core/src/runbook/collection-service.ts:228`
- Modify: `packages/core/src/runbook/subprocess-mutation-boundary.ts:347-348,404-407`
- Modify: `packages/core/src/runbook/session-lock.ts:25` (descriptive, not a command — see Step 1)
- Modify (generated command — see Step 3): `packages/parser/src/parser.ts:448`
- **Do NOT touch:** any `startsWith('rd://')` (artifact scheme — `artifact-inputs.ts`, `artifact-service.ts`, `variable-preparation.ts`, `template-renderer.ts`, `artifact-token.ts`), and the `rd`-referencing **comments** in `subprocess-mutation-boundary.ts:6,8,42,317`
- Test: paired core/parser tests — located via grep in Step 2/3

**Interfaces:**
- Consumes: nothing.
- Produces: core error/refusal messages instruct `rundown …`; the parser emits `rundown prompt …` generated code; the `rd://` scheme and command detection are unchanged.

- [ ] **Step 1: Apply the per-string error/refusal edits**

Change each `rd <verb>` command to `rundown <verb>`, leaving the rest of each string intact. Single-line strings:

| File:line | command token → |
| --- | --- |
| `codes.ts:93` | `rd run <file>` → `rundown run <file>` |
| `codes.ts:101` | `rd prune` → `rundown prune` |
| `codes.ts:115` | `rd pop` → `rundown pop` |
| `codes.ts:332` | `` `rd run` `` → `` `rundown run` `` |
| `codes.ts:371` | `` `rd abort <token> --force` `` → `` `rundown abort <token> --force` `` |
| `factory.ts:116` | `"rd abort <token> --force"` → `"rundown abort <token> --force"` |
| `command-target-resolver.ts:218` | `` `rd pop --claim-id ${claimId}` `` → `` `rundown pop --claim-id ${claimId}` `` |
| `collection-service.ts:228` | `rd collect requires` → `rundown collect requires` |
| `session-lock.ts:25` | `Another rd process` → `Another rundown process` (descriptive noun, not a typed command — changed for consistency) |

Multi-line concatenated refusals in `subprocess-mutation-boundary.ts` — replace every `` `rd … `` with `` `rundown … `` (three occurrences at 347-348, three at 404-407):
```typescript
// 347-348
    '`rundown delegate` does not accept --claim-id; complete claimed children with ' +
    '`rundown pass --claim-id <claimId>` or `rundown fail --claim-id <claimId>`.'
```
```typescript
// 404-407
    `Refusing to run a bare \`rundown ${command}\` from a subprocess front end: it would ` +
    // …unchanged middle line…
    `child with \`rundown ${command === 'delegate' ? 'pass' : command} --claim-id <claimId>\`, ` +
    `or run \`rundown ${command}\` directly.`
```

- [ ] **Step 2: Find and update the paired core tests (TDD loop)**

Locate the error/refusal assertions:
```bash
cd /Users/tobyhede/psrc/rundown
grep -rlnE 'rd (run|prune|pop|abort|collect|delegate|pass|fail) ' packages/core/__tests__ packages/core/src 2>/dev/null | grep -vE 'rd://'
```
Run the core suite; update any assertion expecting the old `rd …` string to `rundown …` (matching the source exactly). Do **not** change tests asserting `rd://` behavior or `isInternalRdCommand`-style detection.
```bash
pnpm --filter @rundown-org/core test
```
Expected: FAIL on the changed strings before the test edits, PASS after.

- [ ] **Step 3: Update the parser generated-command string + its test**

`packages/parser/src/parser.ts:448` emits generated executable code:
```typescript
      code: `rd prompt '${escaped}'`,
```
This is functionally collision-safe (spawned/non-interactive execution does not load `.zshrc` aliases, and `isInternalRdCommand` accepts both names), but for consistency with the Goal it should read `rundown`:
```typescript
      code: `rundown prompt '${escaped}'`,
```
Then update the parser test that pins it and check for ripple into core/cli consumers of `step.code`:
```bash
cd /Users/tobyhede/psrc/rundown
grep -rn "rd prompt" packages/parser/__tests__ packages/core/__tests__ packages/cli/__tests__ | grep -v '.stryker-tmp'
pnpm --filter @rundown-org/parser test
```
Update each pinned `rd prompt '…'` expectation to `rundown prompt '…'`. **Escape hatch:** if this ripples into many core/cli snapshot expectations beyond the parser's own test, it is acceptable to defer *only this parser edit* to a follow-up (note it in the PR) — the error/refusal edits in Steps 1-2 are the load-bearing part of this task and must land. Do not defer them.

- [ ] **Step 4: Verify no detection or `rd://` scheme was disturbed**

```bash
cd /Users/tobyhede/psrc/rundown
grep -rnE "startsWith\('rd://'\)|startsWith\(\"rd://\"\)" packages/core/src packages/parser/src | wc -l
```
Expected: unchanged count (the `rd://` scheme guards are all intact). Then:
```bash
pnpm --filter @rundown-org/core test && pnpm --filter @rundown-org/parser test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/__tests__ packages/parser/src packages/parser/__tests__
git commit -m "fix(core,parser): emit \`rundown\` not \`rd\` in error/refusal/generated strings (#459)

The rd:// artifact scheme and command detection are unchanged."
```

---

### Task 2: Add a regression guard test for bare `rd` in skills and runbooks

Model this on the existing `__tests__/content/json-default-output.test.ts` fenced-block scanner. It fails if any skill or runbook fenced code block instructs a bare `rd …` command. Written first (RED) so it enumerates every violation Task 3 must clear.

**Files:**
- Create: `packages/claude-code-plugin/__tests__/content/no-bare-rd-command.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `no-bare-rd-command.test.ts` — a suite that scans `skills/` and `runbooks/` `.md` fenced blocks for lines matching `/(^|\s)rd\s+\S+/` and asserts the violation list is empty. Task 3 turns it GREEN.

- [ ] **Step 1: Write the failing guard test**

Create `packages/claude-code-plugin/__tests__/content/no-bare-rd-command.test.ts`:
```typescript
import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(__dirname, '..', '..');

interface Match {
  file: string;
  command: string;
}

function markdownFiles(root: string): string[] {
  const entries = readdirSync(root);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...markdownFiles(fullPath));
    } else if (entry.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

function fencedBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const pattern = /```[^\n]*\n([\s\S]*?)```/g;
  for (const match of markdown.matchAll(pattern)) {
    blocks.push(match[1]);
  }
  return blocks;
}

function bareRdCommands(filePath: string): Match[] {
  const relative = path.relative(pluginRoot, filePath).replaceAll('\\', '/');
  const markdown = readFileSync(filePath, 'utf-8');
  const matches: Match[] = [];
  for (const block of fencedBlocks(markdown)) {
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      // A bare `rd <subcommand>` invocation — the oh-my-zsh `rd=rmdir` trap.
      // `rundown …` is the required collision-proof form (#459).
      if (/(^|[`\s])rd\s+\S+/.test(line)) {
        matches.push({ file: relative, command: line });
      }
    }
  }
  return matches;
}

describe('plugin skills and runbooks never instruct the bare `rd` command (#459)', () => {
  it('uses `rundown`, never `rd`, in fenced command examples', () => {
    const roots = [path.join(pluginRoot, 'skills'), path.join(pluginRoot, 'runbooks')];
    const violations = roots.flatMap((root) => markdownFiles(root).flatMap(bareRdCommands));

    expect(violations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it FAILS and lists every `rd` violation**

Run:
```bash
cd packages/claude-code-plugin
pnpm exec jest __tests__/content/no-bare-rd-command.test.ts
```
Expected: FAIL. The guard scans **fenced code blocks only**, so it flags fewer lines than a raw `grep -c '\brd '` (which also counts prose). Expect on the order of ~70 violations across **6 files**: `running-runbooks/SKILL.md`, `delegating-runbooks/SKILL.md`, `rundown/SKILL.md`, `end-to-end-testing/SKILL.md`, `writing-runbooks/SKILL.md`, and `runbooks/meta/convert-skill.runbook.md`. The other 5 files in Task 3's sweep list (`planning`, `executing-plans`, `writing-plans`, `converting-skills-to-runbooks/SKILL.md` + its two references) contain only *prose* `rd`, which the guard does not check — sweeping them is still correct (agents read prose too), just not guard-enforced. This fenced-block set is the worklist that turns the guard green in Task 3.

- [ ] **Step 3: Commit the guard (still red)**

```bash
git add packages/claude-code-plugin/__tests__/content/no-bare-rd-command.test.ts
git commit -m "test(plugin): add guard forbidding bare \`rd\` in skills/runbooks (#459)

Currently red — Task 3 (the skills sweep) turns it green."
```

---

### Task 3: Sweep skills and runbooks to `rundown`, fix paired skill tests

Turn the Task 2 guard green and update the skill-content tests that assert exact `rd …` strings.

**Files:**
- Modify (skills, `\brd ` → `rundown `): `packages/claude-code-plugin/skills/rundown/SKILL.md`, `skills/running-runbooks/SKILL.md`, `skills/planning/SKILL.md`, `skills/executing-plans/SKILL.md`, `skills/delegating-runbooks/SKILL.md`, `skills/writing-runbooks/SKILL.md`, `skills/converting-skills-to-runbooks/SKILL.md`, `skills/converting-skills-to-runbooks/references/mapping.md`, `skills/converting-skills-to-runbooks/references/checklist.md`, `skills/writing-plans/SKILL.md`, `skills/end-to-end-testing/SKILL.md`
- Modify: `packages/claude-code-plugin/runbooks/meta/convert-skill.runbook.md`
- Test: `packages/claude-code-plugin/__tests__/skills/claim-guidance.test.ts` (lines 59-62)
- Test: `packages/claude-code-plugin/__tests__/skills/end-to-end-testing.test.ts` (lines 37, 46-47, 53, 61, 64, 66)
- Test: `packages/claude-code-plugin/__tests__/content/json-default-output.test.ts` (allowlist key at line 20)
- Test: `packages/claude-code-plugin/__tests__/runbooks/end-to-end-test-runtime.integration.test.ts` (comments at 5, 11-14, 115, 225 — cosmetic)

**Interfaces:**
- Consumes: the guard test from Task 2.
- Produces: skills/runbooks contain zero bare `rd ` command usages; the `--text` allowlist key now reads `rundown status --text`.

- [ ] **Step 1: Sweep all 11 skill files + the runbook (boundary-anchored)**

Run:
```bash
cd /Users/tobyhede/psrc/rundown
perl -0pi -e 's/\brd /rundown /g' \
  packages/claude-code-plugin/skills/rundown/SKILL.md \
  packages/claude-code-plugin/skills/running-runbooks/SKILL.md \
  packages/claude-code-plugin/skills/planning/SKILL.md \
  packages/claude-code-plugin/skills/executing-plans/SKILL.md \
  packages/claude-code-plugin/skills/delegating-runbooks/SKILL.md \
  packages/claude-code-plugin/skills/writing-runbooks/SKILL.md \
  packages/claude-code-plugin/skills/converting-skills-to-runbooks/SKILL.md \
  packages/claude-code-plugin/skills/converting-skills-to-runbooks/references/mapping.md \
  packages/claude-code-plugin/skills/converting-skills-to-runbooks/references/checklist.md \
  packages/claude-code-plugin/skills/writing-plans/SKILL.md \
  packages/claude-code-plugin/skills/end-to-end-testing/SKILL.md \
  packages/claude-code-plugin/runbooks/meta/convert-skill.runbook.md
```

- [ ] **Step 2: Catch stragglers — any remaining `\brd\b` in those files**

Run:
```bash
cd /Users/tobyhede/psrc/rundown
grep -rnE '\brd\b' packages/claude-code-plugin/skills packages/claude-code-plugin/runbooks | grep -vE 'rdpath|rdx|rdtk_|rundown'
```
Expected: empty, or a few prose mentions of the word "rd" at line-ends / before punctuation. Edit any command-context ones to `rundown` by hand. A legitimately remaining case: a line that *documents the collision itself* (there should be none in skills — that guidance lives in docs, Task 4).

- [ ] **Step 3: Run the guard test — expect GREEN**

Run:
```bash
cd packages/claude-code-plugin
pnpm exec jest __tests__/content/no-bare-rd-command.test.ts
```
Expected: PASS.

- [ ] **Step 4: Run the skill-content tests — expect FAIL, then fix their assertions**

Run:
```bash
cd packages/claude-code-plugin
pnpm exec jest __tests__/skills/claim-guidance.test.ts __tests__/skills/end-to-end-testing.test.ts __tests__/content/json-default-output.test.ts
```
Expected: FAIL — assertions still reference `rd …`.

Apply the replace to the two skill-assertion tests:
```bash
cd /Users/tobyhede/psrc/rundown
perl -0pi -e 's/\brd /rundown /g' \
  packages/claude-code-plugin/__tests__/skills/claim-guidance.test.ts \
  packages/claude-code-plugin/__tests__/skills/end-to-end-testing.test.ts
```
This makes `claim-guidance.test.ts` assert `rundown pass --claim-id <claim_id>` and the negative guards `not.toMatch(/rundown pass\s+(?:#|$)/m)`; and `end-to-end-testing.test.ts` assert `rundown claim <token>`, `rundown pass/fail --claim-id`, the `rundown run`, `rundown pass`, `rundown fail`, `rundown claim`, `rundown collect` list, `rundown status`, and `not.toContain('rundown status --text')`.

Then update the `--text` allowlist key in `json-default-output.test.ts:20` by hand (its command text must match the swept skill line exactly):
```typescript
  'skills/running-runbooks/SKILL.md :: rundown status --text    # Human-readable text output',
```
(Verify the exact spacing/comment against the swept line in `running-runbooks/SKILL.md`; the allowlist compares the full trimmed command string.)

Optionally sweep the integration-test comments for consistency (cosmetic, no assertions on `rd`):
```bash
perl -0pi -e 's/\brd /rundown /g' packages/claude-code-plugin/__tests__/runbooks/end-to-end-test-runtime.integration.test.ts
```

- [ ] **Step 5: Run the skill tests to verify they pass**

Run:
```bash
cd packages/claude-code-plugin
pnpm exec jest __tests__/skills __tests__/content
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/claude-code-plugin/skills packages/claude-code-plugin/runbooks packages/claude-code-plugin/__tests__
git commit -m "docs(plugin): instruct \`rundown\` not \`rd\` in skills and runbooks (#459)"
```

---

### Task 4: Fix canonical docs wording and add the oh-my-zsh workaround

`README.md`, `docs/reference/cli.md`, and `CLAUDE.md` describe `rd` as an "alias" (imprecise — it's a duplicate bin) and instruct it. Correct the wording, document the collision, and give humans the one-line workaround. This task is **manual**, not a blind sweep — these files intentionally keep a `rd` mention (the workaround note).

**Files:**
- Modify: `README.md:126` (the "alias" sentence) and any `rd ` command examples in that file
- Modify: `docs/reference/cli.md:66` (the "alias" sentence) and its `rd ` examples
- Modify: `CLAUDE.md` — the "two equivalent binaries" sentence (line ~148) **and** its remaining `rd …` command examples (lines ~157, ~337-339, ~348)

**Interfaces:**
- Consumes: nothing.
- Produces: canonical docs recommend `rundown`, note the oh-my-zsh trap, and give `alias rd=rundown`.

- [ ] **Step 1: Rewrite the `README.md` wording (line ~126)**

Replace:
```markdown
The `rd` command is an alias for `rundown`.
```
with:
```markdown
Use `rundown` for every command. The package also installs a short `rd` binary
pointing at the same CLI, but oh-my-zsh ships a core `alias rd=rmdir` that
shadows it (shell aliases beat `PATH`), so **`rd` is unreliable** — prefer
`rundown`. On oh-my-zsh, restore the short name by adding `alias rd=rundown` to
`~/.zshrc` **after** oh-my-zsh loads.
```
Then sweep the command examples in `README.md` (the tables/code blocks) to `rundown`:
```bash
cd /Users/tobyhede/psrc/rundown
perl -0pi -e 's/\brd /rundown /g' README.md
```
Re-add the intentional `alias rd=rundown` / `rd` mentions if the sweep touched the new wording block (it will not, because that block has no `rd ` with a trailing space — `rd=rundown` and `` `rd` `` are boundary-safe). Verify:
```bash
grep -nE '\brd\b' README.md | grep -vE 'rundown|rdpath|rdx'
```
Expected: only the intentional collision-note mentions (`rd` binary, `alias rd=rundown`, `rd=rmdir`).

- [ ] **Step 2: Rewrite `docs/reference/cli.md` (line ~66) the same way**

Replace the `The \`rd\` command is an alias for \`rundown\`.` line with the same collision-aware paragraph as Step 1, then sweep its examples:
```bash
cd /Users/tobyhede/psrc/rundown
perl -0pi -e 's/\brd /rundown /g' docs/reference/cli.md
```
Verify residuals as in Step 1:
```bash
grep -nE '\brd\b' docs/reference/cli.md | grep -vE 'rundown|rdpath|rdx'
```
Expected: only the intentional collision-note mentions.

- [ ] **Step 3: Rewrite the `CLAUDE.md` binaries sentence (line ~148)**

Replace:
```markdown
`@rundown-org/cli` ships two equivalent binaries — `rundown` and its alias `rd`.
```
with:
```markdown
`@rundown-org/cli` ships two binaries — `rundown` and a short `rd` — pointing at
the same CLI. **Always instruct `rundown`**: oh-my-zsh's core `alias rd=rmdir`
shadows the `rd` bin (shell aliases beat `PATH`), so agent-facing docs, skills,
and runtime guidance MUST use `rundown`. Humans may restore `rd` with
`alias rd=rundown` after oh-my-zsh loads.
```

Then sweep the remaining `rd …` command examples elsewhere in `CLAUDE.md` (lines ~157 `` `rd pass`/`rd fail` ``, ~337-339 `rd run …`, ~348 `rd ls --all`). The new note block above is `\b`-safe (`alias rd=rundown`, `rd=rmdir`, and `` `rd` `` have no trailing space), so a boundary sweep leaves it intact:
```bash
cd /Users/tobyhede/psrc/rundown
perl -0pi -e 's/\brd /rundown /g' CLAUDE.md
```
Verify only intentional collision mentions remain:
```bash
grep -nE '\brd\b' CLAUDE.md | grep -vE 'rundown|rdpath|rdx|alias rd=|rd=rmdir'
```
Expected: empty (or only the `rd` bin / workaround mentions in the note block).

- [ ] **Step 4: Verify docs still build/lint and spelling passes**

Run:
```bash
cd /Users/tobyhede/psrc/rundown
pnpm run check:spell
```
Expected: PASS (add `omz`/`zshrc` to the dictionary only if the spell checker flags them; `oh-my-zsh` is hyphenated prose).

- [ ] **Step 5: Commit**

```bash
git add README.md docs/reference/cli.md CLAUDE.md
git commit -m "docs: recommend \`rundown\` over \`rd\`, document oh-my-zsh collision (#459)"
```

---

### Task 5: Sweep remaining descriptive reference docs

Lower-risk but agent-readable: descriptive docs that use `rd …` in examples. Prospective `docs/superpowers/` files are **out of scope** (write-once history).

**Files:**
- Modify: `docs/internal/scenarios.md`
- Modify: `docs/guides/agent-orchestration.md`
- Modify: `docs/spec/cli-output.md`
- (Sweep-and-verify any other `docs/{reference,internal,guides,spec}/**` file that still shows `rd ` commands.)

**Interfaces:**
- Consumes: nothing.
- Produces: descriptive docs use `rundown` in command examples.

- [ ] **Step 1: Enumerate the remaining descriptive-doc offenders**

Run:
```bash
cd /Users/tobyhede/psrc/rundown
grep -rlnE '(^|[`[:space:]])rd[[:space:]]' docs/reference docs/internal docs/guides docs/spec | grep -v superpowers
```
Expected: `scenarios.md`, `agent-orchestration.md`, `cli-output.md`, and possibly a few others. This is the worklist.

- [ ] **Step 2: Sweep each enumerated file**

Run (substitute the exact file list from Step 1):
```bash
cd /Users/tobyhede/psrc/rundown
perl -0pi -e 's/\brd /rundown /g' \
  docs/internal/scenarios.md \
  docs/guides/agent-orchestration.md \
  docs/spec/cli-output.md
```

- [ ] **Step 3: Verify no command-context `rd` remains outside superpowers**

Run:
```bash
cd /Users/tobyhede/psrc/rundown
grep -rnE '\brd\b' docs/reference docs/internal docs/guides docs/spec | grep -v superpowers | grep -vE 'rundown|rdpath|rdx|rdtk_|alias rd=|rd=rmdir'
```
Expected: empty (or only intentional collision mentions). Hand-fix any straggler.

- [ ] **Step 4: Spell check**

Run:
```bash
cd /Users/tobyhede/psrc/rundown
pnpm run check:spell
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs
git commit -m "docs: sweep descriptive reference docs from \`rd\` to \`rundown\` (#459)"
```

---

### Task 6: Full verification and PR

**Files:** none (verification only).

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a green `pnpm run verify` and an opened PR.

- [ ] **Step 1: Scoped residual check (edited surfaces only)**

This gate covers **only the files the plan edits** — every surface that emits agent-facing `rd`: plugin source, skills, runbooks, the specific CLI/MCP/core emitted-string files, the parser generated-command file, the in-scope docs, `README.md`, and `CLAUDE.md`. It deliberately does **not** scan `packages/{cli,core,mcp,parser}/src` *broadly*, because those trees also contain ~160 `rd` references in genuine developer **JSDoc/comments** (e.g. `delegate.ts:38` `@param … rd delegate`, `stop.ts:49`, `subprocess-mutation-boundary.ts:42` comment) that are non-agent-facing and out of scope. The distinction is emitted-string vs comment — every emitted-string file is named explicitly below so the gate still covers them.

The gate is **comment-blind by construction** — a trailing filter drops `//` and JSDoc `*` lines, so the ~20 developer-comment `rd` references across these files (out of scope) never register as survivors and no hand-maintained allowlist is needed. (Note the two filter choices: no `-o`, so full lines are printed and the comment filter has line content to match; and the comment filter matches only lines whose first non-space char after `file:line:` is `//`/`*`/`/*`. An *emitted* string line never starts that way — it starts with `console.error(`, `message:`, `return`, a quote, etc. — and every in-scope markdown file is whole-file swept by Tasks 3-5, so no genuine miss can hide behind this filter.)

Run:
```bash
cd /Users/tobyhede/psrc/rundown
grep -rnE '(^|[^A-Za-z0-9_])rd[[:space:]]' \
  packages/claude-code-plugin/src \
  packages/claude-code-plugin/skills \
  packages/claude-code-plugin/runbooks \
  packages/cli/src/cli.ts \
  packages/cli/src/commands/collect.ts \
  packages/cli/src/commands/run.ts \
  packages/cli/src/commands/delegate.ts \
  packages/cli/src/helpers/runbook-pipeline.ts \
  packages/cli/src/helpers/transitions.ts \
  packages/mcp/src/tools.ts \
  packages/core/src/errors/codes.ts \
  packages/core/src/errors/factory.ts \
  packages/core/src/runbook/command-target-resolver.ts \
  packages/core/src/runbook/collection-service.ts \
  packages/core/src/runbook/subprocess-mutation-boundary.ts \
  packages/core/src/runbook/session-lock.ts \
  packages/parser/src/parser.ts \
  docs/reference/cli.md docs/internal/scenarios.md docs/guides/agent-orchestration.md docs/spec/cli-output.md \
  README.md CLAUDE.md \
  | grep -vE 'rundown|rdpath|rdx|rdtk_|rd://|alias rd=|rd=rmdir' \
  | grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*)'   # drop // and JSDoc *-continuation comment lines
```
Expected: **empty.** Before the Task 1/1B/1C/3/5 edits this same command prints the 24 emitted-string lines that those tasks convert to `rundown`; once they are all converted, the `rundown|…` filter drops every one and the gate is genuinely empty. Any line that survives is a real missed agent-facing `rd` command — eyeball it to confirm it is not a comment (it won't be, given the filter), then fix it in the owning task's style and re-commit. One known non-gate item: the `\nrd claim` fixtures in `on-delegation-dispatch.test.ts` are hand-edited in Task 1 and are not in this file list. (A separate audit of purely developer-facing JSDoc `rd` → `rundown` across `cli`/`core`/`mcp`/`parser` comments is a reasonable out-of-scope follow-up; note it in the PR, do not let it block this gate.)

- [ ] **Step 2: Run the full verify suite**

Run:
```bash
cd /Users/tobyhede/psrc/rundown
pnpm run verify
```
Expected: PASS (format, spell, lint, unit tests). If the plugin package has a separate build step for skills/dist, run `pnpm run build` first so any generated `dist/runbooks` copies pick up the swept sources.

- [ ] **Step 3: Push the branch and open the PR**

```bash
cd /Users/tobyhede/psrc/rundown
git push -u origin HEAD
gh pr create --fill --title "fix: instruct \`rundown\` not \`rd\` to dodge oh-my-zsh \`rd=rmdir\` (#459)" \
  --body "Closes #459.

The two-letter \`rd\` bin is shadowed on every oh-my-zsh install by the core \`alias rd=rmdir\` (shell aliases beat PATH), so \`rd run …\` silently ran \`rmdir …\`. This switches all agent-facing content — runtime hook recovery strings, skills, runbooks, and reference docs — to the collision-proof full name \`rundown\`. The \`rd\` bin is kept for humans with clean shells; a new guard test (\`no-bare-rd-command.test.ts\`) prevents regressions, and the docs now carry the \`alias rd=rundown\` workaround."
```

---

## Self-Review

**Spec coverage** (issue #459 asks for a decision between options 1/2/3, with 3 as a stopgap):
- Option 2 (stop depending on `rd` in agent-facing content; standardize on `rundown`) — implemented across **every emitting surface**: Task 1 (plugin hooks/gates), Task 1B (CLI/MCP usage/error/hint strings), Task 1C (core error/refusal messages + parser generated command), Task 3 (skills/runbooks), Task 5 (descriptive docs). ✅
- Option 3 (document the collision + `alias rd=rundown` workaround) — implemented by Task 4. ✅
- Option 1 (rename the bin) — explicitly rejected per user decision; `package.json` bin untouched, and the `rd` detector in `internal-commands.ts` is preserved so the bin keeps working (Global Constraints). ✅
- Regression prevention (not in the issue, added for durability) — Task 2 guard test (skills/runbooks fenced blocks). ✅
- Every runtime string is paired with its pinning test — Task 1 (plugin hooks/gates), Task 1B (CLI/MCP), Task 1C (core/parser), Task 3 (skills). ✅
- **Emitted-string vs comment/detector distinction:** agent-facing `rd` in `cli`, `mcp`, and `core` runtime *messages* (usage, error `description`/`message`, refusals) is in scope (Tasks 1B/1C); the `rd` *detector* (`internal-commands.ts`), the `rd://` artifact scheme, and pure developer *JSDoc/comments* are deliberately excluded. Earlier drafts wrongly lumped core's error messages in with "JSDoc" — corrected: those messages (notably the high-frequency "no runbook running" error and the bare-transition refusals) are agent-facing and are handled by Task 1C. ✅

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". The one deliberately templated element is the file list in Task 5 Step 2, which is generated by Step 1's `grep` and shown with the known-current files — the plan instructs substituting the actual Step-1 output. Every code/test edit shows exact content or an exact boundary-anchored command plus a verifying grep. ✅

**Type/name consistency:** New symbols: `bareRdCommands`, `markdownFiles`, `fencedBlocks`, `Match` in `no-bare-rd-command.test.ts` (self-contained, mirrors the existing `json-default-output.test.ts` shapes). No cross-task function signatures introduced. The emitted-string contract (`rundown claim <token>`, `rundown <verb> --claim-id <claim_id>`) is identical between Task 1's source edits and its test edits because both derive from the same `\brd ` → `rundown ` transform. ✅

**Known risk verified during investigation:** `isInternalRdCommand`/`parseRdCommand` (`packages/cli/src/services/internal-commands.ts:32-35`) already accept both `rd` and `rundown`, and the plugin does **not** classify Bash commands by name for gate decisions (`minimal-dispatch.contract.test.ts:72` documents that PreToolUse(Bash) is no longer routed). So switching guidance text to `rundown` has no functional coupling to command detection or gate behavior — it is a text/instruction change only.
