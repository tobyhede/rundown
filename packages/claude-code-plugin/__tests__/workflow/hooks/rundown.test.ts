// __tests__/workflow/hooks/rundown.test.ts
import { getRundownCliPath, rundown, setExecSync } from '../../../src/workflow/hooks/rundown.js';
import { mockExecFileSync, mockExecFileSyncError } from '../../helpers/execfile-mock.js';

describe('getRundownCliPath', () => {
  it('returns path to @rundown-org/cli', () => {
    const cliPath = getRundownCliPath();
    expect(cliPath).toContain('cli');
    expect(typeof cliPath).toBe('string');
    expect(cliPath.length).toBeGreaterThan(0);
  });

  it('returns consistent path on multiple calls', () => {
    const path1 = getRundownCliPath();
    const path2 = getRundownCliPath();
    expect(path1).toBe(path2);
  });
});

describe('setExecSync', () => {
  afterEach(() => {
    // Reset to a noop for subsequent tests
    setExecSync(mockExecFileSync(''));
  });

  it('allows injection of custom execSync implementation', () => {
    const customOutput = 'custom exec output';
    const mockExec = mockExecFileSync(customOutput);
    setExecSync(mockExec);

    const result = rundown(['status'], '/test');
    expect(result).toBe(customOutput);
    expect(mockExec).toHaveBeenCalled();
  });

  it('custom implementation receives correct arguments', () => {
    const mockExec = mockExecFileSync('ok');
    setExecSync(mockExec);

    rundown(
      ['pass', '--token', 'rdo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '--step', '2'],
      '/project/path',
    );

    expect(mockExec).toHaveBeenCalledWith(
      'node',
      [
        expect.stringContaining('cli'),
        'pass',
        '--token',
        'rdo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '--step',
        '2',
      ],
      expect.objectContaining({
        cwd: '/project/path',
        stdio: 'pipe',
        encoding: 'utf-8',
      }),
    );
  });
});

describe('rundown', () => {
  afterEach(() => {
    setExecSync(mockExecFileSync(''));
  });

  it('executes rundown CLI with provided arguments', () => {
    const mockExec = mockExecFileSync('Command output');
    setExecSync(mockExec);

    const result = rundown(['status'], '/test/cwd');
    expect(result).toBe('Command output');
  });

  it('passes cwd to execSync options', () => {
    const mockExec = mockExecFileSync('ok');
    setExecSync(mockExec);

    rundown(['status'], '/custom/directory');

    expect(mockExec).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cwd: '/custom/directory' }),
    );
  });

  it('merges env overrides into execSync options', () => {
    const mockExec = mockExecFileSync('ok');
    setExecSync(mockExec);

    rundown(['status'], '/custom/directory', {
      env: { RUNDOWN_TEST_ENV: 'session-a' },
    });

    expect(mockExec).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: process.env.PATH,
          RUNDOWN_TEST_ENV: 'session-a',
        }),
      }),
    );

    // Legacy delegation env vars must not leak through: authority is --token, never ambient.
    const lastCall = mockExec.mock.calls[mockExec.mock.calls.length - 1] as unknown as [
      string,
      readonly string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(lastCall[2].env).not.toHaveProperty('RD_AGENT_ID');
    expect(lastCall[2].env).not.toHaveProperty('RD_SESSION_ID');
  });

  it('handles complex arguments correctly', () => {
    const mockExec = mockExecFileSync('ok');
    setExecSync(mockExec);

    rundown(
      [
        'fail',
        '--token',
        'rdo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '--step',
        '1.2',
        '--index',
        '3',
      ],
      '/test',
    );

    expect(mockExec).toHaveBeenCalledWith(
      'node',
      [
        expect.any(String),
        'fail',
        '--token',
        'rdo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '--step',
        '1.2',
        '--index',
        '3',
      ],
      expect.any(Object),
    );
  });

  describe('no plugin-side authority gate', () => {
    afterEach(() => {
      setExecSync(mockExecFileSync(''));
    });

    it.each([['pass'], ['fail'], ['goto'], ['complete'], ['stop'], ['yes'], ['ok'], ['no']])(
      'spawns a bare %s unchanged; the CLI refuses it with TOKEN_REQUIRED',
      (command) => {
        // The subprocess trust boundary is gone with the multi-writer core. The
        // Owner Token is the authority and the CLI is the only gate, so this
        // helper must not withhold anything — a withhold here would be a second
        // implementation of a refusal that core already owns.
        const mockExec = mockExecFileSync('ok');
        setExecSync(mockExec);

        expect(() => rundown([command], '/test')).not.toThrow();
        expect(mockExec).toHaveBeenCalledWith(
          'node',
          [expect.any(String), command],
          expect.any(Object),
        );
      },
    );

    it('spawns a --token mutation with its argv intact', () => {
      const mockExec = mockExecFileSync('ok');
      setExecSync(mockExec);
      const args = [
        'pass',
        '--token',
        'rdo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '--step',
        '2.1',
      ];

      rundown(args, '/test');

      expect(mockExec).toHaveBeenCalledWith(
        'node',
        [expect.any(String), ...args],
        expect.any(Object),
      );
    });

    it('spawns read-only commands unchanged', () => {
      const mockExec = mockExecFileSync('ok');
      setExecSync(mockExec);

      rundown(['status'], '/test');
      expect(mockExec).toHaveBeenCalled();
    });
  });

  it('propagates execSync errors', () => {
    const mockExec = mockExecFileSyncError({
      message: 'Command failed',
      stderr: 'Error details',
    });
    setExecSync(mockExec);

    expect(() => rundown(['invalid-command'], '/test')).toThrow('Command failed');
  });

  describe('command construction', () => {
    it('uses node to execute CLI path', () => {
      const mockExec = mockExecFileSync('ok');
      setExecSync(mockExec);

      rundown(['status'], '/test');

      expect(mockExec).toHaveBeenCalledWith('node', expect.any(Array), expect.any(Object));
    });

    it('includes full CLI path in arguments', () => {
      const mockExec = mockExecFileSync('ok');
      setExecSync(mockExec);

      rundown(['status'], '/test');

      expect(mockExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([expect.stringContaining('cli')]),
        expect.any(Object),
      );
    });
  });

  describe('options configuration', () => {
    it('uses pipe stdio for capturing output', () => {
      const mockExec = mockExecFileSync('output');
      setExecSync(mockExec);

      rundown(['status'], '/test');

      expect(mockExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ stdio: 'pipe' }),
      );
    });

    it('uses utf-8 encoding', () => {
      const mockExec = mockExecFileSync('output');
      setExecSync(mockExec);

      rundown(['status'], '/test');

      expect(mockExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });
  });
});
