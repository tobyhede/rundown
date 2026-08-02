import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Command } from 'commander';
import { TestWriter, setWriter, type OutputWriter } from '@rundown-org/core';

const abortDelegation = jest.fn<() => Promise<Record<string, unknown>>>();

jest.unstable_mockModule('../../src/helpers/lifecycle-seam-factory.js', () => ({
  buildNonDelegatingLifecycleSeam: () => ({ seam: { abortDelegation } }),
}));

const { registerAbortCommand } = await import('../../src/commands/abort.js');
const TOKEN = `rdtk_${'A'.repeat(32)}`;

describe('abort command transactional refusals', () => {
  let previousWriter: OutputWriter;

  beforeEach(() => {
    previousWriter = setWriter(new TestWriter());
    process.exitCode = undefined;
  });

  afterEach(() => {
    setWriter(previousWriter);
    process.exitCode = undefined;
    abortDelegation.mockReset();
  });

  it.each([
    {
      kind: 'execution_in_progress',
      runId: `rd_${'1'.repeat(32)}`,
      epoch: 1,
      message: 'execution in progress',
    },
    {
      kind: 'recovery_required',
      runId: `rd_${'2'.repeat(32)}`,
      epoch: 2,
      message: 'recovery required',
    },
    {
      kind: 'claim_superseded',
      runId: `rd_${'3'.repeat(32)}`,
      message: 'claim superseded',
    },
    {
      kind: 'concurrent_modification',
      runId: `rd_${'4'.repeat(32)}`,
      message: 'concurrent modification',
    },
    {
      kind: 'missing',
      runId: `rd_${'5'.repeat(32)}`,
      message: 'run missing',
    },
    {
      kind: 'aggregate_recovery_required',
      message: 'aggregate recovery required',
      attempts: [{ runId: `rd_${'6'.repeat(32)}`, epoch: 3 }],
    },
  ])('renders $kind as a command refusal', async (outcome) => {
    abortDelegation.mockResolvedValue(outcome);
    const program = new Command().exitOverride();
    registerAbortCommand(program);

    await program.parseAsync(['node', 'rundown', 'abort', TOKEN]);

    expect(process.exitCode).toBe(1);
  });
});
