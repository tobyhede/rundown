import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import {
  bareRoleSpecificMutation,
  delegateClaimIdRejectionMessage,
  delegateClaimIdValidationError,
  mutationCommandAliases,
  subprocessMutationWithheldMessage,
  DELEGATE_CLAIM_ID_REJECTED_CODE,
  GLOBAL_VALUE_TAKING_OPTION_NAMES,
  PASS_FAIL_VALUE_TAKING_OPTION_NAMES,
  SUBPROCESS_MUTATION_WITHHELD_CODE,
} from '../../src/runbook/subprocess-mutation-boundary.js';

// Subprocess trust boundary coverage. A plugin/MCP front end spawns the CLI, so
// a bare (default-target) `rd pass` / `rd fail` / `rd delegate` would silently
// inherit direct-CLI trust. `bareRoleSpecificMutation` is the single source of
// truth for which spawned argv must be withheld; `--claim-id` mutations carry
// independent claim evidence and must survive the boundary.

describe('bareRoleSpecificMutation', () => {
  it.each([
    [['pass'], 'pass'],
    [['fail'], 'fail'],
    [['delegate'], 'delegate'],
    [['pass', '--step', '2.1'], 'pass'],
    [['fail', '--step', '2.1', '--index', '3'], 'fail'],
    [['delegate', 'child.md', '--step', '1.1'], 'delegate'],
  ])('classifies %j as a bare mutation of %s', (argv, expected) => {
    expect(bareRoleSpecificMutation(argv)).toBe(expected);
  });

  it.each([
    [['pass', '--claim-id', 'claim-1']],
    [['fail', '--claim-id', 'claim-1']],
    [['pass', '--claim-id=claim-1']],
    [['fail', '--step', '2.1', '--claim-id', 'claim-1']],
    // Legitimate delegation-workflow completion forms must stay exempt.
    [['pass', '--claim-id', 'rdclm_x']],
    [['fail', '--claim-id=rdclm_x']],
    [['pass', '--claim-id', 'rdclm_x', '--text']],
  ])('does not withhold the claim-evidence mutation %j', (argv) => {
    expect(bareRoleSpecificMutation(argv)).toBeUndefined();
  });

  it.each([
    // `--claim-id=foo` is consumed as the value of `--step`, not a real flag.
    [['pass', '--step', '--claim-id=foo'], 'pass'],
    // `--claim-id` here is the value of `--step`; the trailing `foo` is then a
    // bare positional. No claim-id is in flag position -> withhold (fail closed).
    [['pass', '--step', '--claim-id', 'foo'], 'pass'],
    // Same option-value misread for `--index`.
    [['fail', '--index', '--claim-id=foo'], 'fail'],
  ])('withholds %j because the --claim-id token is a consumed option value, not evidence', (argv, expected) => {
    expect(bareRoleSpecificMutation(argv)).toBe(expected);
  });

  it.each([
    [['delegate', '--claim-id', 'claim-1']],
    [['delegate', '--claim-id=claim-1']],
    [['delegate', 'child.md', '--claim-id', 'claim-1']],
    // Headline exploit: `--claim-id=foo` here is the value of `--input-file`, but
    // `delegate` is claim-less and must ALWAYS be withheld regardless.
    [['delegate', 'child.md', '--input-file', '--claim-id=foo']],
  ])('still withholds delegate even with --claim-id %j', (argv) => {
    // `delegate` has no claim form, so a stray `--claim-id` cannot exempt it.
    expect(bareRoleSpecificMutation(argv)).toBe('delegate');
  });

  it.each([
    [['status']],
    [['status', '--claim-id', 'claim-1']],
    [['ls', '--all']],
    [['run', 'workflow.md']],
    [['claim', 'rd_tok_abc']],
    [['collect']],
    [['goto', '3.1']],
    [[]],
  ])('does not withhold the non-role-specific call %j', (argv) => {
    expect(bareRoleSpecificMutation(argv)).toBeUndefined();
  });

  it.each([
    [['complete'], 'complete'],
    [['complete', 'done'], 'complete'],
    [['stop'], 'stop'],
    [['stop', 'Aborting'], 'stop'],
  ])('classifies bare terminal command %j as a withheld %s', (argv, expected) => {
    expect(bareRoleSpecificMutation(argv)).toBe(expected);
  });

  it.each([
    [['complete', '--claim-id', 'claim-1']],
    [['stop', '--claim-id=claim-1']],
    [['complete', '--claim-id', 'rdclm_x', '--text']],
  ])('does not withhold the claim-evidence terminal mutation %j', (argv) => {
    expect(bareRoleSpecificMutation(argv)).toBeUndefined();
  });

  it.each([
    // After the `--` option terminator, `--claim-id` is positional content, not
    // a flag: the mutation stays bare and withheld (pairs with carriesClaimEvidence).
    [['pass', '--', '--claim-id', 'claim-1'], 'pass'],
    [['fail', '--', '--claim-id=claim-1'], 'fail'],
  ])('withholds %j because --claim-id after `--` is positional, not evidence', (argv, expected) => {
    expect(bareRoleSpecificMutation(argv)).toBe(expected);
  });

  it('withholds a bare `pass` alias (yes) as its canonical command', () => {
    expect(bareRoleSpecificMutation(['yes'])).toBe('pass');
  });

  it.each([
    // Aliases canonicalize to their command: a subprocess front end must not
    // bypass the boundary by spawning `rd yes` / `rd ok` / `rd no` instead of
    // `rd pass` / `rd fail` (Commander canonicalizes them after spawn).
    [['ok'], 'pass'],
    [['no'], 'fail'],
    [['yes', '--step', '2.1'], 'pass'],
  ])('withholds the bare alias mutation %j as its canonical command', (argv, expected) => {
    expect(bareRoleSpecificMutation(argv)).toBe(expected);
  });

  it.each([
    // An alias carrying real claim evidence is reconstructable CLI-side, so it
    // passes through exactly like its canonical command would.
    [['yes', '--claim-id', 'claim-1']],
    [['no', '--claim-id=claim-1']],
  ])('does not withhold the claim-evidence alias mutation %j', (argv) => {
    expect(bareRoleSpecificMutation(argv)).toBeUndefined();
  });

  it('withholds every bare alias as its canonical command (property)', () => {
    // For each canonical mutation, every registered alias must normalize back to
    // it so no alias form can slip a bare mutation past the boundary.
    const aliasPairs = (['pass', 'fail', 'delegate', 'complete', 'stop'] as const).flatMap(
      (canonical) => mutationCommandAliases(canonical).map((alias) => [alias, canonical] as const),
    );
    // complete/stop/delegate have no aliases; the > 0 guard still holds via pass/fail.
    expect(aliasPairs.length).toBeGreaterThan(0);
    fc.assert(
      fc.property(
        fc.constantFrom(...aliasPairs),
        fc.array(
          fc.string().filter((s) => s !== '--claim-id' && !s.startsWith('--claim-id=')),
          { maxLength: 4 },
        ),
        ([alias, canonical], extra) => {
          expect(bareRoleSpecificMutation([alias, ...extra])).toBe(canonical);
        },
      ),
    );
  });

  it('never withholds pass/fail/complete/stop that carries --claim-id (property)', () => {
    // `extra` excludes value-taking space options so the trailing `--claim-id`
    // lands in flag position (not consumed as a preceding option's value, and
    // not pushed past the `--` terminator into positional content).
    const notBeforeClaimFlag = (s: string) =>
      s !== '--' && s !== '--step' && s !== '--index' && s !== '--claim-id';
    fc.assert(
      fc.property(
        fc.constantFrom('pass', 'fail', 'complete', 'stop'),
        fc.array(fc.string().filter(notBeforeClaimFlag), { maxLength: 4 }),
        fc.string(),
        (command, extra, claimId) => {
          const argv = [command, ...extra, '--claim-id', claimId];
          expect(bareRoleSpecificMutation(argv)).toBeUndefined();
        },
      ),
    );
  });

  it('always withholds delegate even when it carries --claim-id (property)', () => {
    // `delegate` has no claim form, so claim evidence cannot exempt it.
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 4 }), fc.string(), (extra, claimId) => {
        const argv = ['delegate', ...extra, '--claim-id', claimId];
        expect(bareRoleSpecificMutation(argv)).toBe('delegate');
      }),
    );
  });

  it('withholds bare pass/fail/delegate regardless of extra non-claim args (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('pass', 'fail', 'delegate'),
        fc.array(
          fc.string().filter((s) => s !== '--claim-id' && !s.startsWith('--claim-id=')),
          { maxLength: 5 },
        ),
        (command, extra) => {
          expect(bareRoleSpecificMutation([command, ...extra])).toBe(command);
        },
      ),
    );
  });
});

