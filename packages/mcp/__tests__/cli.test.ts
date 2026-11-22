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

  it('returns every event of a JSONL stream, so runbook_started keeps its owner_token', async () => {
    const stream = [
      { type: 'runbook_started', runbookId: 'rd_1', owner_token: 'rdo_x' },
      { type: 'command_started', command: 'echo hi' },
      { type: 'step_transitioned', action: 'CONTINUE', from: '1', to: '2' },
      { type: 'step_entered', position: { current: '2' } },
    ];
    execFileAsync.mockResolvedValue({
      stdout: stream.map((event) => JSON.stringify(event)).join('\n'),
      stderr: '',
    });

    await expect(runCli(['run', 'x.runbook.md'])).resolves.toEqual({
      success: true,
      data: stream,
    });
  });

  it('keeps the step_entered that names the next position alongside the action', async () => {
    const stream = [
      { type: 'step_entered', position: { current: '2' } },
      { action: 'CONTINUE', stepResult: 'PASS', from: '1', at: '2', kind: 'action' },
    ];
    execFileAsync.mockResolvedValue({
      stdout: stream.map((event) => JSON.stringify(event)).join('\n'),
      stderr: '',
    });

    await expect(runCli(['pass'])).resolves.toEqual({ success: true, data: stream });
  });

  it('takes the error message from the error object in a failing JSONL stream', async () => {
    const stream = [
      { type: 'step_entered', position: { current: '1' } },
      { kind: 'error', error: 'Policy denied', code: 'POLICY_DENIED' },
    ];
    const error = new Error('failed') as Error & { stdout?: string; stderr?: string };
    error.stdout = stream.map((event) => JSON.stringify(event)).join('\n');
    error.stderr = '';
    execFileAsync.mockRejectedValue(error);

    await expect(runCli(['run', 'x.runbook.md'])).resolves.toEqual({
      success: false,
      error: 'Policy denied',
      data: stream,
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

  it('surfaces a TOKEN_REQUIRED refusal from the CLI facade (bare mutation)', async () => {
    const error = new Error('failed') as Error & { stdout?: string; stderr?: string };
    const flat = {
      error: 'rundown pass requires --token; pass --token <owner_token> from runbook_started',
      code: 'TOKEN_REQUIRED',
      command: 'pass',
    };
    error.stdout = '';
    error.stderr = JSON.stringify(flat);
    execFileAsync.mockRejectedValue(error);

    await expect(runCli(['pass', '--step', '1'])).resolves.toEqual({
      success: false,
      error: flat.error,
      data: flat,
    });
  });

  it('surfaces an INVALID_STEP refusal naming the current position', async () => {
    const error = new Error('failed') as Error & { stdout?: string; stderr?: string };
    const flat = {
      error: '--step is required; the current position is 2.1',
      code: 'INVALID_STEP',
      command: 'pass',
    };
    error.stdout = '';
    error.stderr = JSON.stringify(flat);
    execFileAsync.mockRejectedValue(error);

    await expect(runCli(['pass', '--token', `rdo_${'A'.repeat(43)}`])).resolves.toEqual({
      success: false,
      error: flat.error,
      data: flat,
    });
    expect(execFileAsync).toHaveBeenCalledWith(
      'npx',
      ['--no', 'rundown', 'pass', '--token', `rdo_${'A'.repeat(43)}`],
      { timeout: 30000 },
    );
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

  it('redacts the Owner Token from an execFile error message that echoes argv', async () => {
    const token = `rdo_${'A'.repeat(43)}`;
    // A 30s timeout kill: Node's execFile error embeds the full argv, and no output arrived.
    const error = new Error(`Command failed: npx --no rundown pass --token ${token} --step 2`);
    execFileAsync.mockRejectedValue(error);

    const result = await runCli(['pass', '--token', token, '--step', '2']);

    expect(result).toEqual({
      success: false,
      error: 'Command failed: npx --no rundown pass --token rdo_[redacted] --step 2',
    });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('redacts the Owner Token from a raw-text stderr fallback', async () => {
    const token = `rdo_${'B'.repeat(43)}`;
    const error = new Error('failed') as Error & { stdout?: string; stderr?: string };
    error.stdout = '';
    error.stderr = `npm error could not determine executable for: rundown pass --token ${token}\n`;
    execFileAsync.mockRejectedValue(error);

    const result = await runCli(['pass', '--token', token]);

    expect(result).toEqual({
      success: false,
      error: 'npm error could not determine executable for: rundown pass --token rdo_[redacted]',
    });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('handles primitive exec rejections gracefully', async () => {
    execFileAsync.mockRejectedValue('boom');

    await expect(runCli(['status'])).resolves.toEqual({
      success: false,
      error: 'boom',
    });
  });
});
