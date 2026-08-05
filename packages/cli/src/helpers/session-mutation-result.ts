// packages/cli/src/helpers/session-mutation-result.ts
//
// The single CLI rendering of a session ownership or transactional refusal (#608).
//
// Core returns `execution_in_progress` / `recovery_required` as typed arms of
// `SessionMutationResult`, and every front end that can receive one renders it
// here so the wire code, the message source, and the exit disposition cannot
// drift between commands. The refusal's own `message` is forwarded verbatim —
// it already names the run — rather than re-synthesized per command.
//
// The same applies to the wider transactional union a delegation seam returns.
// `transactionalRefusalCode` is the ONE `kind` → code mapping for it; the sites
// that need the emit call `renderTransactionalMutationRefusal`, the sites that
// need the code alone (goto-workflow's structured result, execution.ts's
// `ERROR_OCCURRED` payload) call the mapping directly. Restating the switch
// locally is how the two aggregate renderings drifted apart.
//
// Deliberately NOT in `refusal-renderers.ts`: that module's renderers are swept
// exhaustively by their own test, and this refusal is produced by the storage
// layer rather than by a command-policy seam. The boolean contract is shared
// with them, so a caller can `return renderSessionMutationRefusal(…)` directly
// from a switch arm.
//
// This module deliberately imports nothing but TYPES from `@rundown-org/core`.
// It is reachable from `transitions.ts` and `terminal-command.ts`, which a large
// number of CLI tests load while mocking the core barrel with a partial factory;
// a value import would make every one of those suites fail to load.

import type {
  AbandonedAttemptSetOutcome,
  GuardedMutationResult,
  SessionMutationRefusalOutcome,
} from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';

/**
 * Narrow a `kind`-discriminated outcome to a session ownership refusal.
 *
 * For unions that add the refusal arms to an otherwise unrelated result (such as
 * `OrphanCleanupResult`), where the alternative is repeating both kind literals
 * at every call site and letting them drift apart.
 *
 * @param outcome - Any outcome discriminated by a `kind` string.
 * @param outcome.kind - The outcome's discriminant.
 * @returns True when `outcome` is one of the ownership refusal arms.
 */
export function isSessionMutationRefusal(outcome: {
  readonly kind: string;
}): outcome is SessionMutationRefusalOutcome {
  return outcome.kind === 'execution_in_progress' || outcome.kind === 'recovery_required';
}

/**
 * The registered symbolic codes a session ownership refusal is emitted under.
 *
 * Spelled as literals rather than read off core's `CLIErrorCodes`, matching every
 * other CLI refusal renderer. A value import from `@rundown-org/core` here would
 * break module loading for this file — which `transitions.ts` and
 * `terminal-command.ts` pull in — in the many CLI tests that
 * `jest.unstable_mockModule` the core barrel with a partial factory. Registration
 * is enforced by the docs/code drift guard instead; `OutputEmitter.error` takes a
 * bare `string`, so there is no emit-site enforcement to preserve either way.
 */
export type SessionMutationRefusalCode = 'EXECUTION_IN_PROGRESS' | 'RECOVERY_REQUIRED';

/**
 * Transactional refusals shared by delegation mutation commands.
 *
 * DERIVED from core's canonical result types, never re-declared. A structurally
 * parallel restatement compiles, but it de-brands `RunId` / `ExecutionEpoch`
 * down to `string` / `number`, drops the `runId` every CAS refusal carries, and
 * lets the two spellings drift — the "no parallel result types" defect. The
 * composition mirrors `DelegationAbortOutcome`'s own refusal arms exactly, which
 * is the union every delegation seam actually returns.
 */
export type TransactionalMutationRefusal =
  | Extract<
      GuardedMutationResult<never>,
      {
        readonly kind:
          | 'claim_superseded'
          | 'concurrent_modification'
          | 'execution_in_progress'
          | 'recovery_required'
          | 'missing';
      }
    >
  | AbandonedAttemptSetOutcome;

