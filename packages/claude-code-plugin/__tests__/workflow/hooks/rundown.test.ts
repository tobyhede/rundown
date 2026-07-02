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

    // Claim-evidence form: carries independent claim evidence, so it survives the
    // subprocess trust boundary and is spawned normally.
    rundown(['pass', '--claim-id', 'abc123'], '/project/path');

    expect(mockExec).toHaveBeenCalledWith(
      'node',
      [expect.stringContaining('cli'), 'pass', '--claim-id', 'abc123'],
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

    // Lock the claim-id migration: legacy delegation env vars must not leak through.
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

    rundown(['fail', '--claim-id', 'abc-123', '--reason', 'Task incomplete'], '/test');

    expect(mockExec).toHaveBeenCalledWith(
      'node',
      [expect.any(String), 'fail', '--claim-id', 'abc-123', '--reason', 'Task incomplete'],
      expect.any(Object),
    );
  });

  describe('subprocess trust boundary', () => {
    afterEach(() => {
      setExecSync(mockExecFileSync(''));
    });

    it.each([
      ['pass'],
      ['fail'],
      ['delegate'],
      ['collect'],
    ])('withholds a bare %s mutation instead of spawning the CLI', (command) => {
      const mockExec = mockExecFileSync('should not run');
      setExecSync(mockExec);

      expect(() => rundown([command], '/test')).toThrow(/subprocess front end/);
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('withholds a --step-targeted bare mutation (still direct-CLI trust)', () => {
      const mockExec = mockExecFileSync('should not run');
      setExecSync(mockExec);

      expect(() => rundown(['pass', '--step', '2.1'], '/test')).toThrow(/subprocess front end/);
      expect(mockExec).not.toHaveBeenCalled();
    });

    it.each([
      ['yes'],
      ['ok'],
      ['no'],
    ])('withholds the bare alias mutation %j (cannot bypass via alias)', (command) => {
      const mockExec = mockExecFileSync('should not run');
      setExecSync(mockExec);

      expect(() => rundown([command], '/test')).toThrow(/subprocess front end/);
      expect(mockExec).not.toHaveBeenCalled();
    });

    it.each([
      [['yes', '--claim-id', 'claim-1']],
      [['no', '--claim-id=claim-1']],
    ])('spawns the claim-evidence alias mutation %j', (args) => {
      const mockExec = mockExecFileSync('ok');
      setExecSync(mockExec);

      expect(() => rundown(args, '/test')).not.toThrow();
      expect(mockExec).toHaveBeenCalledWith(
        'node',
        [expect.any(String), ...args],
        expect.any(Object),
      );
    });

    it.each([
      [['pass', '--claim-id', 'claim-1']],
      [['fail', '--claim-id=claim-1']],
      [['collect', '--claim-id', 'claim-1']],
    ])('spawns the claim-evidence mutation %j', (args) => {
      const mockExec = mockExecFileSync('ok');
      setExecSync(mockExec);

      expect(() => rundown(args, '/test')).not.toThrow();
      expect(mockExec).toHaveBeenCalledWith(
        'node',
        [expect.any(String), ...args],
        expect.any(Object),
      );
    });

    it('withholds delegate when a claim-looking token is an input-file value', () => {
      const mockExec = mockExecFileSync('should not run');
      setExecSync(mockExec);

      expect(() =>
        rundown(['delegate', 'child.md', '--input-file', '--claim-id=foo'], '/test'),
      ).toThrow(/does not accept --claim-id/);
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('rejects delegate --claim-id before spawning the CLI', () => {
      const mockExec = mockExecFileSync('should not run');
      setExecSync(mockExec);

      expect(() => rundown(['delegate', '--claim-id=foo'], '/test')).toThrow(
        /does not accept --claim-id/,
      );
      expect(mockExec).not.toHaveBeenCalled();
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
