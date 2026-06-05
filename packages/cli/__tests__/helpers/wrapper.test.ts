import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { ErrorResponseSchema, Errors } from '@rundown-org/core';
import { RunbookSyntaxError } from '@rundown-org/parser';

const { withErrorHandling } = await import('../../src/helpers/wrapper.js');

describe('withErrorHandling', () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalExit = process.exit;
  let mockExit: jest.Mock;
  let errorSpy: jest.SpiedFunction<typeof console.error>;
  let stdoutWriteSpy: jest.SpiedFunction<typeof process.stdout.write>;
  let stderrWriteSpy: jest.SpiedFunction<typeof process.stderr.write>;

  beforeEach(() => {
    mockExit = jest.fn();
    process.exit = mockExit as unknown as typeof process.exit;
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrWriteSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.exit = originalExit;
    errorSpy.mockRestore();
    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
  });

  function parseStdoutJson(): Record<string, unknown> {
    return JSON.parse(stdoutWriteSpy.mock.calls.map((call) => String(call[0])).join('')) as Record<
      string,
      unknown
    >;
  }

  it('executes fn successfully without calling exit', async () => {
    await withErrorHandling(async () => {});
    expect(mockExit).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('outputs the documented error envelope and exits on RundownError by default', async () => {
    // Documented envelope (docs/spec/cli-output.md § Key Conventions):
    // { kind: "error", error, code, command?, details? }.
    const error = Errors.fileNotFound('missing.md');

    await withErrorHandling(async () => {
      throw error;
    });

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(stderrWriteSpy).not.toHaveBeenCalled();
    const parsed = parseStdoutJson();
    expect(parsed.kind).toBe('error');
    expect(parsed.error).toBe(error.message);
    expect(parsed.code).toBe(error.code);
    expect(parsed.command).toBeUndefined();
    expect(parsed.details).toMatchObject({
      category: error.errorCode.category,
      title: error.errorCode.title,
    });
    expect(ErrorResponseSchema.safeParse(parsed).success).toBe(true);
  });

  it('includes the command field when options.command is provided', async () => {
    const error = Errors.fileNotFound('missing.md');

    await withErrorHandling(
      async () => {
        throw error;
      },
      { command: 'run' },
    );

    const parsed = parseStdoutJson();
    expect(parsed.command).toBe('run');
  });

  it('outputs CLI string and exits on RundownError when text=true', async () => {
    const error = Errors.fileNotFound('missing.md');

    await withErrorHandling(
      async () => {
        throw error;
      },
      { text: true },
    );

    expect(mockExit).toHaveBeenCalledWith(1);
    const output = errorSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain(error.code);
  });

  it('converts ENOENT to fileNotFound', async () => {
    const nodeError = Object.assign(new Error('ENOENT'), {
      code: 'ENOENT',
      path: '/some/path.md',
    });

    await withErrorHandling(async () => {
      throw nodeError;
    });

    expect(mockExit).toHaveBeenCalledWith(1);
    const parsed = parseStdoutJson();
    expect(parsed.code).toBe(Errors.fileNotFound('x').code);
  });

  it('converts EACCES to fileNotReadable', async () => {
    const nodeError = Object.assign(new Error('EACCES'), {
      code: 'EACCES',
      path: '/some/path.md',
    });

    await withErrorHandling(async () => {
      throw nodeError;
    });

    expect(mockExit).toHaveBeenCalledWith(1);
    const parsed = parseStdoutJson();
    expect(parsed.code).toBe(Errors.fileNotReadable('x').code);
  });

  it('converts EPERM to fileNotReadable', async () => {
    const nodeError = Object.assign(new Error('EPERM'), {
      code: 'EPERM',
      path: '/some/path.md',
    });

    await withErrorHandling(async () => {
      throw nodeError;
    });

    expect(mockExit).toHaveBeenCalledWith(1);
    const parsed = parseStdoutJson();
    expect(parsed.code).toBe(Errors.fileNotReadable('x').code);
  });

  it('converts RunbookSyntaxError to syntaxError', async () => {
    const syntaxErr = new RunbookSyntaxError('bad syntax at line 5');

    await withErrorHandling(async () => {
      throw syntaxErr;
    });

    expect(mockExit).toHaveBeenCalledWith(1);
    const parsed = parseStdoutJson();
    expect(parsed.code).toBe(Errors.syntaxError('x').code);
  });

  it('wraps generic Error as unknown', async () => {
    await withErrorHandling(async () => {
      throw new Error('something went wrong');
    });

    expect(mockExit).toHaveBeenCalledWith(1);
    const parsed = parseStdoutJson();
    expect(parsed.code).toBe(Errors.unknown('x').code);
  });

  it('wraps non-Error values as unknown', async () => {
    await withErrorHandling(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'string error';
    });

    expect(mockExit).toHaveBeenCalledWith(1);
    const parsed = parseStdoutJson();
    expect(parsed.code).toBe(Errors.unknown('x').code);
  });

  it('uses verbose CLI string when verbose=true and text=true', async () => {
    const error = Errors.fileNotFound('missing.md');

    await withErrorHandling(
      async () => {
        throw error;
      },
      { verbose: true, text: true },
    );

    expect(mockExit).toHaveBeenCalledWith(1);
    const output = errorSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain('Documentation:');
  });
});
