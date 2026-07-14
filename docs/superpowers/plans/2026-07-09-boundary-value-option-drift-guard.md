# Drift guard: pin the subprocess boundary skip set to the CLI option surface

## Context

`SUBPROCESS_BOUNDARY_VALUE_TAKING_OPTIONS` (`packages/core/src/runbook/subprocess-mutation-boundary.ts:152`)
is the skip list the claim scanner uses to step over an option's consumed value
token. Its own inline comment states the stakes:

> without them a `delegate --artifacts --claim-id=foo` would misread
> `--claim-id=foo` (the value of `--artifacts`) as real claim evidence and
> **fail OPEN**, letting a bare delegate slip past the boundary.

The set MUST remain a superset of the value-taking option surface of every
command the scanner actually scans. Today it is — but **nothing enforces that
mechanically.** Adding a value-taking option to `delegate` (e.g.
`--note <text>`) would silently open a claim-id smuggling slot, with no compile
error and no failing test.

This is precisely the drift that produced the Critical finding in PR #585: the
`--artifacts` / `--artifacts-json` entries were added to the set *reactively*,
after CodeRabbit spotted the fail-open gap. A guard would have caught it at the
commit that introduced `--artifacts`.

Sibling invariants already have exactly this kind of CLI-introspection guard:

- `packages/cli/__tests__/helpers/program-level-option-single-source.test.ts`
- `packages/cli/__tests__/helpers/transition-option-single-source.test.ts`
- `packages/cli/__tests__/helpers/transition-target-single-source.test.ts`

The `delegate`-inclusive value-slot surface has none. This plan adds it.

## Findings that shape the design

Verified against HEAD `6bb884a84`:

1. **The set is module-private** — not exported from its own module, and absent
   from the re-export list in `packages/core/src/runbook/index.ts:126-139`.
   It must be exported to be testable from the CLI package.

