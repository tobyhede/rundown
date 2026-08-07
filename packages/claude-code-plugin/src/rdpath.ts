#!/usr/bin/env node
/**
 * CLI entry point for the rdpath path-assembly tool.
 *
 * Assembles artifact paths with optional context scoping and date-prefixed filenames.
 * Provides glob-based file discovery within artifact directories.
 *
 * @module
 */

import { Command } from 'commander';
import {
  assembleRdPath,
  findRdPathFiles,
  IncompatibleSchemaError,
  InvalidRunbookStateError,
  InvalidRunIdError,
  LegacySnapshotError,
  NativeSqliteUnavailableError,
  SqljsUnavailableError,
} from '@rundown-org/core';
import { readActiveRunScope } from '@rundown-org/core/session-reader';
import { getErrorMessage, isError, isNodeError } from './shared/errors.js';

const program = new Command();
program
  .name('rdpath')
  .description('Assemble artifact paths with optional context scoping')
  .enablePositionalOptions()
  .helpCommand(false)
  .option('--dir <path>', 'Base directory (defaults to $RD_WORK_PATH)')
  .option('--ctx <id>', 'Context scope (defaults to $RD_CONTEXT_ID)');

interface ResolvedScope {
  dir: string;
  ctx?: string;
}

interface ActiveStateScope {
  dir?: string;
  ctx?: string;
}

/**
 * Resolve WorkPath / ContextId from the active runbook state.
 *
 * This goes through the core session-reader helper rather than parsing
 * persisted state files directly.
 *
 * @returns Active-state scope values, or an empty object when no runbook is active.
 */
async function resolveActiveStateScope(): Promise<ActiveStateScope> {
  const { workPath, contextId } = await readActiveRunScope(process.cwd());
  const activeScope: ActiveStateScope = {};

  if (workPath !== undefined) {
    activeScope.dir = workPath;
  }
  if (contextId !== undefined) {
    activeScope.ctx = contextId;
  }

  return activeScope;
}

/**
 * Message fragment identifying the untyped session-validation failure.
 *
 * `RunbookStateManager.loadSession` throws a bare `Error` when the session it
 * reconstructs from the store's typed columns fails `SessionDataSchema`, so
 * there is no class and no distinguishing `name` to match on. Pinned by an
 * integration fixture that produces the error through the real store, so a
 * reworded or retyped failure in core fails the suite rather than silently
 * turning this branch into a dead string.
 */
const INVALID_SESSION_DATA_MESSAGE = 'Session data is invalid for this runbook schema';

/**
 * `errno` codes for a filesystem refusal raised while opening the store.
 *
 * Core reaches the filesystem directly before handing off to `node:sqlite` — it
 * creates `.rundown/` and hardens the database file mode — so these escape as
 * raw Node errors rather than as a storage error. `EEXIST` is the case where
 * `.rundown` exists as a regular file.
 */
const STORE_OPEN_ERROR_CODES: ReadonlySet<string> = new Set([
  'EACCES',
  'EEXIST',
  'EISDIR',
  'ENOTDIR',
  'EPERM',
]);

/**
 * Decide whether a failed active-state lookup may be skipped rather than
 * propagated.
 *
 * Every arm names the same condition: the persisted run store cannot be read by
 * this build. Rundown never migrates persisted state, so the recovery path is
 * the user's (prune, finish, restart) — it is not a reason to fail a path
 * assembly whose base directory is already known from a flag or the environment.
 * Anything else is a real fault and must reach the user.
 *
 * Every class arm is an `instanceof` against a core export rather than a match
 * on `error.name` or on message text. Both string forms previously lived here
 * and both were the same defect: renaming or rewording in core turns the branch
 * into silently dead code with a green suite, whereas `instanceof` against a
 * removed or renamed export fails `tsc`. The plugin imports `@rundown-org/core`
 * as an ordinary package dependency in the same process — no worker, no vm, no
 * second copy — so `instanceof` is same-realm and reliable here; verified by
 * running the real store-open failure through `readActiveRunScope` in this
 * package's own resolution and observing `instanceof NativeSqliteUnavailableError
 * === true`. (Structural guards remain correct for genuinely cross-realm values
 * — see `isZodError` in `shared/errors.ts`.)
 *
 * `NativeSqliteUnavailableError` / `SqljsUnavailableError` are core's storage
 * driver-factory refusals: `.rundown/rundown.db` is not a database, a directory
 * sits in its place, the path is unreadable, or the host's SQLite adapter cannot
 * initialize. `InvalidRunIdError` is a persisted id that is not
 * `rd_<32 lowercase hex chars>`; the session read reaches it for every
 * `session_stack` row and for the stash slot, so one corrupt id fails the whole
 * lookup. That state is representable — `runs.id` is `TEXT PRIMARY KEY NOT NULL`
 * with no format CHECK, so `session_stack`'s foreign key forbids a *dangling* id
 * but not a *malformed* one — and reaching it needs out-of-band corruption, but
 * `rdpath` is a hook binary where skipping an unreadable context id beats exiting
 * non-zero on an invocation whose base directory was already supplied.
 *
 * @param error - The value thrown by the active-state lookup.
 * @returns True when the lookup may be treated as "no active state".
 */
