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
// recordDelegationToken now performs a single locked read-modify-write via
// Session#update. The inline mock mirrors the real update contract: read
// current value, run the updater, and route a committed decision through
// sessionSet — so the write-throw (sessionSet rejects) and parse-throw
// (updater throws before commit) fail-closed cases, and their sessionSet call
// assertions, stay meaningful.
type SessionUpdateDecision =
  | { commit: true; value: unknown; result: unknown }
  | { commit: false; result: unknown };
const sessionUpdate = jest.fn(
  async (
    key: string,
    updater: (current: unknown) => Promise<SessionUpdateDecision> | SessionUpdateDecision,
  ): Promise<unknown> => {
    const current = await sessionGet(key);
    const decision = await updater(current);
    if (decision.commit) {
      await sessionSet(key, decision.value);
    }
    return decision.result;
  },
);
jest.unstable_mockModule('../src/session.js', () => ({
  Session: class {
    get = sessionGet;
    set = sessionSet;
    update = sessionUpdate;
  },
}));

// Mock the logger so we can force logger.error itself to reject — modelling the
// case where the same I/O failure that triggered the catch also breaks logging
// (e.g. the session log directory is unwritable). The fail-closed guarantee must
// survive a logging failure inside the catch block. The gate imports `logger`
// from ../shared/index.js, which re-exports ./logger.js via `export *`.
const loggerError = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../src/shared/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: loggerError,
    always: jest.fn(),
    event: jest.fn(),
    getLogFilePath: jest.fn(),
    getLogDir: jest.fn(),
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
    sessionUpdate.mockClear();
    loggerError.mockReset().mockResolvedValue(undefined);
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

  it('still blocks when logging inside the catch also fails (#469)', async () => {
    // The recording step throws DelegationTokenRecordingError (write fails) AND
    // the logger.error call inside the catch rejects. The block must still win.
    sessionSet.mockRejectedValueOnce(new Error('session metadata write failed'));
    loggerError.mockRejectedValueOnce(new Error('log directory unwritable'));

    await expect(dispatch(DELEGATION_INPUT)).resolves.toMatchObject({
      blockReason: expect.stringMatching(FAIL_CLOSED_REASON),
    });
    expect(loggerError).toHaveBeenCalled();
  });
});