describe('bareRoleSpecificMutation: program-level (global) options before the command', () => {
  // The rundown CLI accepts program-level options BEFORE the subcommand (e.g.
  // `rundown --deny-all pass`). The boundary must locate the ACTUAL command
  // token — skipping recognized global options and the values they consume —
  // before classifying. Examining only argv[0] lets a subprocess front end
  // launder direct-CLI trust: `--deny-all pass` reads argv[0]=`--deny-all`,
  // which is not a mutation, so the bare `pass` would slip through (fail open).

  it.each([
    // Boolean global before the command: command is at index 1.
    [['--deny-all', 'pass'], 'pass'],
    [['--no-color', 'fail'], 'fail'],
    [['--no-color', 'delegate'], 'delegate'],
    [['--sandbox', 'pass'], 'pass'],
    // Value-taking global (space form): consumes its value token, command at 2.
    [['--policy', 'x.json', 'pass'], 'pass'],
    [['--allow-run', 'echo', 'fail'], 'fail'],
    // Value-taking global (inline `=` form): single token, command at 1.
    [['--policy=x.json', 'fail'], 'fail'],
    [['--helpers=a.js', 'pass'], 'pass'],
    // Aliases still canonicalize behind globals.
    [['--deny-all', 'yes'], 'pass'],
    [['--no-color', 'no'], 'fail'],
    // Stacked globals before the command.
    [['--no-color', '--policy', 'x.json', '--deny-all', 'pass'], 'pass'],
  ])('withholds %j as a bare mutation of %s located behind globals', (argv, expected) => {
    expect(bareRoleSpecificMutation(argv)).toBe(expected);
  });

  it.each([
    // A non-mutation command after globals must NOT be over-withheld.
    [['--no-color', 'status']],
    [['--policy', 'x.json', 'status']],
    [['--deny-all', 'ls', '--all']],
    // `pass` as a `run` filename argument is not a command-position `pass`.
    [['--no-color', 'run', 'pass.md']],
    // `pass` as a `goto` step target is not a command-position `pass`.
    [['--no-color', 'goto', 'pass']],
    // A mutation's legitimate `--claim-id` still exempts it behind globals.
    [['--no-color', 'pass', '--claim-id', 'c']],
    [['--policy', 'x.json', 'fail', '--claim-id=c']],
  ])('does not withhold the non-bare call %j behind globals', (argv) => {
    expect(bareRoleSpecificMutation(argv)).toBeUndefined();
  });

  it.each([
    // The value-skip discipline still prevents smuggling behind globals: the
    // trailing `--claim-id=x` is consumed as `--step`'s value, not evidence.
    [['--no-color', 'pass', '--step', '--claim-id=x'], 'pass'],
    [['--policy', 'x.json', 'fail', '--index', '--claim-id', 'x'], 'fail'],
  ])('still withholds %j where --claim-id is a consumed value, not evidence', (argv, expected) => {
    expect(bareRoleSpecificMutation(argv)).toBe(expected);
  });

  it.each([
    // Fail-closed: an UNRECOGNIZED leading flag must not abort the scan and let
    // a following bare mutation slip through. Such argv never dispatches a real
    // mutation (commander rejects unknown global options), so withholding is safe.
    [['--unknown-flag', 'pass'], 'pass'],
    [['--unknown-flag', 'delegate'], 'delegate'],
  ])('fails closed on unrecognized leading flag %j', (argv, expected) => {
    expect(bareRoleSpecificMutation(argv)).toBe(expected);
  });
});