/**
 * Narrow a `kind`-discriminated outcome to a transactional mutation refusal.
 *
 * The wider twin of {@link isSessionMutationRefusal}, for a union that adds the
 * transactional arms to an unrelated result — `CollectionWorkflowResult` being
 * the case that motivated it, where the alternative is repeating six kind
 * literals at the call site and letting them drift from
 * {@link transactionalRefusalCode}'s switch.
 *
 * Derived from the union rather than spelled as a literal list, so a member
 * added to {@link TransactionalMutationRefusal} is recognized here without a
 * second edit. The runtime check stays a `Set` membership test on the
 * discriminant; only its contents are type-derived.
 *
 * @param outcome - Any outcome discriminated by a `kind` string.
 * @param outcome.kind - The outcome's discriminant.
 * @returns True when `outcome` is one of the transactional refusal arms.
 */
export function isTransactionalMutationRefusal(outcome: {
  readonly kind: string;
}): outcome is TransactionalMutationRefusal {
  return (TRANSACTIONAL_REFUSAL_KINDS as ReadonlySet<string>).has(outcome.kind);
}

/**
 * The discriminants of {@link TransactionalMutationRefusal}.
 *
 * Typed as `ReadonlySet<TransactionalMutationRefusal['kind']>` and initialized
 * from an array annotated with the same element type, so dropping a member is a
 * type error rather than a silently narrower guard. `Set` cannot enforce
 * exhaustiveness on its own — the annotation is what ties this to the union.
 */
const TRANSACTIONAL_REFUSAL_KINDS: ReadonlySet<TransactionalMutationRefusal['kind']> = new Set<
  TransactionalMutationRefusal['kind']
>([
  'claim_superseded',
  'concurrent_modification',
  'execution_in_progress',
  'recovery_required',
  'missing',
  'aggregate_recovery_required',
]);

/**
 * The registered symbolic codes a transactional delegation refusal is emitted under.
 *
 * A strict superset of {@link SessionMutationRefusalCode}. `AGGREGATE_RECOVERY_REQUIRED`
 * is deliberately distinct from the single-run `RECOVERY_REQUIRED`: only the
 * aggregate arm carries `details.runs`, so an agent routing on `code` must be
 * able to tell the two envelope shapes apart without inspecting `details`.
 */
export type TransactionalMutationRefusalCode =
  | SessionMutationRefusalCode
  | 'STALE_CLAIM'
  | 'CONCURRENT_MODIFICATION'
  | 'RUN_TARGET_UNAVAILABLE'
  | 'AGGREGATE_RECOVERY_REQUIRED';

/**
 * Map a session ownership refusal to its registered symbolic error code.
 *
 * The sole `kind` → code mapping, so the error envelope and the `ERROR_OCCURRED`
 * execution event cannot disagree about the same refusal.
 *
 * @param refusal - Ownership refusal returned by core.
 * @returns The registered code for the refusal's kind.
 * @throws {Error} If an unrecognized refusal variant reaches the exhaustive guard.
 */
export function sessionMutationRefusalCode(
  refusal: SessionMutationRefusalOutcome,
): SessionMutationRefusalCode {
  switch (refusal.kind) {
    case 'execution_in_progress':
      return 'EXECUTION_IN_PROGRESS';
    case 'recovery_required':
      return 'RECOVERY_REQUIRED';
    default: {
      // Name the discriminant only, never the whole refusal: an unrecognized
      // variant is by definition one whose fields this build does not know, and
      // serializing it wholesale would put unreviewed payload into an error
      // message (and thence into logs).
      const _exhaustive: never = refusal;
      throw new Error(
        `Unhandled session mutation refusal: ${(_exhaustive as { kind: string }).kind}`,
      );
    }
  }
}

