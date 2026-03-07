import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ConsoleWriter } from '../../src/cli/console-writer.js';

describe('ConsoleWriter', () => {
  let writer: ConsoleWriter;
  let stdoutWriteSpy: jest.SpiedFunction<typeof process.stdout.write>;
  let stderrWriteSpy: jest.SpiedFunction<typeof process.stderr.write>;

  beforeEach(() => {
    writer = new ConsoleWriter();
    stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrWriteSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
  });

  describe('write', () => {
    it('writes to stdout by default', () => {
      writer.write('hello');
      expect(stdoutWriteSpy).toHaveBeenCalledWith('hello');
      expect(stderrWriteSpy).not.toHaveBeenCalled();
    });

    it('writes to stderr when specified', () => {
      writer.write('error text', 'stderr');
      expect(stderrWriteSpy).toHaveBeenCalledWith('error text');
      expect(stdoutWriteSpy).not.toHaveBeenCalled();
    });

    it('does not add newline', () => {
      writer.write('no newline');
      expect(stdoutWriteSpy).toHaveBeenCalledWith('no newline');
    });
  });

  describe('writeLine', () => {
    it('writes to stdout with newline', () => {
      writer.writeLine('hello line');
      expect(stdoutWriteSpy).toHaveBeenCalledWith('hello line\n');
    });

    it('defaults to empty string', () => {
      writer.writeLine();
      expect(stdoutWriteSpy).toHaveBeenCalledWith('\n');
    });

    it('writes to stderr with newline when specified', () => {
      writer.writeLine('error line', 'stderr');
      expect(stderrWriteSpy).toHaveBeenCalledWith('error line\n');
      expect(stdoutWriteSpy).not.toHaveBeenCalled();
    });
  });

  describe('writeLines', () => {
    it('iterates over array', () => {
      writer.writeLines(['line 1', 'line 2', 'line 3']);
      expect(stdoutWriteSpy).toHaveBeenCalledTimes(3);
      expect(stdoutWriteSpy).toHaveBeenNthCalledWith(1, 'line 1\n');
      expect(stdoutWriteSpy).toHaveBeenNthCalledWith(2, 'line 2\n');
      expect(stdoutWriteSpy).toHaveBeenNthCalledWith(3, 'line 3\n');
    });

    it('routes to stderr when specified', () => {
      writer.writeLines(['err 1', 'err 2'], 'stderr');
      expect(stderrWriteSpy).toHaveBeenCalledTimes(2);
      expect(stdoutWriteSpy).not.toHaveBeenCalled();
    });
  });

  describe('writeError', () => {
    it('routes to stderr', () => {
      writer.writeError('error message');
      expect(stderrWriteSpy).toHaveBeenCalledWith('error message\n');
    });
  });

  describe('writeJson', () => {
    it('writes pretty JSON by default', () => {
      writer.writeJson({ key: 'value' });
      expect(stdoutWriteSpy).toHaveBeenCalledWith(`${JSON.stringify({ key: 'value' }, null, 2)}\n`);
    });

    it('writes compact JSON when pretty is false', () => {
      writer.writeJson({ key: 'value' }, false);
      expect(stdoutWriteSpy).toHaveBeenCalledWith('{"key":"value"}\n');
    });
  });
});
