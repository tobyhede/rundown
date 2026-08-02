// packages/cli/src/helpers/session-mutation-result.ts
//
// The single CLI rendering of a session ownership refusal (#608).
//
// Core returns `execution_in_progress` / `recovery_required` as typed arms of
// `SessionMutationResult`, and every front end that can receive one renders it
// here so the wire code, the message source, and the exit disposition cannot
// drift between commands. The refusal's own `message` is forwarded verbatim —
// it already names the run — rather than re-synthesized per command.
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

import type { SessionMutationRefusalOutcome } from '@rundown-org/core';
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

/** Transactional refusals shared by delegation mutation commands. */
export type TransactionalMutationRefusal =
  | SessionMutationRefusalOutcome
  | {
      readonly kind: 'claim_superseded' | 'concurrent_modification' | 'missing';
      readonly message: string;
    }
  | {
      readonly kind: 'aggregate_recovery_required';
      readonly message: string;
      readonly attempts: readonly { readonly runId: string; readonly epoch: number }[];
    };

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
 */
export function renderTransactionalMutationRefusal(
  output: OutputEmitter,
  refusal: TransactionalMutationRefusal,
): boolean {
  switch (refusal.kind) {
    case 'execution_in_progress':
    case 'recovery_required':
      return renderSessionMutationRefusal(output, refusal);
    case 'claim_superseded':
      output.error(refusal.message, 'STALE_CLAIM');
      return true;
    case 'concurrent_modification':
      output.error(refusal.message, 'CONCURRENT_MODIFICATION');
      return true;
    case 'missing':
      output.error(refusal.message, 'RUN_TARGET_UNAVAILABLE');
      return true;
    case 'aggregate_recovery_required':
      output.error(refusal.message, 'RECOVERY_REQUIRED', {
        runs: refusal.attempts.map(({ runId, epoch }) => ({ runId, epoch })),
      });
      return true;
  }
}
