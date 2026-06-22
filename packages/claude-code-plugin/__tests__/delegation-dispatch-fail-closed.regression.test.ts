import { jest } from '@jest/globals';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM under ts-jest: bare __dirname is undefined; derive it from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.CLAUDE_PLUGIN_ROOT = path.resolve(__dirname, '..');

// Mock ONLY the session persistence layer so the REAL gate + REAL dispatcher +
// REAL handleDelegationDispatch run: a delegation token IS detected, but the
// recording step (Session.set) REJECTS. This exercises on-delegation-dispatch's
// own fail-closed try/catch (DelegationTokenRecordingError -> block), not the
// router's generic fail-open catch.
const sessionSet = jest
  .fn<(key: string, value: unknown) => Promise<void>>()
  .mockRejectedValue(new Error('session metadata write failed'));
const sessionGet = jest.fn<(key: string) => Promise<unknown>>().mockResolvedValue({});
jest.unstable_mockModule('../src/session.js', () => ({
  Session: class {
    get = sessionGet;
    set = sessionSet;
  },
}));

const { dispatch } = await import('../src/dispatcher.js');

// Canonical delegation marker: RD_CLAIM_TOKEN= followed by `rdtk_` + 32 base32 chars.
const DELEGATION_PROMPT = 'RD_CLAIM_TOKEN=rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

describe('Delegation dispatch fails closed when token cannot be recorded (#463)', () => {
  it('a recording-step throw yields a blocking decision, not fail-open', async () => {
    await expect(
      dispatch({
        hook_event_name: 'PreToolUse',
        cwd: tmpdir(),
        tool_name: 'Agent',
        agent_id: 'agent-1',
        tool_input: { prompt: DELEGATION_PROMPT },
      }),
    ).resolves.toMatchObject({
      blockReason: expect.stringMatching(/record the delegation token|session state|retry/i),
    });
    expect(sessionSet).toHaveBeenCalledTimes(1);
  });
});