/**
 * Render a session ownership refusal under its registered symbolic code.
 *
 * The run id travels inside core's `message`, matching the flat documented error
 * envelope (`docs/spec/cli-output.md`); no envelope field is invented for it,
 * and no front end re-synthesizes the text.
 *
 * @param output - Output emitter for CLI output.
 * @param refusal - Ownership refusal returned by core.
 * @returns `true` — an ownership refusal always requests a non-zero exit code.
 */
export function renderSessionMutationRefusal(
  output: OutputEmitter,
  refusal: SessionMutationRefusalOutcome,
): boolean {
  output.error(refusal.message, sessionMutationRefusalCode(refusal));
  return true;
}

/**
 * Map a transactional delegation refusal to its registered symbolic error code.
 *
 * The sole `kind` → code mapping for the six-member transactional union, so the
 * error envelope, the structured workflow result, and the `ERROR_OCCURRED`
 * execution event cannot disagree about the same refusal. Call this at the sites
 * that need the code itself (`goto-workflow`, `execution`); call
 * {@link renderTransactionalMutationRefusal} at the sites that need the emit.
 *
 * @param refusal - Transactional refusal returned by a core delegation seam.
 * @returns The registered code for the refusal's kind.
 * @throws {Error} If an unrecognized refusal variant reaches the exhaustive guard.
 */
export function transactionalRefusalCode(
  refusal: TransactionalMutationRefusal,
): TransactionalMutationRefusalCode {
  switch (refusal.kind) {
    case 'execution_in_progress':
    case 'recovery_required':
      return sessionMutationRefusalCode(refusal);
    case 'claim_superseded':
      return 'STALE_CLAIM';
    case 'concurrent_modification':
      return 'CONCURRENT_MODIFICATION';
    case 'missing':
      return 'RUN_TARGET_UNAVAILABLE';
    case 'aggregate_recovery_required':
      return 'AGGREGATE_RECOVERY_REQUIRED';
    default: {
      // Name the discriminant only, for the same reason
      // `sessionMutationRefusalCode` does: an unrecognized variant is one whose
      // fields this build does not know, and serializing it wholesale would put
      // unreviewed payload into an error message (and thence into logs).
      const _exhaustive: never = refusal;
      throw new Error(
        `Unhandled transactional mutation refusal: ${(_exhaustive as { kind: string }).kind}`,
      );
    }
  }
}

/**
 * Render a transactional delegation refusal under its registered symbolic code.
 *
 * A strict superset of {@link renderSessionMutationRefusal}, and returns the same
 * `boolean` for the same reason: it is the shared refusal-renderer protocol (see
 * `refusal-renderers.ts`), so an aggregating switch whose sibling arms render
 * exit-0 outcomes can `return render…(…)` from this arm. It is not a per-refusal
 * exit disposition — every arm here refuses, so callers that map straight to
 * `process.exitCode` assign `1` unconditionally rather than branching on it.
 *
 * @param output - Output emitter for CLI output.
 * @param refusal - Transactional refusal returned by a core delegation seam.
 * @returns `true` — a transactional refusal always requests a non-zero exit code.
 * @throws {Error} If an unrecognized refusal variant reaches the exhaustive guard.
 */
export function renderTransactionalMutationRefusal(
  output: OutputEmitter,
  refusal: TransactionalMutationRefusal,
): boolean {
  const code = transactionalRefusalCode(refusal);
  if (refusal.kind === 'aggregate_recovery_required') {
    // The one arm with structured details. Name the exact set: a multi-run
    // refusal already carries every (runId, epoch), and rendering the message
    // alone tells the operator recovery is needed while withholding what to
    // recover. `epoch` is a branded `number`, so it needs no coercion to
    // serialize — the former `Number(epoch)` was a no-op that made the two
    // aggregate renderings look like they disagreed.
    output.error(refusal.message, code, {
      runs: refusal.attempts.map(({ runId, epoch }) => ({ runId, epoch })),
    });
    return true;
  }
  output.error(refusal.message, code);
  return true;
}
