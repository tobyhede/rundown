import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCliInProcess, type TestWorkspace } from '../helpers/test-utils.js';

const CLAIM_ID =
  'rdclm_00000000000000000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const RUN_ID = `rd_${'1'.repeat(32)}`;

const cases: ReadonlyArray<{
  readonly command: string;
  readonly argv: readonly string[];
}> = [
  { command: 'pass', argv: ['pass'] },
  { command: 'fail', argv: ['fail'] },
  { command: 'goto', argv: ['goto', '1'] },
  { command: 'collect', argv: ['collect'] },
  { command: 'delegate', argv: ['delegate'] },
  { command: 'complete', argv: ['complete'] },
  { command: 'stop', argv: ['stop'] },
];

describe('--claim-id and --run ambiguity rejection', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it.each(cases)('$command rejects --claim-id combined with --run', async ({ argv }) => {
    const result = await runCliInProcess(
      [...argv, '--run', RUN_ID, '--claim-id', CLAIM_ID],
      workspace,
    );

    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as { code?: string; error?: string };
    expect(payload.code).toBe('INVALID_SYNTAX');
    expect(payload.error).toContain('Pass either --claim-id or --run, not both');
  });
});
