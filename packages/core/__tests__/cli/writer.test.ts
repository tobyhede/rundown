import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  TestWriter,
  ConsoleWriter,
  getWriter,
  setWriter,
  withWriter,
} from '../../src/cli/index.js';

describe('TestWriter', () => {
  let writer: TestWriter;

  beforeEach(() => {
    writer = new TestWriter();
  });

  describe('writeLine', () => {
    it('captures single line', () => {
      writer.writeLine('hello');
      expect(writer.getOutput()).toBe('hello\n');
    });

    it('captures empty line', () => {
      writer.writeLine('');
      expect(writer.getOutput()).toBe('\n');
    });

    it('captures multiple lines', () => {
      writer.writeLine('line 1');
      writer.writeLine('line 2');
      expect(writer.getLines()).toEqual(['line 1', 'line 2']);
    });
  });

  describe('writeError', () => {
    it('captures to stderr stream', () => {
      writer.writeError('error message');
      expect(writer.getStderr()).toBe('error message\n');
      expect(writer.getStdout()).toBe('');
    });
  });

  describe('writeJson', () => {
    it('writes pretty JSON by default', () => {
      writer.writeJson({ key: 'value' });
      expect(writer.getOutput()).toContain('"key": "value"');
    });

    it('writes compact JSON when pretty is false', () => {
      writer.writeJson({ key: 'value' }, false);
      expect(writer.getOutput()).toBe('{"key":"value"}\n');
    });
  });

  describe('clear', () => {
    it('clears captured output', () => {
      writer.writeLine('test');
      writer.clear();
      expect(writer.getOutput()).toBe('');
    });
  });

  describe('getLines', () => {
    it('filters by stream', () => {
      writer.writeLine('stdout line');
      writer.writeError('stderr line');
      expect(writer.getLines('stdout')).toEqual(['stdout line']);
      expect(writer.getLines('stderr')).toEqual(['stderr line']);
    });
  });
});

describe('writer context', () => {
  it('getWriter returns default ConsoleWriter', () => {
    const writer = getWriter();
    expect(writer).toBeInstanceOf(ConsoleWriter);
  });

  it('setWriter changes global writer and returns previous', () => {
    const original = getWriter();
    const testWriter = new TestWriter();

    const previous = setWriter(testWriter);
    expect(previous).toBe(original);
    expect(getWriter()).toBe(testWriter);

    // Restore
    setWriter(original);
  });

  it('withWriter temporarily changes writer', () => {
    const original = getWriter();
    const testWriter = new TestWriter();

    const result = withWriter(testWriter, () => {
      expect(getWriter()).toBe(testWriter);
      return 'done';
    });

    expect(result).toBe('done');
    expect(getWriter()).toBe(original);
  });

  it('withWriter restores writer even on error', () => {
    const original = getWriter();
    const testWriter = new TestWriter();

    expect(() => {
      withWriter(testWriter, () => {
        throw new Error('test error');
      });
    }).toThrow('test error');

    expect(getWriter()).toBe(original);
  });
});
