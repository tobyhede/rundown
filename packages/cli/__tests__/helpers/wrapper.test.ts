import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { Errors } from '@rundown-org/core';
import { RunbookSyntaxError } from '@rundown-org/parser';

const { withErrorHandling } = await import('../../src/helpers/wrapper.js');

describe('withErrorHandling', () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalExit = process.exit;
  let mockExit: jest.Mock;
  let errorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    mockExit = jest.fn();
    process.exit = mockExit as unknown as typeof process.exit;
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exit = originalExit;
    errorSpy.mockRestore();
  });

  it('executes fn successfully without calling exit', async () => {
    await withErrorHandling(async () => {});
    expect(mockExit).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('outputs JSON and exits on RundownError by default', async () => {
    const error = Errors.fileNotFound('missing.md');

    await withErrorHandling(async () => {
      throw error;
    });

    expect(mockExit).toHaveBeenCalledWith(1);
    const output = errorSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.code).toBe(error.code);
    expect(parsed.message).toBe(error.message);
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
    const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
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
    const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
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
    const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(parsed.code).toBe(Errors.fileNotReadable('x').code);
  });

  it('converts RunbookSyntaxError to syntaxError', async () => {
    const syntaxErr = new RunbookSyntaxError('bad syntax at line 5');

    await withErrorHandling(async () => {
      throw syntaxErr;
    });

    expect(mockExit).toHaveBeenCalledWith(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(parsed.code).toBe(Errors.syntaxError('x').code);
  });

  it('wraps generic Error as unknown', async () => {
    await withErrorHandling(async () => {
      throw new Error('something went wrong');
    });

    expect(mockExit).toHaveBeenCalledWith(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(parsed.code).toBe(Errors.unknown('x').code);
  });

  it('wraps non-Error values as unknown', async () => {
    await withErrorHandling(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'string error';
    });

    expect(mockExit).toHaveBeenCalledWith(1);
    const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
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
