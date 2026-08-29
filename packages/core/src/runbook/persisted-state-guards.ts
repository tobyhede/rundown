/**
 * The gates every reader of persisted run state runs before validating it, and
 * the schema version they are written against.
 *
 * A leaf module on purpose. Both readers of persisted run state need these
 * gates — `RunbookStateManager.load` before it validates a run file, and
 * `RunbookStore.readRun` before it validates a run row inside an open
 * transaction — and `runbook/state.ts` already depends on
 * `runbook/storage/runbook-store.ts` for `guardOptions`. Housing the constant,
 * the errors, and the checks here keeps the store's dependency pointing at a
 * leaf instead of closing a runtime import cycle, and makes the two call sites
 * share one order, one taxonomy, and one message by construction rather than by
 * convention.
 *
 * That sharing covers the structural parse as well as the gates before it. It
 * did not always: the parse was called directly at each reader, `load` reframed
 * its failure and the store did not, and the difference was a bare `ZodError`
 * reaching the operator as RD-999 "Unknown error" from every in-transaction
 * read (#828). {@link parsePersistedRunState} is the parse both now call, for
 * the same reason the gates are shared — a taxonomy split across two call sites
 * is one edit away from diverging again.
 *
 * Leaf in the sense that matters — the runbook graph. The one runtime import is
 * `logger`, which pulls in nothing but node builtins and so cannot close a cycle
 * back through the store.
 *
 * `runbook/state.ts` re-exports both error classes, so it stays the import site
 * every existing consumer names. There is exactly one definition of each: a
 * second copy would give the CLI's `instanceof` classification two identities to
 * miss.
 *
 * @module runbook/persisted-state-guards
 */

import type { z } from 'zod';
import type { InvalidRunStateDefect } from '../errors/rundown-error.js';
import { logger } from '../logger.js';
import type { RunbookState } from './types.js';

/**
 * Current persisted state schema version.
 *
 * Every newly derived state is stamped with this version; every read of
 * persisted state rejects any other one. Exported so callers deriving state
 * outside the manager — and the tests pinning that guarantee — name the version
 * rather than hard-coding a literal. Hard-coding one is how this constant went
 * stale: nothing forced a fixture to move with it, so nothing failed when it
 * did not move. `packages/core/__tests__/runbook/persisted-state-shape.test.ts`
 * is what forces the pairing now.
 *
 * A version mismatch is a rejection, never a migration: state carrying any
 * other value is refused outright, not read, adapted, or rewritten (CLAUDE.md
 * § State Persistence). Historically, three PRs added a required field while
 * this stood at `1` — `StepInlineChild.startedAt` (#746),
 * `StepInlineChild.started` replacing it (#772), and `RunbookState.prompted`
 * (#827) — without moving it (#775). Same-version state from before those
 * fields passed the version gate and was refused later by the shared Zod parse
 * as `schema_validation_failed` (#828). That history explains why a structural
 * fixture now forces the version judgment; it does not describe current v2
 * state. Since this constant is `2`, every v1 row is foreign and is refused by
 * this gate as `invalid_schema_version` before structural parsing.
 *
 * Version `2` records #855's XState-owned Run Progression entry and frontier
 * projection states. Those changes live inside the opaque snapshot and are
 * invisible to the Zod structural parse, so the version gate is the only way
 * to refuse a v1 snapshot whose state IDs the current machine does not
 * understand. Per the no-migration rule, development runs restart.
 *
 * Move this constant when a change to `RunbookState` (`runbook/types.ts`) or
 * `RunbookStateObjectSchema` (`schemas.ts`) is one the Zod structural parse
 * cannot itself refuse. The opaque `snapshot` field, declared `z.unknown()` on
 * purpose, is the standing example: a change to the XState machine's context
 * shape or state IDs is invisible to it, so nothing else will refuse a stale
 * snapshot.
 */
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * Thrown when a persisted state file does not match the current schema contract.
 */
export class InvalidRunbookStateError extends Error {
  /**
   * Structured facts about the refusal, lifted from the throw site.
   *
   * Surfaces as RD-309's `context` so a consumer never has to parse the run id
   * out of `message`. `undefined` only where a construction site supplies none
   * — every production throw site does.
   */
  readonly defect: InvalidRunStateDefect | undefined;

  /**
   * Create a new InvalidRunbookStateError.
   *
   * @param message - Human-readable description of why the state is invalid
   * @param defect - Structured facts about the refused run
   */
  constructor(message: string, defect?: InvalidRunStateDefect) {
    super(message);
    this.name = 'InvalidRunbookStateError';
    this.defect = defect;
  }
}

/**
 * Thrown when a persisted state file uses the deprecated dynamic-step snapshot
 * shape (`GOTO_NEXT` last action or `instance` field), which the current
 * runtime rejects per the no-migration rule.
 *
 * A dedicated class so consumers (e.g. the CLI's orphaned-active-stack
 * recovery) classify by type rather than matching message wording.
 */
