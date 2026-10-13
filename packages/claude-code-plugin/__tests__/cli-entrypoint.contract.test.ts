import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM under ts-jest: bare __dirname is undefined; derive it from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');

function runCLIWithStdin(
  payload: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    // Claude Code sets CLAUDE_PLUGIN_ROOT when invoking the hook entrypoint; the
    // dispatcher needs it to locate the plugin's fixed gates.
    const proc = spawn('node', ['dist/cli.js'], {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
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

  it('SubagentStop holding nothing is allowed end-to-end: exit 0 and no decision on stdout', async () => {
    // Exercises the real spawned cli.js dispatch through the on-subagent-stop
    // gate. With no Rundown store in cwd nothing holds the agent, so the
    // entrypoint must write NO output (an allow is the absence of a decision)
    // and exit 0 — exit 2 is the blocking channel.
    const payload = JSON.stringify({
      hook_event_name: 'SubagentStop',
      cwd,
      agent_id: 'agent-1',
    });
    const { stdout, stderr, exitCode } = await runCLIWithStdin(payload);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('');
    expect(stderr).toBe('');
  });

  it('PreToolUse(Agent) with a Claim Ticket marker gets its prompt rewritten end-to-end (#907)', async () => {
    const ticket = `rdt_${'D'.repeat(43)}`;
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      cwd,
      tool_name: 'Agent',
      tool_input: { prompt: `Do work.\nRD_CLAIM_TICKET=${ticket}` },
    });
    const { stdout, exitCode } = await runCLIWithStdin(payload);
    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout) as {
      hookSpecificOutput: { updatedInput: { prompt: string } };
    };
    expect(output.hookSpecificOutput.updatedInput.prompt).toContain(`rundown claim ${ticket}`);
  });

  it('PreToolUse(Bash) claim outside a sub-agent is denied end-to-end (#907)', async () => {
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse',
      cwd,
      tool_name: 'Bash',
      tool_input: { command: `rundown claim rdt_${'D'.repeat(43)}` },
    });
    const { stdout, exitCode } = await runCLIWithStdin(payload);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringMatching(/CLAIM_OUTSIDE_SUBAGENT/),
      },
    });
  });

  it('still fails CLOSED on an unparseable payload (the refusal channel is unchanged)', async () => {
    const { exitCode, stderr } = await runCLIWithStdin('not json');
    expect(exitCode).toBe(2);
    expect(stderr.length).toBeGreaterThan(0);
  });
});