describe('PASS_FAIL_VALUE_TAKING_OPTION_NAMES (single source of truth)', () => {
  it('pins the canonical value-taking option names', () => {
    // The CLI's pass/fail registration derives its `.option(...)` calls from this
    // exact list (see transition-option-single-source.test.ts in the CLI). Pin it
    // here so a deliberate surface change is a visible, reviewed edit.
    expect([...PASS_FAIL_VALUE_TAKING_OPTION_NAMES]).toEqual(['--step', '--index', '--claim-id']);
  });

  it('every non-claim listed option causes its consumed value to be skipped by the claim scanner', () => {
    // For each value-taking option that is NOT `--claim-id` itself, a
    // `--claim-id=foo` sitting in that option's value slot is NOT real claim
    // evidence: the scanner must skip it and treat the pass/fail as bare
    // (withheld). This is exactly what protects against a future option (e.g.
    // `--note`) added to the list smuggling claim trust through its value slot.
    // `--claim-id` itself, by contrast, IS evidence in flag position (covered
    // below), so it is excluded from the value-slot smuggling case.
    for (const option of PASS_FAIL_VALUE_TAKING_OPTION_NAMES) {
      if (option === '--claim-id') continue;
      expect(bareRoleSpecificMutation(['pass', option, '--claim-id=foo'])).toBe('pass');
      expect(bareRoleSpecificMutation(['fail', option, '--claim-id', 'foo'])).toBe('fail');
    }
    // `--claim-id` in flag position is genuine evidence, not a smuggled value.
    expect(bareRoleSpecificMutation(['pass', '--claim-id', '--claim-id=foo'])).toBeUndefined();
  });

  it('a real --claim-id flag in flag position is still honoured for every preceding value option', () => {
    // Sanity counter-case: when the value-taking option consumes its OWN value and
    // a separate `--claim-id` follows in flag position, the mutation is exempt.
    for (const option of PASS_FAIL_VALUE_TAKING_OPTION_NAMES) {
      if (option === '--claim-id') continue;
      expect(
        bareRoleSpecificMutation(['pass', option, 'someValue', '--claim-id', 'rdclm_x']),
      ).toBeUndefined();
    }
  });
});