function isRecoverableActiveStateLookupError(error: unknown): boolean {
  if (
    error instanceof InvalidRunbookStateError ||
    error instanceof LegacySnapshotError ||
    error instanceof IncompatibleSchemaError ||
    error instanceof NativeSqliteUnavailableError ||
    error instanceof SqljsUnavailableError ||
    error instanceof InvalidRunIdError
  ) {
    return true;
  }

  if (!isError(error)) return false;

  if (error.message.includes(INVALID_SESSION_DATA_MESSAGE)) {
    return true;
  }

  if (isNodeError(error)) {
    const errorPath = typeof error.path === 'string' ? error.path : '';
    return (
      typeof error.code === 'string' &&
      STORE_OPEN_ERROR_CODES.has(error.code) &&
      errorPath.includes('.rundown')
    );
  }

  return false;
}

/**
 * Resolve `--dir` / `--ctx` from the program-level options, falling back to
 * `RD_WORK_PATH` / `RD_CONTEXT_ID`, then the active runbook state. Writes the
 * canonical "--dir is required" error to stderr and sets `process.exitCode = 1`
 * when no base directory is available.
 *
 * Active-state lookup runs in two modes. When `dir` cannot be resolved from
 * flag or env, the lookup is mandatory and any error from the run store
 * (unreadable database, invalid persisted state) propagates so the user sees the
 * real cause. When only `ctx` is missing, the lookup is best-effort: state this
 * build cannot read is silently skipped — see
 * {@link isRecoverableActiveStateLookupError} — so the path resolves without a
 * context segment rather than failing an otherwise valid invocation.
 *
 * @returns The resolved scope, or `null` when no `dir` could be determined.
 */
async function resolveScope(): Promise<ResolvedScope | null> {
  const opts = program.opts<{ dir?: string; ctx?: string }>();
  const flagOrEnvDir = opts.dir ?? process.env.RD_WORK_PATH;
  const flagOrEnvCtx = opts.ctx ?? process.env.RD_CONTEXT_ID;

  let activeScope: ActiveStateScope = {};
  if (flagOrEnvDir === undefined) {
    activeScope = await resolveActiveStateScope();
  } else if (flagOrEnvCtx === undefined) {
    try {
      activeScope = await resolveActiveStateScope();
    } catch (error) {
      if (!isRecoverableActiveStateLookupError(error)) {
        throw error;
      }
      activeScope = {};
    }
  }

  const dir = flagOrEnvDir ?? activeScope.dir;
  const ctx = flagOrEnvCtx ?? activeScope.ctx;
  if (!dir) {
    process.stderr.write('error: --dir is required (or set $RD_WORK_PATH)\n');
    process.exitCode = 1;
    return null;
  }
  return { dir, ctx };
}

const pathCmd = new Command('path')
  .description('Assemble an artifact path')
  .option('--file <name>', 'Filename to date-prefix (YYYY-MM-DD)')
  .action(async (options: { file?: string }) => {
    try {
      const scope = await resolveScope();
      if (!scope) return;
      process.stdout.write(`${assembleRdPath({ ...scope, file: options.file })}\n`);
    } catch (error) {
      const message = getErrorMessage(error);
      process.stderr.write(`error: ${message}\n`);
      process.exitCode = 1;
    }
  });

const findCmd = new Command('find')
  .description(
    'Find files matching a glob pattern in an artifact directory. ' +
      'Exits 1 when zero files match (for runbook flow control); ' +
      'pass --allow-empty to treat an empty result as success.',
  )
  .argument('<pattern>', 'Glob pattern to match files against')
  .option('--allow-empty', 'Exit 0 when zero files match (default: exit 1 on empty)')
  .action(async (pattern: string, options: { allowEmpty?: boolean }) => {
    try {
      const scope = await resolveScope();
      if (!scope) return;
      const results = await findRdPathFiles(scope, pattern);
      for (const result of results) {
        process.stdout.write(`${result}\n`);
      }
      // Empty-match is a signal, not an error: exit 1 with no stderr output
      // so callers can distinguish "no matches" (stderr empty) from a real
      // error like a bad pattern (stderr starts with "error:").
      if (results.length === 0 && !options.allowEmpty) {
        process.exitCode = 1;
      }
    } catch (error) {
      const message = getErrorMessage(error);
      process.stderr.write(`error: ${message}\n`);
      process.exitCode = 1;
    }
  });

program.addCommand(pathCmd, { isDefault: true });
program.addCommand(findCmd);

program.parse();
