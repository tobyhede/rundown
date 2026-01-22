// __tests__/workflow/hooks/rundown.test.ts
import { jest } from '@jest/globals';
import { getRundownCliPath, rundown, setExecSync } from '../../../src/workflow/hooks/rundown.js';
import { createMockExecSync, createMockExecSyncError } from '../../helpers/test-utils.js';

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
    setExecSync(jest.fn());
  });

  it('allows injection of custom execSync implementation', () => {
    const customOutput = 'custom exec output';
    const mockExec = createMockExecSync(customOutput);
    setExecSync(mockExec);

    const result = rundown(['status'], '/test');
    expect(result).toBe(customOutput);
    expect(mockExec).toHaveBeenCalled();
  });

  it('custom implementation receives correct arguments', () => {
    const mockExec = createMockExecSync('ok');
    setExecSync(mockExec);

    rundown(['pass', '--agent', 'abc123'], '/project/path');

    expect(mockExec).toHaveBeenCalledWith(
      'node',
      [expect.stringContaining('cli'), 'pass', '--agent', 'abc123'],
      expect.objectContaining({
        cwd: '/project/path',
        stdio: 'pipe',
        encoding: 'utf-8'
      })
    );
  });
});

describe('rundown', () => {
  afterEach(() => {
    setExecSync(jest.fn() as any);
  });

  it('executes rundown CLI with provided arguments', () => {
    const mockExec = createMockExecSync('Command output');
    setExecSync(mockExec);

    const result = rundown(['status'], '/test/cwd');
    expect(result).toBe('Command output');
  });

  it('passes cwd to execSync options', () => {
    const mockExec = createMockExecSync('ok');
    setExecSync(mockExec);

    rundown(['status'], '/custom/directory');

    expect(mockExec).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cwd: '/custom/directory' })
    );
  });

  it('handles complex arguments correctly', () => {
    const mockExec = createMockExecSync('ok');
    setExecSync(mockExec);

    rundown(['fail', '--agent', 'abc-123', '--reason', 'Task incomplete'], '/test');

    expect(mockExec).toHaveBeenCalledWith(
      'node',
      [expect.any(String), 'fail', '--agent', 'abc-123', '--reason', 'Task incomplete'],
      expect.any(Object)
    );
  });

  it('propagates execSync errors', () => {
    const mockExec = createMockExecSyncError({
      message: 'Command failed',
      stderr: 'Error details'
    });
    setExecSync(mockExec);

    expect(() => rundown(['invalid-command'], '/test')).toThrow('Command failed');
  });

  describe('command construction', () => {
    it('uses node to execute CLI path', () => {
      const mockExec = createMockExecSync('ok');
      setExecSync(mockExec);

      rundown(['status'], '/test');

      expect(mockExec).toHaveBeenCalledWith(
        'node',
        expect.any(Array),
        expect.any(Object)
      );
    });

    it('includes full CLI path in arguments', () => {
      const mockExec = createMockExecSync('ok');
      setExecSync(mockExec);

      rundown(['status'], '/test');

      const args = mockExec.mock.calls[0][1] as string[];
      expect(args[0]).toContain('cli');
    });
  });

  describe('options configuration', () => {
    it('uses pipe stdio for capturing output', () => {
      const mockExec = createMockExecSync('output');
      setExecSync(mockExec);

      rundown(['status'], '/test');

      expect(mockExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ stdio: 'pipe' })
      );
    });

    it('uses utf-8 encoding', () => {
      const mockExec = createMockExecSync('output');
      setExecSync(mockExec);

      rundown(['status'], '/test');

      expect(mockExec).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ encoding: 'utf-8' })
      );
    });
  });
});
