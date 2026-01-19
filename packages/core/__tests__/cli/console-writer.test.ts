import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ConsoleWriter } from '../../src/cli/console-writer.js';

describe('ConsoleWriter', () => {
  let writer: ConsoleWriter;
  let stdoutWriteSpy: jest.SpiedFunction<typeof process.stdout.write>;
  let stderrWriteSpy: jest.SpiedFunction<typeof process.stderr.write>;
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    writer = new ConsoleWriter();
    stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrWriteSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => { /* noop */ });
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => { /* noop */ });
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
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
    it('uses console.log for stdout', () => {
      writer.writeLine('hello line');
      expect(consoleLogSpy).toHaveBeenCalledWith('hello line');
    });

    it('defaults to empty string', () => {
      writer.writeLine();
      expect(consoleLogSpy).toHaveBeenCalledWith('');
    });

    it('uses console.error for stderr', () => {
      writer.writeLine('error line', 'stderr');
      expect(consoleErrorSpy).toHaveBeenCalledWith('error line');
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('writeLines', () => {
    it('iterates over array', () => {
      writer.writeLines(['line 1', 'line 2', 'line 3']);
      expect(consoleLogSpy).toHaveBeenCalledTimes(3);
      expect(consoleLogSpy).toHaveBeenNthCalledWith(1, 'line 1');
      expect(consoleLogSpy).toHaveBeenNthCalledWith(2, 'line 2');
      expect(consoleLogSpy).toHaveBeenNthCalledWith(3, 'line 3');
    });

    it('routes to stderr when specified', () => {
      writer.writeLines(['err 1', 'err 2'], 'stderr');
      expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('writeError', () => {
    it('routes to stderr', () => {
      writer.writeError('error message');
      expect(consoleErrorSpy).toHaveBeenCalledWith('error message');
    });
  });

  describe('writeJson', () => {
    it('writes pretty JSON by default', () => {
      writer.writeJson({ key: 'value' });
      expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify({ key: 'value' }, null, 2));
    });

    it('writes compact JSON when pretty is false', () => {
      writer.writeJson({ key: 'value' }, false);
      expect(consoleLogSpy).toHaveBeenCalledWith('{"key":"value"}');
    });
  });
});
