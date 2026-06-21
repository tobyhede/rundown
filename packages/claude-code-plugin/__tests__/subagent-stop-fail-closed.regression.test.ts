import { jest } from '@jest/globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookInput } from '../src/shared/index.js';
import type { SubagentStopResult } from '../src/workflow/hooks/index.js';

// ESM under ts-jest: bare __dirname is undefined; derive it from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.CLAUDE_PLUGIN_ROOT = path.resolve(__dirname, '..');

// Mock ONLY the handler so the REAL gate + REAL dispatcher run: this exercises
// on-subagent-stop's own fail-closed try/catch, not the router's generic catch.
const handleSubagentStop = jest
  .fn<(i: HookInput) => Promise<SubagentStopResult>>()
  .mockRejectedValue(new Error('session metadata I/O failed'));
jest.unstable_mockModule('../src/workflow/hooks/subagent-stop.js', () => ({ handleSubagentStop }));

const { dispatch } = await import('../src/dispatcher.js');

describe('SubagentStop enforcement fails closed on session-I/O error (#463)', () => {
  it('a session-I/O throw yields a blocking decision, not fail-open', async () => {
    await expect(
      dispatch({ hook_event_name: 'SubagentStop', cwd: '/tmp', agent_id: 'agent-1' } as HookInput),
    ).resolves.toMatchObject({
      blockReason: expect.stringMatching(/rd status|close|verify/i),
    });
    expect(handleSubagentStop).toHaveBeenCalledTimes(1);
  });
});
