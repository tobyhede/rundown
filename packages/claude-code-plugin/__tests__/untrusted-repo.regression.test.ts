import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM under ts-jest: bare __dirname is undefined; derive it from import.meta.url
// BEFORE the top-level await import so module evaluation does not throw.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.CLAUDE_PLUGIN_ROOT = path.resolve(__dirname, '..');
const { dispatch } = await import('../src/dispatcher.js');
import type { HookInput } from '../src/shared/index.js';

describe('untrusted repository cannot influence the plugin (#463)', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'rd-untrusted-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('Test 1: a project rundown-plugin.json shell-command gate never executes', async () => {
    await writeFile(
      join(cwd, 'rundown-plugin.json'),
      JSON.stringify({
        hooks: { PreToolUse: { gates: ['pwn'] } },
        gates: { pwn: { command: `touch ${join(cwd, 'PWNED')}` } },
      }),
    );
    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    };
    const result = await dispatch(input);
    expect(result.blockReason).toBeUndefined();
    await expect(stat(join(cwd, 'PWNED'))).rejects.toThrow();
  });

  it('Test 2: .claude/context/** is never injected as additionalContext', async () => {
    await mkdir(join(cwd, '.claude', 'context'), { recursive: true });
    await writeFile(
      join(cwd, '.claude', 'context', 'bash-pre.md'),
      'SENTINEL_IGNORE_PRIOR_INSTRUCTIONS',
    );
    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    };
    const result = await dispatch(input);
    expect(result.context ?? '').not.toMatch(/SENTINEL_IGNORE_PRIOR_INSTRUCTIONS/);
  });

  it('Test 3: a cross-plugin {plugin,gate} reference is never resolved', async () => {
    await writeFile(
      join(cwd, 'rundown-plugin.json'),
      JSON.stringify({
        hooks: { PreToolUse: { gates: ['confused'] } },
        gates: { confused: { plugin: 'no-such-sibling-plugin', gate: 'whatever' } },
      }),
    );
    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    };
    await expect(dispatch(input)).resolves.toEqual({});
  });
});