2. **`claim` is never scanned.** `bareRoleSpecificMutation`
   (`subprocess-mutation-boundary.ts:349`) short-circuits before
   `carriesClaimEvidence` unless `canonicalMutationCommand` resolves the token,
   and that resolver only recognises the seven `RoleSpecificMutationCommand`s
   (`pass`, `fail`, `delegate`, `goto`, `complete`, `stop`, `collect`).
   The set's inline comment saying "`delegate` (and `claim`)" is misleading —
   `claim`'s options are in the set incidentally, not because it is scanned.
   **The guard therefore covers the seven scanned commands only.** (Including
   `claim` would not change the union anyway; its five value options are a
   subset of `delegate`'s.)

3. **The union already equals the set exactly.** Across the seven:
   `--artifacts`, `--artifacts-json`, `--claim-id`, `--index`, `--input`,
   `--input-file`, `--input-json`, `--run`, `--step`. So both assertions are
   green on arrival.

4. **Stale TSDoc.** The comment above `PASS_FAIL_VALUE_TAKING_OPTION_NAMES`
   (`:130`) references `{@link PASS_FAIL_VALUE_TAKING_OPTIONS}` — a symbol that
   does not exist in the file. The real derived set is
   `SUBPROCESS_BOUNDARY_VALUE_TAKING_OPTIONS`.

5. **Registrars are safe to introspect.** All seven are `(program: Command) =>
   void`, side-effect-free at registration time (heavy core services are
   constructed only inside the `.action(...)` callback). Global options live on
   the root program, never on subcommands, so a subcommand-scoped `.options`
   read is clean.

## Changes

### 1. `packages/core/src/runbook/subprocess-mutation-boundary.ts`

Export the set and give it a real TSDoc block (CLAUDE.md requires TSDoc on all
exported symbols). Fold the existing inline comment into it, correct the
misleading "(and `claim`)" aside, and name the new guard so the invariant is
discoverable from the definition:

```ts
/**
 * Long names of every space-form value-taking option across all
 * {@link RoleSpecificMutationCommand}s. **Single source of truth** for the claim
 * scanner's value-slot skip list.
 *
 * MUST remain a superset of the value-taking option surface of every scanned
 * mutation command. An option missing from it leaves the scanner blind to a
 * smuggling slot: `delegate --artifacts --claim-id=foo` would misread
 * `--claim-id=foo` (the *value* of `--artifacts`) as real claim evidence and
 * fail OPEN, letting a bare delegate slip past the boundary.
 *
 * Pinned mechanically by the CLI drift guard
 * `packages/cli/__tests__/helpers/mutation-command-value-option-single-source.test.ts`.
 *
 * Boolean options (`--text`, `--retry`) consume nothing and are intentionally
 * absent. Equals-forms (`--step=...`) consume their value inline in one token
 * and need no skip — only space-forms advance past the next token.
 */
export const SUBPROCESS_BOUNDARY_VALUE_TAKING_OPTIONS: ReadonlySet<string> = ...
```

Also fix the dangling `{@link PASS_FAIL_VALUE_TAKING_OPTIONS}` at `:130` to
point at `SUBPROCESS_BOUNDARY_VALUE_TAKING_OPTIONS`.

Note the `--input*` / `--artifacts*` literals stay as literals: they are
`delegate`'s surface, and the guard is what proves the list complete. Do not
try to derive them from a CLI import — core must not depend on the CLI.

### 2. `packages/core/src/runbook/index.ts`

Add `SUBPROCESS_BOUNDARY_VALUE_TAKING_OPTIONS` to the existing re-export list at
`:126-139`. `packages/core/src/index.ts:44` is `export * from './runbook/index.js'`,
so no change is needed there.

### 3. New: `packages/cli/__tests__/helpers/mutation-command-value-option-single-source.test.ts`

Two tests, per the "both assertions" decision.

Key structural choice — **type-driven exhaustiveness**. Key the registrar map by
the `RoleSpecificMutationCommand` union so a newly added mutation command fails
to compile until it is wired into the guard. This satisfies CLAUDE.md's
type-driven dispatch principle and closes the guard's own drift vector:

```ts
const MUTATION_COMMAND_REGISTRARS: Record<
  RoleSpecificMutationCommand,
  (program: Command) => void
> = {
  pass: registerPassCommand,
  fail: registerFailCommand,
  delegate: registerDelegateCommand,
  goto: registerGotoCommand,
  complete: registerCompleteCommand,
  stop: registerStopCommand,
  collect: registerCollectCommand,
};
```

Reuse the value-arity detector already established by the sibling guards — an
option takes a value iff `option.required || option.optional` (Commander sets
these for `<v>` and `[v]` respectively; boolean flags have both `false`):

```ts
function registeredValueTakingOptionLongs(register: (p: Command) => void): string[] {
  const program = new Command();
  register(program);
  const command = program.commands[0];
  if (!command) throw new Error('expected a subcommand to be registered');
  return command.options
    .filter((option: Option) => option.required || option.optional)
    .map((option: Option) => option.long)
    .filter((long): long is string => long !== undefined)
    .sort();
}
```

**Test 1 — security direction, per command.** For each of the seven, every
registered value-taking option must be a member of the boundary set. Iterating
per command means the failure message names the offender (`delegate grew
--note`) rather than diffing two anonymous arrays.

**Test 2 — rot direction, union.** The union across the seven must equal the
boundary set exactly, catching entries in the set that no command registers.

Open the file with a comment explaining the fail-open consequence, matching the
tone of `transition-option-single-source.test.ts:7-19`.

## Verification

```bash
# the guard itself
pnpm --filter @rundown-org/cli test -- mutation-command-value-option-single-source

# nothing else regressed (the set is newly exported; core barrel changed)
pnpm --filter @rundown-org/core test
pnpm --filter @rundown-org/cli test

# pre-PR gate
pnpm run verify
```

**Negative check — prove the guard actually bites.** A guard that cannot fail is
worthless, so confirm it fails before trusting it:

1. Temporarily add `.option('--note <text>', 'scratch')` to `registerDelegateCommand`
   (`packages/cli/src/commands/delegate.ts:159`).
2. Re-run the guard — Test 1 MUST fail naming `delegate` and `--note`.
3. Temporarily add a dead `'--zzz'` entry to the boundary set.
4. Re-run — Test 2 MUST fail on the union mismatch.
5. Revert both.

Do not skip this. It is the only evidence the guard is wired to the real
Commander surface rather than to a stale literal.

## Out of scope

- Extending the guard to `claim` — it is not scanned by the boundary, so its
  option surface carries no smuggling risk. Revisit only if `claim` is ever
  added to `ROLE_SPECIFIC_MUTATION_COMMANDS`.
- Any change to the scanner logic in `carriesClaimEvidence` — the current set is
  already correct; this plan pins it, it does not fix it.
