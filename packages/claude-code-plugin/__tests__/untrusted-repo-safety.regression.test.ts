import { jest } from '@jest/globals';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookInput, GateResult } from '../src/shared/index.js';

// ESM under ts-jest: bare __dirname is undefined; derive it from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.CLAUDE_PLUGIN_ROOT = path.resolve(__dirname, '..');

const onSubagentStop = jest.fn<(i: HookInput) => Promise<GateResult>>().mockResolvedValue({});
const onDelegationDispatch = jest.fn<(i: HookInput) => Promise<GateResult>>().mockResolvedValue({});
const onDelegatedBashGuard = jest.fn<(i: HookInput) => Promise<GateResult>>().mockResolvedValue({});

jest.unstable_mockModule('../src/gates/on-subagent-stop.js', () => ({ execute: onSubagentStop }));
jest.unstable_mockModule('../src/gates/on-delegation-dispatch.js', () => ({
  execute: onDelegationDispatch,
}));
jest.unstable_mockModule('../src/gates/on-delegated-bash-guard.js', () => ({
  execute: onDelegatedBashGuard,
}));

const { dispatch } = await import('../src/dispatcher.js');

describe('project config cannot disable bundled safety hooks (#463)', () => {
  let cwd: string;
  beforeEach(async () => {
    jest.clearAllMocks();
    cwd = await mkdtemp(path.join(tmpdir(), 'rd-safety-'));
    await mkdir(path.join(cwd, '.claude'), { recursive: true });
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('baseline: on-subagent-stop runs for a SubagentStop event with no project override', async () => {
    await dispatch({ hook_event_name: 'SubagentStop', cwd, agent_id: 'agent-1' });
    expect(onSubagentStop).toHaveBeenCalledTimes(1);
  });

  it('runs on-subagent-stop even when project config empties SubagentStop gates', async () => {
    await writeFile(
      path.join(cwd, '.claude', 'rundown-plugin.json'),
      JSON.stringify({ hooks: { SubagentStop: { gates: [] } }, gates: {} }),
    );
    await dispatch({ hook_event_name: 'SubagentStop', cwd, agent_id: 'agent-1' });
    expect(onSubagentStop).toHaveBeenCalledTimes(1);
  });

  it('a gate that throws is logged and skipped — router fails open and dispatch still resolves (covers the catch branch)', async () => {
    onDelegationDispatch.mockRejectedValueOnce(new Error('boom'));
    await expect(
      dispatch({
        hook_event_name: 'PreToolUse',
        cwd,
        tool_name: 'Agent',
        tool_input: { prompt: 'x' },
      }),
    ).resolves.toEqual({});
    expect(onDelegationDispatch).toHaveBeenCalledTimes(1);
  });
});
