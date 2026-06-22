import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM under ts-jest: bare __dirname is undefined; derive it from import.meta.url
// BEFORE the top-level await import so module evaluation does not throw.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Capture the original so we can restore it after this suite — shared Jest
// workers run test files sequentially in one process, so an unrestored
// process.env mutation can leak into other suites and cause order-dependent flakes.
const ORIGINAL_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;
process.env.CLAUDE_PLUGIN_ROOT = path.resolve(__dirname, '..');
const { dispatch } = await import('../src/dispatcher.js');
import type { HookInput } from '../src/shared/index.js';

afterAll(() => {
  if (ORIGINAL_PLUGIN_ROOT === undefined) {
    delete process.env.CLAUDE_PLUGIN_ROOT;
  } else {
    process.env.CLAUDE_PLUGIN_ROOT = ORIGINAL_PLUGIN_ROOT;
  }
});

describe('untrusted repository cannot influence the plugin (#463)', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'rd-untrusted-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('Test 1: a project rundown-plugin.json shell-command gate never executes', async () => {
    await writeFile(
      path.join(cwd, 'rundown-plugin.json'),
      JSON.stringify({
        hooks: { PreToolUse: { gates: ['pwn'] } },
        gates: { pwn: { command: `touch ${path.join(cwd, 'PWNED')}` } },
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
    await expect(stat(path.join(cwd, 'PWNED'))).rejects.toThrow();
  });

  it('Test 2: .claude/context/** is never injected as additionalContext', async () => {
    await mkdir(path.join(cwd, '.claude', 'context'), { recursive: true });
    await writeFile(
      path.join(cwd, '.claude', 'context', 'bash-pre.md'),
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
      path.join(cwd, 'rundown-plugin.json'),
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