export class LegacySnapshotError extends Error {
  /**
   * Structured facts about the refusal, lifted from the throw site.
   *
   * Surfaces as RD-309's `context` so a consumer never has to parse the run id
   * out of `message`. `undefined` only where a construction site supplies none
   * — every production throw site does.
   */
  readonly defect: InvalidRunStateDefect | undefined;

  /**
   * Create a new LegacySnapshotError.
   *
   * @param message - Human-readable description of the rejected legacy shape
   * @param defect - Structured facts about the refused run
   */
  constructor(message: string, defect?: InvalidRunStateDefect) {
    super(message);
    this.name = 'LegacySnapshotError';
    this.defect = defect;
  }
}

/**
 * Reject persisted runbook state that does not carry {@link CURRENT_SCHEMA_VERSION}.
 *
 * Persisted state is never migrated: a foreign version — or an absent one, which
 * is the only other shape the store's deliberately-optional `schemaVersion` field
 * lets through — is refused so the caller can finish, stop, prune, or restart.
 * Silently parsing it would adapt data the no-migration rule forbids adapting.
 *
 * Building the RD-309 defect here rather than at the call sites is the same
 * consolidation as the message: the found version rides in `schemaVersion` and
 * nowhere else — the message never states it, so a consumer could not recover it
 * at all — and one gate cannot drop it on one of its two callers.
 *
 * @param schemaVersion - The `schemaVersion` field as persisted, unvalidated
 * @param id - Run id, quoted into the message so the caller knows which run to prune
 * @throws {InvalidRunbookStateError} When `schemaVersion` is not the current version
 */
export function assertCurrentSchemaVersion(schemaVersion: unknown, id: string): void {
  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new InvalidRunbookStateError(
      `Invalid runbook state for "${id}": invalid schemaVersion; expected schema version ${String(CURRENT_SCHEMA_VERSION)}.`,
      { runId: id, reason: 'invalid_schema_version', schemaVersion },
    );
  }
}

/**
 * Reject a raw persisted run row that the current runtime must not load.
 *
 * The single implementation of the pre-validation gates, run in this order:
 *
 * 1. a `GOTO_NEXT` `lastAction` — a dynamic-step snapshot
 * 2. a top-level `instance` field — the other dynamic-step snapshot shape
 * 3. a `schemaVersion` that is not {@link CURRENT_SCHEMA_VERSION}
 * 4. an absent `templateVars`
 * 5. an absent `prompted`
 *
 * Order is part of the contract, not an accident: a legacy row also fails the
 * version check, and the legacy message is the actionable one ("restart from the
 * entrypoint") where the version message only names the run. Reversing the gates
 * would silently downgrade what a user with a pre-v1 run is told. Gates 4 and 5
 * come last for the same reason from the other side: the structural parse
 * requires both fields anyway, so naming them here only improves on that
 * parse's generic refusal for a row which is otherwise current.
 *
 * Both readers of persisted state call this before the shared structural parse
 * in {@link parsePersistedRunState} — `RunbookStateManager.load` on the file it
 * just read, `RunbookStore.readRun` on the row it just reassembled inside an
 * open transaction — so a shape one refuses can never be parsed and mutated
 * through the other.
 *
 * The parse alone is not a substitute for any of these gates, for two different
 * reasons. The run schema leaves `schemaVersion` optional on purpose (so `load`
 * can parse an invalid file far enough to report it usefully), so gate 3 is the
 * only thing standing between a foreign version and a successful read — nothing
 * downstream refuses it at all.
 *
 * The other four the parse does reject, so what they buy is the DIAGNOSIS, not
 * the refusal. Measured, ungated: `invalid_union` / "No matching discriminator"
 * for `GOTO_NEXT`, `unrecognized_keys ["instance"]` for the other legacy shape,
 * and a required-field issue for each of gates 4 and 5. Since #828 that lands
 * as `InvalidRunbookStateError` / `schema_validation_failed`, which the CLI's
 * recovery paths do classify — so dropping a gate no longer strands a run, and
 * the cost is narrower than it once was but still real: a pre-v1 run is told
 * "schema validation failed" instead of "restart execution from the runbook
 * entrypoint", under `InvalidRunbookStateError` rather than the
 * `LegacySnapshotError` class a consumer can branch on, and a row missing one
 * required field stops naming which. Before #828 the same drop was worse than
 * a downgrade — a bare `ZodError`, outside the taxonomy entirely, turning
 * "restart from the entrypoint" into an unrecoverable internal fault.
 *
 * @param raw - The reassembled state object exactly as persisted, unvalidated
 * @param id - Run id, quoted into the message so the caller knows which run to prune
 * @throws {LegacySnapshotError} When the row carries a deprecated dynamic-step
 *   snapshot shape
 * @throws {InvalidRunbookStateError} When the row carries a schema version other
 *   than {@link CURRENT_SCHEMA_VERSION}, or is missing `templateVars` or
 *   `prompted`
 */
