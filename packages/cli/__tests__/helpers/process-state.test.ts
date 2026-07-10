import { describe, expect, it } from '@jest/globals';
import {
  captureProcessState,
  diffProcessState,
  formatProcessStateDrift,
  restoreEnvVar,
  restoreProcessState,
} from './process-state.js';

const KEY = 'RD_PROCESS_STATE_TEST_VAR';

describe('restoreEnvVar', () => {
  it('deletes the variable when the captured value was undefined', () => {
    process.env[KEY] = 'set-by-test';

    restoreEnvVar(KEY, undefined);

    // A bare `process.env[KEY] = undefined` would store the string 'undefined'.
    expect(KEY in process.env).toBe(false);
  });

  it('restores the captured value', () => {
    delete process.env[KEY];

    restoreEnvVar(KEY, 'original');
    expect(process.env[KEY]).toBe('original');

    restoreEnvVar(KEY, undefined);
  });
});

describe('diffProcessState', () => {
  it('reports no drift when the test touched nothing', () => {
    const snapshot = captureProcessState();

    expect(diffProcessState(snapshot)).toEqual({ added: [], removed: [], changed: [] });
  });

  it('reports an added env key', () => {
    const snapshot = captureProcessState();
    process.env[KEY] = 'leaked';

    expect(diffProcessState(snapshot).added).toEqual([KEY]);

    restoreProcessState(snapshot);
  });

  it('reports a removed env key', () => {
    process.env[KEY] = 'present';
    const snapshot = captureProcessState();
    delete process.env[KEY];

    expect(diffProcessState(snapshot).removed).toEqual([KEY]);

    restoreProcessState(snapshot);
    restoreEnvVar(KEY, undefined);
  });

  it('reports a changed env key', () => {
    process.env[KEY] = 'before';
    const snapshot = captureProcessState();
    process.env[KEY] = 'after';

    expect(diffProcessState(snapshot).changed).toEqual([KEY]);

    restoreProcessState(snapshot);
    restoreEnvVar(KEY, undefined);
  });

  it('reports a changed working directory', () => {
    const snapshot = captureProcessState();
    process.chdir('/');

    expect(diffProcessState(snapshot).cwd).toBeDefined();

    restoreProcessState(snapshot);
    expect(diffProcessState(snapshot)).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe('restoreProcessState', () => {
  it('undoes additions, deletions, and changes together', () => {
    process.env[KEY] = 'original';
    const snapshot = captureProcessState();

    process.env[KEY] = 'mutated';
    process.env[`${KEY}_EXTRA`] = 'added';

    restoreProcessState(snapshot);

    expect(process.env[KEY]).toBe('original');
    expect(`${KEY}_EXTRA` in process.env).toBe(false);

    restoreEnvVar(KEY, undefined);
  });
});

describe('formatProcessStateDrift', () => {
  it('returns undefined when there is no drift', () => {
    expect(
      formatProcessStateDrift({ added: [], removed: [], changed: [] }, 'some test'),
    ).toBeUndefined();
  });

  it('names the test and every drifted key', () => {
    const message = formatProcessStateDrift(
      { added: ['A_VAR'], removed: ['B_VAR'], changed: ['C_VAR'], cwd: '/tmp/elsewhere' },
      'some test',
    );

    expect(message).toContain('"some test"');
    expect(message).toContain('added env A_VAR');
    expect(message).toContain('deleted env B_VAR');
    expect(message).toContain('changed env C_VAR');
    expect(message).toContain('/tmp/elsewhere');
  });
});