describe('mutationCommandAliases', () => {
  it.each([
    ['pass', ['yes', 'ok']],
    ['fail', ['no']],
    ['delegate', []],
    // Terminal commands carry NO aliases (decision #5): `done` is the [message]
    // positional, not an alias — pin the no-alias contract so a regression fails here.
    ['complete', []],
    ['stop', []],
  ] as const)('exposes the canonical alias set for %s', (command, expected) => {
    // Single source of truth consumed by the CLI command registration. Changing
    // these is a deliberate surface change, so pin them here.
    expect(mutationCommandAliases(command)).toEqual(expected);
  });
});

describe('subprocessMutationWithheldMessage', () => {
  it('names the command and never mentions a source label', () => {
    for (const command of ['pass', 'fail', 'delegate'] as const) {
      const message = subprocessMutationWithheldMessage(command);
      expect(message).toContain(`rd ${command}`);
      expect(message).toContain('--claim-id');
      expect(message).not.toMatch(/actor-source|RD_ACTOR_SOURCE/i);
    }
  });

  it('exposes a stable withheld code', () => {
    expect(SUBPROCESS_MUTATION_WITHHELD_CODE).toBe('SUBPROCESS_MUTATION_WITHHELD');
  });
});

describe('delegateClaimIdValidationError', () => {
  it.each([
    ['delegate', '--claim-id', 'claim-1'],
    ['delegate', '--claim-id=claim-1'],
    ['delegate', 'child.md', '--input-file', '--claim-id=foo'],
  ])('rejects claim-id-looking delegate argv %j', (...argv) => {
    expect(delegateClaimIdValidationError(argv)).toEqual({
      code: DELEGATE_CLAIM_ID_REJECTED_CODE,
      message: delegateClaimIdRejectionMessage(),
    });
  });

  it.each([
    [['pass', '--claim-id', 'claim-1']],
    [['fail', '--claim-id=claim-1']],
    [['delegate', 'child.md', '--input-file', './--claim-id=foo']],
  ])('does not reject non-delegate or escaped value argv %j', (argv) => {
    expect(delegateClaimIdValidationError(argv)).toBeUndefined();
  });

  it.each([
    // The delegate command may sit behind program-level globals; the scan must
    // locate it at its real index before rejecting `--claim-id`.
    [['--deny-all', 'delegate', '--claim-id', 'x']],
    [['--policy', 'x.json', 'delegate', '--claim-id=x']],
  ])('rejects claim-id on delegate located behind globals %j', (argv) => {
    expect(delegateClaimIdValidationError(argv)).toEqual({
      code: DELEGATE_CLAIM_ID_REJECTED_CODE,
      message: delegateClaimIdRejectionMessage(),
    });
  });

  it.each([
    // `--claim-id` on a non-delegate command behind globals is not a delegate
    // rejection (it is honoured as claim evidence by bareRoleSpecificMutation).
    [['--no-color', 'pass', '--claim-id', 'x']],
  ])('does not reject claim-id on a non-delegate command behind globals %j', (argv) => {
    expect(delegateClaimIdValidationError(argv)).toBeUndefined();
  });
});

describe('GLOBAL_VALUE_TAKING_OPTION_NAMES (single source of truth)', () => {
  it('pins the value-taking program-level option names', () => {
    // The CLI program registration is pinned to this exact set by
    // program-level-option-single-source.test.ts in the CLI. A new value-taking
    // global must be added here (teaching the command-token scanner that it
    // consumes a value) or the CLI drift-guard test fails the build.
    expect([...GLOBAL_VALUE_TAKING_OPTION_NAMES].sort()).toEqual(
      [
        '--allow-env',
        '--allow-read',
        '--allow-run',
        '--allow-write',
        '--helpers',
        '--policy',
      ].sort(),
    );
  });
});
