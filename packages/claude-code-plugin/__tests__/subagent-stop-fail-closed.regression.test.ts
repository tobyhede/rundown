import { jest } from '@jest/globals';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
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

// Mock the logger so we can force logger.error itself to reject — modelling the
// case where the very I/O failure that triggered the catch also breaks logging
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

describe('SubagentStop enforcement fails closed on session-I/O error (#463)', () => {
  beforeEach(() => {
    loggerError.mockReset().mockResolvedValue(undefined);
  });

  it('a session-I/O throw yields a blocking decision, not fail-open', async () => {
    await expect(
      dispatch({ hook_event_name: 'SubagentStop', cwd: tmpdir(), agent_id: 'agent-1' }),
    ).resolves.toMatchObject({
      blockReason: expect.stringMatching(/rd status|close|verify/i),
    });
    expect(handleSubagentStop).toHaveBeenCalledTimes(1);
  });

  it('still blocks when logging inside the catch also fails (#469)', async () => {
    loggerError.mockRejectedValueOnce(new Error('log directory unwritable'));

    await expect(
      dispatch({ hook_event_name: 'SubagentStop', cwd: tmpdir(), agent_id: 'agent-1' }),
    ).resolves.toMatchObject({
      blockReason: expect.stringMatching(/rd status|close|verify/i),
    });
    expect(loggerError).toHaveBeenCalled();
  });
});
