import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashDelegationToken } from '@rundown-org/core';
import { Session } from '../src/session.js';

// ESM under ts-jest: bare __dirname is undefined; derive it from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const TOKEN = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function runCLIWithStdin(payload: string): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    // Claude Code sets CLAUDE_PLUGIN_ROOT when invoking the hook entrypoint; the
    // dispatcher needs it to locate the plugin's fixed gates.
    const proc = spawn('node', ['dist/cli.js'], {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    let stdout = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.on('close', (code) => {
      resolve({ stdout, exitCode: code ?? 0 });
    });
    proc.on('error', reject);
    proc.stdin.write(payload);
    proc.stdin.end();
  });
}

describe('cli.ts hook entrypoint contract', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'rd-cli-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('SubagentStop with an unclosed delegation blocks for closure end-to-end', async () => {
    // Exercises the real spawned cli.js dispatch through a surviving gate
    // (on-subagent-stop). A subagent stopping while it still has an active
    // delegation token recorded — and no rundown state proving closure — must be
    // blocked so the delegation is not silently abandoned.
    const session = new Session(cwd);
    await session.set('metadata', {
      delegation_active_tokens: {
        'agent-1': {
          kind: 'delegation-active-token',
          agent_id: 'agent-1',
          tokenHash: hashDelegationToken(TOKEN),
          createdAt: '2026-06-08T00:00:00.000Z',
        },
      },
    });
    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      cwd,
      agent_id: 'agent-1',
    });
    const { stdout, exitCode } = await runCLIWithStdin(payload);
    // A successful SubagentStop block is written to stdout and exits 0; a non-zero
    // exit would mask entrypoint regressions even when partial JSON is produced.
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.decision).toBe('block');
  });
});
