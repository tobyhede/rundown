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

    it('appends exactly one newline', () => {
      writer.writeJson({ key: 'value' }, false);
      expect(writer.getOutput()).toBe(`${JSON.stringify({ key: 'value' })}\n`);
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

    it('returns all lines when no stream specified', () => {
      writer.writeLine('out1');
      writer.writeError('err1');
      writer.writeLine('out2');
      const lines = writer.getLines();
      expect(lines).toEqual(['out1', 'err1', 'out2']);
    });

    it('trims and filters empty lines', () => {
      writer.writeLine('  spaced  ');
      writer.writeLine('');
      writer.writeLine('normal');
      const lines = writer.getLines();
      expect(lines).toEqual(['spaced', 'normal']);
    });
  });

  describe('write', () => {
    it('captures text without newline', () => {
      writer.write('no newline');
      expect(writer.getOutput()).toBe('no newline');
    });

    it('defaults to stdout stream', () => {
      writer.write('text');
      expect(writer.getStdout()).toBe('text');
      expect(writer.getStderr()).toBe('');
    });
  });

  describe('writeLines', () => {
    it('writes each line to specified stream', () => {
      writer.writeLines(['line1', 'line2'], 'stderr');
      expect(writer.getStderr()).toBe('line1\nline2\n');
      expect(writer.getStdout()).toBe('');
    });
  });

  describe('getRawOutput', () => {
    it('returns captured entries for detailed assertions', () => {
      writer.writeLine('text', 'stdout');
      writer.writeError('error');

      const raw = writer.getRawOutput();

      expect(raw).toHaveLength(2);
      expect(raw[0]).toEqual({ text: 'text\n', stream: 'stdout' });
      expect(raw[1]).toEqual({ text: 'error\n', stream: 'stderr' });
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
