import {
  isNodeError,
  isError,
  getErrorMessage,
  RundownError,
  ConcurrentStateModificationError,
  Errors,
  getWriter,
  IncompatibleSchemaError,
  InvalidRunbookStateError,
  LegacySnapshotError,
  NativeSqliteUnavailableError,
  SqljsUnavailableError,
  WalJournalModeUnavailableError,
} from '@rundown-org/core';
import { RunbookSyntaxError } from '@rundown-org/parser';

/**
 * Options for error handling behavior.
 */
interface ErrorHandlingOptions {
  /** Show verbose error output, appending the code's registered description */
  verbose?: boolean;
  /** Output error as human-readable text instead of JSON (JSON is the default) */
  text?: boolean;
  /** CLI command name to include in the error envelope when known. */
  command?: string;
}

/**
 * Convert any error to a RundownError for consistent handling.
 *
 * @param error - The error to convert
 * @returns A RundownError instance
 */
function toRundownError(error: unknown): RundownError {
  // Already a RundownError
  if (error instanceof RundownError) {
    return error;
  }

  // Node.js system errors
  if (isNodeError(error)) {
    if (error.code === 'ENOENT') {
      return Errors.fileNotFound(error.path ?? 'unknown');
    }
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return Errors.fileNotReadable(error.path ?? 'unknown');
    }
  }

  // Legacy RunbookSyntaxError from parser
  if (error instanceof RunbookSyntaxError) {
    return Errors.syntaxError(error.message);
  }

  // Incompatible persisted schema — surface RD-305 (with the observed/expected
  // versions) rather than a generic RD-999 crash. Reached on every store open,
  // including read-only commands, since ensureSchema runs in openRunbookDriver.
  if (error instanceof IncompatibleSchemaError) {
    return Errors.incompatibleStateSchema(error.foundVersion, error.expectedVersion);
  }

  // A database that did not enter WAL mode — RD-306. Same reasoning as RD-305
  // above: it fires while opening the store, so without this arm every command
  // reports "Unknown error" for a condition with a specific, actionable cause.
  if (error instanceof WalJournalModeUnavailableError) {
    return Errors.walJournalModeUnavailable(error.effectiveMode);
  }

  // A database that would not open at all — RD-307. `openRunbookDriver` raises
  // four disjoint classes (none extends another): the schema and WAL ones
  // handled above, and these two, which are the RESIDUAL arm — everything the
  // driver factory could not diagnose more specifically is wrapped here. It is
  // reachable by commands that open the store, not store-independent commands
  // such as `rundown check`. A read-only database file
  // and a read-only directory both fail on the write that establishes WAL, so
  // neither ever RETURNS a fallback journal mode and neither can reach
  // WalJournalModeUnavailableError; both arrive as NativeSqliteUnavailableError,
  // as do a corrupt file and a directory sitting at the database path. All four
  // were reproduced against the built CLI reporting RD-999 "Unknown error -
  // Native SQLite (node:sqlite) is unavailable ..." — a fully diagnosed cause
  // wearing the envelope that says nothing was diagnosed.
  //
  // `error.message` is forwarded rather than the code alone because the driver's
  // wording ("attempt to write a readonly database", "file is not a database",
  // "unable to open database file") is what separates the causes; node surfaces
  // them all under the single `code` of `ERR_SQLITE_ERROR`.
  if (error instanceof NativeSqliteUnavailableError) {
    return Errors.stateStoreUnavailable(error.message, error.code, error);
  }
  // The WebContainer half of the same surface. Split from the native arm only
  // because the sql.js error carries no driver code to forward.
  if (error instanceof SqljsUnavailableError) {
    return Errors.stateStoreUnavailable(error.message, undefined, error);
  }

  // A run-state write that lost its optimistic CAS — RD-308, and the only
  // storage arm here that is transient rather than a refusal. It must not share
  // RD-999 with genuinely unknown failures: the operator action is "run it
  // again", which "Unknown error" actively argues against.
  if (error instanceof ConcurrentStateModificationError) {
    return Errors.concurrentStateModification(error.runId, error.message);
  }

  // One run's persisted state that this build refuses — RD-309. The two classes
  // are the same condition in two shapes and share one arm because they share
  // one recovery: `InvalidRunbookStateError` covers unparseable persisted state,
  // a schemaVersion other than `CURRENT_SCHEMA_VERSION`, a missing
  // `templateVars` or `prompted`, and a failed schema parse; `LegacySnapshotError`
  // covers the deprecated dynamic-step snapshot. Both are cleared by
  // `rundown complete` / `rundown stop` (which route through
  // `isRecoverableActiveStackError` to drop the unusable entry) or by
  // `rundown prune`.
  //
  // Raised at BOTH readers of persisted state since #828, not only
  // `RunbookStateManager.load`: `RunbookStore.readRun` reframes its own parse
  // failure the same way, so every in-transaction read reaches this arm too. One
  // consequence is worth knowing before reading a report of it as a bug. The
  // parent-advance guard `openDelegatedChildrenFor` performs a validating read
  // of each delegated CHILD, so a `rundown pass` on a healthy parent with a
  // corrupt child now surfaces RD-309 naming the child — a run the operator did
  // not target and is nonetheless told to prune. That coupling is deliberate and
  // predates this arm (a guard that skipped unreadable children would report "no
  // open children" and advance the parent past a delegation it cannot evaluate);
  // what changed is only that the refusal now arrives classified instead of as
  // RD-999. See the note at the child read in `runbook-store.ts`.
  //
  // This arm is what makes CLAUDE.md § State Persistence's required behaviour —
  // "detect invalid state ... and prompt the user to finish or prune" —
  // reachable at all. Reproduced against the built CLI before it existed, when
  // the current version was 1:
  // RD-999 "Unknown error - Invalid runbook state for "rd_..." : invalid
  // schemaVersion; expected schema version N." An envelope titled "Unknown
  // error" cannot carry a recovery instruction, so the documented path existed
  // only in the docs.
  //
  // Ordered AFTER IncompatibleSchemaError deliberately: RD-305 is the whole
  // database (`PRAGMA user_version`) and RD-309 is one row inside it. The
  // classes are disjoint so order is not load-bearing for correctness, but the
  // narrower diagnosis must never be able to shadow the broader one.
  //
  // The `defect` both classes carry is forwarded so RD-309's envelope names the
  // run in FIELDS, not only in prose. Every production throw site supplies one;
  // the parameter is optional, so a site that does not degrades to the
  // prose-only envelope rather than losing the error.
  if (error instanceof InvalidRunbookStateError || error instanceof LegacySnapshotError) {
    return Errors.invalidPersistedRunState(error.message, error.defect);
  }

  // Generic error - wrap it
  const message = getErrorMessage(error);
  return Errors.unknown(message, isError(error) ? error : undefined);
}

