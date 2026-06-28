import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import {
  bareRoleSpecificMutation,
  subprocessMutationWithheldMessage,
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

  it('never withholds pass/fail that carries --claim-id (property)', () => {
    // `extra` excludes value-taking space options so the trailing `--claim-id`
    // lands in flag position (not consumed as a preceding option's value).
    const valueTakingOption = (s: string) =>
      s === '--step' || s === '--index' || s === '--claim-id';
    fc.assert(
      fc.property(
        fc.constantFrom('pass', 'fail'),
        fc.array(
          fc.string().filter((s) => !valueTakingOption(s)),
          { maxLength: 4 },
        ),
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
