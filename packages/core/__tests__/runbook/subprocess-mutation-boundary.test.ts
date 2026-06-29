import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import {
  bareRoleSpecificMutation,
  delegateClaimIdRejectionMessage,
  delegateClaimIdValidationError,
  mutationCommandAliases,
  subprocessMutationWithheldMessage,
  DELEGATE_CLAIM_ID_REJECTED_CODE,
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
    [['complete', 'done']],
    [['stop']],
    [[]],
  ])('does not withhold the non-role-specific call %j', (argv) => {
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
    const aliasPairs = (['pass', 'fail', 'delegate'] as const).flatMap((canonical) =>
      mutationCommandAliases(canonical).map((alias) => [alias, canonical] as const),
    );
    // `delegate` has no aliases today; guard the property against a vacuous pass.
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

  it('never withholds pass/fail that carries --claim-id (property)', () => {
    // `extra` excludes value-taking space options so the trailing `--claim-id`
    // lands in flag position (not consumed as a preceding option's value, and
    // not pushed past the `--` terminator into positional content).
    const notBeforeClaimFlag = (s: string) =>
      s !== '--' && s !== '--step' && s !== '--index' && s !== '--claim-id';
    fc.assert(
      fc.property(
        fc.constantFrom('pass', 'fail'),
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

describe('mutationCommandAliases', () => {
  it.each([
    ['pass', ['yes', 'ok']],
    ['fail', ['no']],
    ['delegate', []],
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
});