export function assertLoadablePersistedRun(raw: Record<string, unknown>, id: string): void {
  const lastAction = raw.lastAction;
  if (
    typeof lastAction === 'object' &&
    lastAction !== null &&
    (lastAction as Record<string, unknown>).type === 'GOTO_NEXT'
  ) {
    throw new LegacySnapshotError(
      'This runbook used dynamic-step snapshots (GOTO_NEXT), which are no longer supported. ' +
        'Please restart execution from the runbook entrypoint.',
      { runId: id, reason: 'legacy_dynamic_step_snapshot' },
    );
  }
  if (raw.instance !== undefined) {
    throw new LegacySnapshotError(
      'This runbook used dynamic-step snapshots (instance field), which are no longer supported. ' +
        'Please restart execution from the runbook entrypoint.',
      { runId: id, reason: 'legacy_dynamic_step_snapshot' },
    );
  }
  assertCurrentSchemaVersion(raw.schemaVersion, id);

  // A current-schema row without templateVars is incompatible state. Readers
  // substitute `runbookSrc` against it on every resume; re-parsing the stored
  // source to stand in for it would be a silent migration. Named explicitly
  // rather than left to the structural parse so the refusal says which field is
  // missing and what to do about it.
  if (raw.templateVars === undefined) {
    throw new InvalidRunbookStateError(
      `Invalid runbook state for "${id}": missing templateVars. ` +
        `Prune this run and re-run the runbook.`,
      { runId: id, reason: 'missing_template_vars' },
    );
  }

  // Same rule, same reason. `prompted` decides whether the run announces its
  // commands or executes them, and it is the value a composing parent inherits
  // down into a fresh inline child. Defaulting an absent one at the read sites
  // would silently adapt an incompatible row into an executing run;
  // `RunbookStateManager.create` always writes the field, so a row without it
  // originates outside this codebase's only creation path.
  if (raw.prompted === undefined) {
    throw new InvalidRunbookStateError(
      `Invalid runbook state for "${id}": missing prompted. ` +
        `Prune this run and re-run the runbook.`,
      { runId: id, reason: 'missing_prompted' },
    );
  }
}

/**
 * Validate a gated persisted run row, refusing a parse failure in this module's
 * own taxonomy.
 *
 * The counterpart to {@link assertLoadablePersistedRun}, and the reason the two
 * readers share a taxonomy PAST the gates as well as before them. Both reach
 * this function with a row that cleared every gate and can still be refused —
 * corruption, a hand-edited `state_json`, a partial write, or a shape that
 * drifted in a build that left {@link CURRENT_SCHEMA_VERSION} where it was.
 *
 * A bare `ZodError` is the wrong shape for that refusal at either reader, which
 * is what made this worth consolidating (#828): it is neither class the CLI's
 * `isRecoverableActiveStackError` accepts, nor an arm its `toRundownError`
 * classifies, so it reached the operator as RD-999 "Unknown error" carrying a
 * schema dump — and `complete` / `stop` / `prune`, which all branch on refusal
 * class, could not clear the run it names. Reframing here rather than at each
 * call site is what stops one reader from getting it and the other not.
 *
 * The refusal is still a refusal: nothing is adapted, defaulted, or rewritten,
 * and the row is left exactly as persisted (CLAUDE.md § State Persistence).
 *
 * @param raw - The reassembled state object, already past
 *   {@link assertLoadablePersistedRun}
 * @param id - Run id, quoted into the message so the caller knows which run to prune
 * @param schema - The run-state schema to validate against, supplied by the
 *   caller because it is built per project root
 * @returns The validated run state
 * @throws {InvalidRunbookStateError} When `raw` fails `schema`
 */
export function parsePersistedRunState(
  raw: Record<string, unknown>,
  id: string,
  schema: z.ZodType,
): RunbookState {
  const result = schema.safeParse(raw);
  if (!result.success) {
    // The refusal names the run and nothing else, deliberately: the message is
    // an operator instruction, not a schema report. That drops the one signal
    // the old bare `ZodError` did carry — which field failed — so it goes to
    // the debug log instead of nowhere (RUNDOWN_LOG_LEVEL=debug), which is the
    // same trail `lifecycle-write` leaves. Paths and codes only: an issue can
    // quote the value it rejected, and persisted state holds delegation tokens.
    void logger.debug('invalid-run-state', {
      runId: id,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
      })),
    });
    throw new InvalidRunbookStateError(
      `Invalid runbook state for "${id}": schema validation failed.`,
      { runId: id, reason: 'schema_validation_failed' },
    );
  }
  // Zod's .regex() refinement narrows at runtime but infers as `string` at the
  // type level. The schema guarantees GOTO `at` matches TEMPLATE_VAR_PATTERN;
  // cast to the stricter TS type.
  return result.data as RunbookState;
}
