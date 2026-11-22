import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Command } from 'commander';
import { TestWriter, generateOwnerToken, setWriter, type OutputWriter } from '@rundown-org/core';
import type { SeamTransitionResult } from '../../src/helpers/transitions.js';

// The shared body of `pass` and `fail` ends in one branch — the exit-code
// mapping — and nothing pinned either arm: both `ConditionalExpression`
// mutations on it survived, so the command could have exited 1 on every
// transition, or 0 on every transition, with the suite still green.
//
// Only the seam is substituted. The real config factories stay reachable, so
// the commands under test are registered exactly as `pass.ts` and `fail.ts`
// register them rather than against a hand-built definition that could drift
// from either.
//
// Do not read this file's mutation score as its coverage. Stryker credits NO
// test with killing anything in `transition-command.ts` — not this suite, and
// not `fail.test.ts`, which asserts both exit codes twenty times over — while
// applying either mutation to the source by hand fails the cases below. The
// mutants are reported covered and then have no effect, so the module reads as
// 0.00% however it is tested. Verify a change here by editing the branch and
// watching this suite fail, not by re-running Stryker.
const actualTransitions = await import('../../src/helpers/transitions.js');
const runSeamTransition = jest.fn<() => Promise<SeamTransitionResult>>();
jest.unstable_mockModule('../../src/helpers/transitions.js', () => ({
  ...actualTransitions,
  runSeamTransition,
}));

const { registerPassCommand } = await import('../../src/commands/pass.js');
const { registerFailCommand } = await import('../../src/commands/fail.js');

const COMMANDS = [
  { name: 'pass', register: registerPassCommand },
  { name: 'fail', register: registerFailCommand },
] as const;

// A well-formed Owner Token so the command reaches the (mocked) seam; the
// token-option parser refuses a bare or malformed one before it.
const TOKEN = generateOwnerToken();

describe('transition command exit-code mapping', () => {
  let previousWriter: OutputWriter;
  let exitSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    previousWriter = setWriter(new TestWriter());
    process.exitCode = undefined;
    // No arm exercised here calls the hard exit — the option-validation and
    // target-parsing failures that do are refused before the seam runs. Turning
    // a stray one into a throw keeps it attributable instead of killing the
    // worker.
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${String(code)})`);
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    setWriter(previousWriter);
    process.exitCode = undefined;
    runSeamTransition.mockReset();
  });

  it.each(COMMANDS)(
    '$name refuses a bare invocation before the seam',
    async ({ name, register }) => {
      const program = new Command().exitOverride();
      register(program);

      await program.parseAsync(['node', 'rundown', name, '--step', '1']);

      expect(runSeamTransition).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    },
  );

  it.each(COMMANDS)(
    '$name exits non-zero when the seam reports an exit error',
    async ({ name, register }) => {
      runSeamTransition.mockResolvedValue({ exitError: true });
      const program = new Command().exitOverride();
      register(program);

      await program.parseAsync(['node', 'rundown', name, '--token', TOKEN, '--step', '1']);

      // Pinned BEFORE the exit code, because the exit code alone cannot tell
      // this branch from a refusal that never reached the seam: option
      // validation and the `--token` parser set `process.exitCode = 1`
      // themselves and return early. Without this, a mutant anywhere in the pre-seam path leaves
      // this case green while the branch it exists to pin never runs.
      expect(runSeamTransition).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
    },
  );

  it.each(COMMANDS)(
    '$name clears a code already set in this process when the seam reports none',
    async ({ name, register }) => {
      // The else arm is not "leave it alone": a handled failure (FAIL ANY
      // CONTINUE) must exit 0 even when something earlier in this same process
      // set a non-zero code. A pre-set code is therefore the only setup under
      // which this arm's assignment is observable at all.
      process.exitCode = 1;
      runSeamTransition.mockResolvedValue({ exitError: false });
      const program = new Command().exitOverride();
      register(program);

      await program.parseAsync(['node', 'rundown', name, '--token', TOKEN, '--step', '1']);

      expect(process.exitCode).toBeUndefined();
    },
  );
});
