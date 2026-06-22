import { jest } from '@jest/globals';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM under ts-jest: bare __dirname is undefined; derive it from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.CLAUDE_PLUGIN_ROOT = path.resolve(__dirname, '..');

// Mock ONLY the session persistence layer so the REAL gate + REAL dispatcher +
// REAL handleDelegationDispatch run: a delegation token IS detected, but the
// recording step fails. This exercises on-delegation-dispatch's own fail-closed
// try/catch (DelegationTokenRecordingError -> block), not the router's generic
// fail-open catch. Each case configures its own failure mode (write vs parse).
const sessionSet = jest.fn<(key: string, value: unknown) => Promise<void>>();
const sessionGet = jest.fn<(key: string) => Promise<unknown>>();
jest.unstable_mockModule('../src/session.js', () => ({
  Session: class {
    get = sessionGet;
    set = sessionSet;
  },
}));

const { dispatch } = await import('../src/dispatcher.js');

// Canonical delegation marker: RD_CLAIM_TOKEN= followed by `rdtk_` + 32 base32 chars.
const DELEGATION_PROMPT = 'RD_CLAIM_TOKEN=rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const DELEGATION_INPUT = {
  hook_event_name: 'PreToolUse',
  cwd: tmpdir(),
  tool_name: 'Agent',
  agent_id: 'agent-1',
  tool_input: { prompt: DELEGATION_PROMPT },
} as const;

const FAIL_CLOSED_REASON = /record the delegation token|session state|retry/i;

describe('Delegation dispatch fails closed when token cannot be recorded (#463)', () => {
  beforeEach(() => {
    sessionGet.mockReset().mockResolvedValue({});
    sessionSet.mockReset().mockResolvedValue(undefined);
  });

  it('a write-step throw (session.set rejects) yields a blocking decision, not fail-open', async () => {
    sessionSet.mockRejectedValueOnce(new Error('session metadata write failed'));

    await expect(dispatch(DELEGATION_INPUT)).resolves.toMatchObject({
      blockReason: expect.stringMatching(FAIL_CLOSED_REASON),
    });
    expect(sessionSet).toHaveBeenCalledTimes(1);
  });

  it('a parse-step throw (corrupt delegation_active_tokens) yields a blocking decision, not fail-open', async () => {
    // Existing metadata fails DelegationActiveTokensMetadataSchema.parse: the
    // schema is a record of token-metadata objects, so a bare string is invalid.
    // The parse throws before any write, so recording never reaches session.set.
    sessionGet.mockResolvedValueOnce({ delegation_active_tokens: 'corrupt-not-a-record' });

    await expect(dispatch(DELEGATION_INPUT)).resolves.toMatchObject({
      blockReason: expect.stringMatching(FAIL_CLOSED_REASON),
    });
    expect(sessionSet).not.toHaveBeenCalled();
  });
});
