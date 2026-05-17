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
});