/**
 * Wraps an async function with standardized error handling for CLI commands.
 *
 * Catches errors, converts them to RundownError, and outputs appropriate
 * error messages before exiting with code 1.
 *
 * @param fn - Async function to execute with error handling
 * @param options - Error display options
 */
export async function withErrorHandling(
  fn: () => Promise<void>,
  options: ErrorHandlingOptions = {},
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const rundownError = toRundownError(error);

    if (options.text) {
      console.error(rundownError.toCliString(options.verbose));
    } else {
      // Emit the documented error envelope (see docs/spec/cli-output.md
      // § Key Conventions): { kind: "error", error, code, command?, details? }.
      // This matches the shape OutputEmitter.error / JSONRenderer produce so
      // consumers see one consistent error JSON across all paths. The
      // RundownError-specific fields (category, title, context) ride in
      // `details` so no information is lost.
      const envelope: Record<string, unknown> = {
        kind: 'error',
        error: rundownError.message,
        code: rundownError.code,
      };
      if (options.command !== undefined) {
        envelope.command = options.command;
      }
      // RundownError-specific metadata travels in `details` so the documented
      // envelope is preserved while no information from RundownError.toJSON()
      // is lost.
      envelope.details = {
        category: rundownError.errorCode.category,
        title: rundownError.errorCode.title,
        context: rundownError.context,
      };
      getWriter().writeJson(envelope);
    }

    process.exit(1);
  }
}
