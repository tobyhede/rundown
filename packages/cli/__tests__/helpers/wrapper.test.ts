import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  ConcurrentStateModificationError,
  ErrorResponseSchema,
  Errors,
  IncompatibleSchemaError,
  InvalidRunbookStateError,
  LegacySnapshotError,
  NativeSqliteUnavailableError,
  SqljsUnavailableError,
  WalJournalModeUnavailableError,
} from '@rundown-org/core';
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

  // Both of these fire while OPENING the store, so they reach every command that
  // accesses persisted run state, including read-only state commands. Without a
  // typed arm each falls through to Errors.unknown and reports RD-999 / "Unknown
  // error" — a condition with a specific cause rendered as though the CLI had no
  // idea what happened.
  it('converts a WAL journal-mode refusal to RD-306, carrying the effective mode', async () => {
    await withErrorHandling(async () => {
      throw new WalJournalModeUnavailableError('delete');
    });

    expect(mockExit).toHaveBeenCalledWith(1);
    const parsed = parseStdoutJson();
    expect(parsed.code).toBe(Errors.walJournalModeUnavailable('delete').code);
    expect(parsed.code).not.toBe(Errors.unknown('x').code);
    // The complete programmatic message is specified in cli-output.md. Keep the
    // wrapper, factory, and documented example on one byte-for-byte contract.
    expect(parsed.error).toBe(
      "Runbook database is not in WAL journal mode - effective mode: delete. WAL mode is required for supported multi-process operation. SQLite still serializes cross-process writers using file locks in rollback-journal mode, but rollback-journal mode does not provide WAL's reader/writer concurrency and is not a validated Rundown deployment mode. SQLite returned the non-WAL mode it kept instead of failing. This narrows the cause to one of: a filesystem whose VFS provides no shared memory (a network mount such as NFS or SMB is the common one), a temporary database opened with no filename, or a connection already inside a write transaction. A read-only database file or directory is NOT among them — that fails the pragma outright and surfaces as RD-307",
    );
  });

  // The store-open arms below are what an operator actually hits: a read-only
  // database file throws SQLite errcode 8 and a read-only directory errcode
  // 1544, and neither RETURNS a fallback journal mode, so neither reaches the
  // WAL arm above — both arrive as NativeSqliteUnavailableError. Reproduced
  // against the built CLI as `RD-999 "Unknown error - Native SQLite
  // (node:sqlite) is unavailable ... attempt to write a readonly database"`
  // before this arm existed.
  it('converts a native SQLite open failure to RD-307, carrying the driver code', async () => {
    const cause = Object.assign(new Error('attempt to write a readonly database'), {
      code: 'SQLITE_READONLY',
    });

    await withErrorHandling(async () => {
      throw new NativeSqliteUnavailableError(cause);
    });

    expect(mockExit).toHaveBeenCalledWith(1);
    const parsed = parseStdoutJson();
    expect(parsed.code).toBe(Errors.stateStoreUnavailable('x').code);
    expect(parsed.code).not.toBe(Errors.unknown('x').code);
    // The wrapper's complete message is the programmatic contract. The native
    // adapter prefix survives, while the underlying driver's code remains
    // structured context instead of being invented as a message prefix.
    expect(parsed.error).toBe(
      'Runbook database unavailable - Native SQLite (node:sqlite) is unavailable on this multi-process host: attempt to write a readonly database. Rundown does not downgrade to the single-writer sql.js adapter outside WebContainer.',
    );
    expect(parsed.error).not.toContain('SQLITE_READONLY:');
    expect(parsed.details).toMatchObject({ context: { driverCode: 'SQLITE_READONLY' } });
    expect(ErrorResponseSchema.safeParse(parsed).success).toBe(true);
  });

  it('converts an sql.js open failure to RD-307', async () => {
    await withErrorHandling(async () => {
      throw new SqljsUnavailableError(new Error('wasm module failed to instantiate'));
    });

    expect(mockExit).toHaveBeenCalledWith(1);
    const parsed = parseStdoutJson();
    expect(parsed.code).toBe(Errors.stateStoreUnavailable('x').code);
    expect(parsed.code).not.toBe(Errors.unknown('x').code);
    expect(parsed.error).toMatch(/wasm module failed to instantiate/);
  });

  // Transient, not a refusal: the operator action is "run it again", which
  // "Unknown error" argues against.
  it('converts a lost optimistic CAS to RD-308 rather than RD-999', async () => {
    const runId = `rd_${'a'.repeat(32)}`;

    await withErrorHandling(async () => {
      throw new ConcurrentStateModificationError(
        runId,
        `Run ${runId} was modified concurrently by another writer.`,
      );
    });

    expect(mockExit).toHaveBeenCalledWith(1);
    const parsed = parseStdoutJson();
    expect(parsed.code).toBe(Errors.concurrentStateModification(runId, 'x').code);
    expect(parsed.code).not.toBe(Errors.unknown('x').code);
    // The run id is what a caller retries against, so it must not be buried in
    // the prose only.
    expect(parsed.details).toMatchObject({ context: { runId } });
    expect(ErrorResponseSchema.safeParse(parsed).success).toBe(true);
  });

  it('converts an incompatible schema to RD-305 rather than RD-999', async () => {
    await withErrorHandling(async () => {
      throw new IncompatibleSchemaError(99, 2);
    });

    expect(mockExit).toHaveBeenCalledWith(1);
    const parsed = parseStdoutJson();
    expect(parsed.code).toBe(Errors.incompatibleStateSchema(99, 2).code);
    expect(parsed.code).not.toBe(Errors.unknown('x').code);
  });

  // CLAUDE.md § State Persistence requires the CLI to "detect invalid state (via
  // schema version or structural guard) and prompt the user to finish or prune".
  // An "Unknown error" envelope cannot carry that instruction, so before this arm
  // the documented recovery path was unreachable from the error surface.
  // Reproduced against the built CLI by patching a persisted run to
  // `schemaVersion: 2` and running `rundown status`:
  //   { "kind": "error",
  //     "error": "Unknown error - Invalid runbook state for \"rd_…\": invalid
  //               schemaVersion; expected schema version 1.",
  //     "code": "RD-999", "details": { "title": "Unknown error" } }
  describe('invalid persisted run state (RD-309)', () => {
    it('converts InvalidRunbookStateError to RD-309 rather than RD-999', async () => {
      await withErrorHandling(async () => {
        throw new InvalidRunbookStateError(
          'Invalid runbook state for "rd_f6dbc58e5e08706a2aa8c7bec5ffd176": invalid schemaVersion; expected schema version 1.',
        );
      });

      expect(mockExit).toHaveBeenCalledWith(1);
      const parsed = parseStdoutJson();
      expect(parsed.code).toBe(Errors.invalidPersistedRunState('x').code);
      expect(parsed.code).not.toBe(Errors.unknown('x').code);
      expect(ErrorResponseSchema.safeParse(parsed).success).toBe(true);
    });

    it('names the finish / stop / prune recovery in the JSON envelope itself', async () => {
      await withErrorHandling(async () => {
        throw new InvalidRunbookStateError(
          'Invalid runbook state for "rd_f6dbc58e5e08706a2aa8c7bec5ffd176": missing templateVars.',
        );
      });

      const parsed = parseStdoutJson();
      const message = String(parsed.error);
      // `details.category`/`description` reach an operator only under
      // `--text --verbose`; the agent-facing default is this JSON `error`
      // string, so the recovery has to be *in it*.
      expect(message).toMatch(/rundown complete/);
      expect(message).toMatch(/rundown stop/);
      expect(message).toMatch(/rundown prune/);
      // The cause the store diagnosed must survive alongside the recovery.
      expect(message).toMatch(/missing templateVars/);
    });

    // Same defect class one class over: `RunbookStateManager.load` raises this
    // for a deprecated dynamic-step snapshot on the identical code path, and it
    // has the identical recovery. Leaving it on RD-999 would reinstate the gap
    // for a second shape of the same condition.
    it('converts LegacySnapshotError to RD-309 rather than RD-999', async () => {
      await withErrorHandling(async () => {
        throw new LegacySnapshotError(
          'This runbook used dynamic-step snapshots (GOTO_NEXT), which are no longer supported.',
        );
      });

      expect(mockExit).toHaveBeenCalledWith(1);
      const parsed = parseStdoutJson();
      expect(parsed.code).toBe(Errors.invalidPersistedRunState('x').code);
      expect(parsed.code).not.toBe(Errors.unknown('x').code);
      expect(String(parsed.error)).toMatch(/dynamic-step snapshots/);
    });
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
