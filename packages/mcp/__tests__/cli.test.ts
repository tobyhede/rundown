import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRunCli, type ExecFileAsync } from '../src/cli.js';

describe('runCli', () => {
  const execFileAsync = jest.fn<ExecFileAsync>();
  const runCli = createRunCli(execFileAsync);

  beforeEach(() => {
    execFileAsync.mockReset();
  });

  it('executes npx --no rundown with arg arrays', async () => {
    execFileAsync.mockResolvedValue({ stdout: '{"active":false}\n', stderr: '' });

    await expect(runCli(['status'])).resolves.toEqual({
      success: true,
      data: { active: false },
    });
    expect(execFileAsync).toHaveBeenCalledWith('npx', ['--no', 'rundown', 'status'], {
      timeout: 30000,
    });
  });

  it('returns the last action object from mixed JSONL event output', async () => {
    execFileAsync.mockResolvedValue({
      stdout: [
        JSON.stringify({ type: 'step_entered', position: { current: '1' } }),
        JSON.stringify({ action: 'PASS', to: '2' }),
      ].join('\n'),
      stderr: '',
    });

    await expect(runCli(['pass'])).resolves.toEqual({
      success: true,
      data: { action: 'PASS', to: '2' },
    });
  });

  it('returns the last command-keyed object from mixed JSONL event output', async () => {
    execFileAsync.mockResolvedValue({
      stdout: [
        JSON.stringify({ type: 'step_entered', position: { current: '1' } }),
        JSON.stringify({ command: 'pass', to: '2' }),
      ].join('\n'),
      stderr: '',
    });

    await expect(runCli(['pass'])).resolves.toEqual({
      success: true,
      data: { command: 'pass', to: '2' },
    });
  });

  it('extracts CLI JSON errors from stderr', async () => {
    const error = new Error('failed') as Error & { stdout?: string; stderr?: string };
    error.stdout = '';
    error.stderr = JSON.stringify({ error: 'No active runbook' });
    execFileAsync.mockRejectedValue(error);

    await expect(runCli(['status'])).resolves.toEqual({
      success: false,
      error: 'No active runbook',
      data: { error: 'No active runbook' },
    });
  });

  it('surfaces open delegated child refusal (pass) from the CLI facade', async () => {
    const error = new Error('failed') as Error & { stdout?: string; stderr?: string };
    const flat = {
      error:
        'Cannot run bare rd pass: active parent runbook has open delegated child claim(s): rdclm_abcdefghijklmnopQRSTUV.',
      code: 'OPEN_DELEGATED_CHILDREN',
      command: 'pass',
      details: {
        parentRunId: 'rd_parent000000000000000000000001',
        claimIds: ['rdclm_abcdefghijklmnopQRSTUV'],
        childRunIds: ['rd_child0000000000000000000000001'],
      },
    };
    error.stdout = '';
    error.stderr = JSON.stringify(flat);
    execFileAsync.mockRejectedValue(error);

    await expect(runCli(['pass'])).resolves.toEqual({
      success: false,
      error: flat.error,
      data: flat,
    });
  });

  it('surfaces open delegated child refusal (fail) from the CLI facade', async () => {
    const error = new Error('failed') as Error & { stdout?: string; stderr?: string };
    const flat = {
      error:
        'Cannot run bare rd fail: active parent runbook has open delegated child claim(s): rdclm_abcdefghijklmnopQRSTUV.',
      code: 'OPEN_DELEGATED_CHILDREN',
      command: 'fail',
      details: { claimIds: ['rdclm_abcdefghijklmnopQRSTUV'] },
    };
    error.stdout = '';
    error.stderr = JSON.stringify(flat);
    execFileAsync.mockRejectedValue(error);

    await expect(runCli(['fail'])).resolves.toEqual({
      success: false,
      error: flat.error,
      data: flat,
    });
  });

  it('surfaces a terminal claim result conflict from the CLI facade', async () => {
    const error = new Error('failed') as Error & { stdout?: string; stderr?: string };
    const flat = {
      error: 'Claim rdclm_abcdefghijklmnopQRSTUV already resolved as fail; cannot pass it.',
      code: 'DELEGATION_RESULT_CONFLICT',
      command: 'pass',
    };
    error.stdout = '';
    error.stderr = JSON.stringify(flat);
    execFileAsync.mockRejectedValue(error);

    await expect(runCli(['pass', '--claim-id', 'rdclm_abcdefghijklmnopQRSTUV'])).resolves.toEqual({
      success: false,
      error: flat.error,
      data: flat,
    });
  });

  it('surfaces an unavailable claimed runbook from the CLI facade', async () => {
    const error = new Error('failed') as Error & { stdout?: string; stderr?: string };
    const flat = {
      error: 'Claim id rdclm_abcdefghijklmnopQRSTUV does not exist.',
      code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
      command: 'pass',
    };
    error.stdout = '';
    error.stderr = JSON.stringify(flat);
    execFileAsync.mockRejectedValue(error);

    await expect(runCli(['pass', '--claim-id', 'rdclm_abcdefghijklmnopQRSTUV'])).resolves.toEqual({
      success: false,
      error: flat.error,
      data: flat,
    });
  });

  it('extracts CLI JSON errors from stdout on command failure', async () => {
    const error = new Error('failed') as Error & { stdout?: string; stderr?: string };
    error.stdout = JSON.stringify({ error: 'Invalid runbook', detail: 'line 1' });
    error.stderr = '';
    execFileAsync.mockRejectedValue(error);

    await expect(runCli(['check', 'broken.md'])).resolves.toEqual({
      success: false,
      error: 'Invalid runbook',
      data: { error: 'Invalid runbook', detail: 'line 1' },
    });
  });

  it('falls back to raw stdout when stderr is an empty string', async () => {
    const error = new Error('failed') as Error & { stdout?: string; stderr?: string };
    error.stdout = 'plain text failure on stdout\n';
    error.stderr = '';
    execFileAsync.mockRejectedValue(error);

    await expect(runCli(['status'])).resolves.toEqual({
      success: false,
      error: 'plain text failure on stdout',
    });
  });

  it('falls back to getErrorMessage when exec failure has no output', async () => {
    execFileAsync.mockRejectedValue(new Error('spawn timeout'));

    await expect(runCli(['status'])).resolves.toEqual({
      success: false,
      error: 'spawn timeout',
    });
  });

  it('handles primitive exec rejections gracefully', async () => {
    execFileAsync.mockRejectedValue('boom');

    await expect(runCli(['status'])).resolves.toEqual({
      success: false,
      error: 'boom',
    });
  });
});
