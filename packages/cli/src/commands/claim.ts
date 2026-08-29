import { type Command, Option } from 'commander';
import {
  DELEGATION_TOKEN_PREFIX,
  ErrorCodes,
  RunbookStateManager,
  SessionService,
  ExecutionLifecycleService,
} from '@rundown-org/core';
import { createCliRunbookActorService } from '../helpers/actor-service-factory.js';
import { getCwd } from '../helpers/context.js';
import { withErrorHandling } from '../helpers/wrapper.js';
import { OutputEmitter } from '../services/output-emitter.js';
import { commandStreamOptionsForOutputMode } from '../services/execution.js';
import {
  parseArtifactJsonOption,
  parseArtifactOption,
  parseInputOption,
  parseInputJsonOption,
  collect,
} from '../helpers/option-utils.js';
import {
  claimAndLaunch,
  type ClaimFailure,
  type RunPipelineContext,
} from '../helpers/runbook-pipeline.js';
import { renderSessionMutationRefusal } from '../helpers/session-mutation-result.js';
import {
  createCliRunProgressionDriver,
  progressionFailedClosed,
} from '../helpers/run-progression-adapters.js';

/** One `rundown claim` refusal, rendered as the CLI's flat error envelope. */
export interface ClaimFailureEnvelope {
  /**
   * Code an agent routes on.
   *
   * `string`, and NOT `CLIErrorCode`, which is what it should be: a typo here
   * compiles and only surfaces if some test validates the envelope against
   * `ErrorCodeSchema`. Narrowing it was tried and does not build, because two
   * arms already emit codes the registry does not carry —
   * `delegation-already-claimed` renders the symbolic
   * `'DELEGATION_ALREADY_CLAIMED'` (only the RD-811 VALUE is registered, not
   * that spelling), and `prepare-failed` forwards `PrepareFailure['code']`
   * (`POLICY_DENIED`, `MISSING_REQUIRED_VARS`, …), none of which is registered
   * either. Both predate #807 and both mean those envelopes fail the schema
   * they document; registering the missing codes is a public-surface decision
   * of its own, tracked separately rather than smuggled in here.
   */
  readonly code: string;
  /** Operator-facing message. */
  readonly message: string;
  /** Structured facts the code alone does not carry. */
  readonly details?: Record<string, unknown>;
}

/**
 * Map one claim refusal onto the code and message the claimer receives.
 *
 * Exported for the test that pins every arm's code and message character for
 * character, and deliberately not re-exported from the package: it is not a
 * public contract. The pin is what this mapping was missing — four distinct,
 * correctly-discriminated reasons collapsed onto `TOKEN_NOT_FOUND` with no test
 * observing it, and three of them were not about the token at all (#807).
 *
 * @param failure - The refusal the claim pipeline returned, minus the session
 *   arm, which has its own shared renderer.
 * @returns The envelope to emit.
 * @throws {Error} When an unrecognized refusal reaches the exhaustive guard.
 */
export function claimFailureToEnvelope(
  failure: Exclude<ClaimFailure, { reason: 'session-refused' }>,
): ClaimFailureEnvelope {
  switch (failure.reason) {
    case 'invalid-token':
      return {
        code: 'INVALID_TOKEN',
        message: `Invalid token format. Tokens must start with "${DELEGATION_TOKEN_PREFIX}".`,
        details: { token: failure.token },
      };
    case 'token-not-found':
      return {
        code: 'TOKEN_NOT_FOUND',
        message: 'No active run contains a delegation with this token.',
        details: { token: failure.token },
      };
    case 'parent-missing':
      // NOT `TOKEN_NOT_FOUND`: the scan found the token and it was valid. The
      // sibling of `CHILD_RUN_MISSING` at the other end of the same linkage,
      // and the code core's own classification of this fact already implies —
      // `classifyDelegationLiveness` reports it as `parent-unreadable`, a
      // corruption signal, never as a supersession. Same code whether this
      // pre-read saw it or the claim transaction did (`missing-parent` reaches
      // `claimResultToFailure` as this same reason).
      return {
        code: 'PARENT_RUN_MISSING',
        message: `Parent run ${failure.parentRunId} no longer exists.`,
        details: { parentRunId: failure.parentRunId },
      };
    case 'parent-ended':
      // The pre-read and the claim transaction now report the identical fact
      // under the identical code (#807). Core is the classification owner:
      // `classifyDelegationLiveness` closes an ended parent `parent-ended`, and
      // both consumers of that reason — `claimRunbookInTransaction` and
      // `describeSupersededClaim` — render it RD-825. This arm rendering
      // `TOKEN_NOT_FOUND` meant a claimer landing before the window saw a
      // different code from one landing inside it, for a fact neither side
      // disagreed about.
      //
      // The specific sentence leads and the registry description follows, for
      // the reason the `delegation-superseded` arm sources its whole message
      // there: the operative instruction is RD-825's and must not be retyped.
      return {
        code: 'DELEGATION_SUPERSEDED',
        message: `Parent run ${failure.parentRunId} has been ${failure.lifecycle}. ${ErrorCodes.DELEGATION_SUPERSEDED.description}`,
        details: {
          parentRunId: failure.parentRunId,
          lifecycle: failure.lifecycle,
        },
      };
    case 'delegation-removed':
      // Same settlement as `parent-ended`, on the fact core classifies as
      // `cursor-advanced` (the substep is gone) or `token-reissued` (it carries
      // a different token) — both of which are RD-825. The delegation this
      // token names is no longer on the parent's step, which is precisely "the
      // parent advanced, reset, or reissued the token"; it is not a token this run
      // cannot find.
      return {
        code: 'DELEGATION_SUPERSEDED',
        message: `Delegation no longer exists on parent step ${failure.stepId}. ${ErrorCodes.DELEGATION_SUPERSEDED.description}`,
        details: { parentRunId: failure.parentRunId, stepId: failure.stepId },
      };
    case 'delegation-cancelled':
      return {
        code: 'DELEGATION_CANCELLED',
        message: 'This delegation has been cancelled and cannot be claimed.',
        details: {
          parentRunId: failure.parentRunId,
          stepId: failure.stepId,
          cancelledAt: failure.cancelledAt,
        },
      };
    case 'delegation-resolved':
      return {
        code: 'DELEGATION_ALREADY_RESOLVED',
        message: 'This delegation has already been resolved and cannot be claimed again.',
        details: {
          parentRunId: failure.parentRunId,
          stepId: failure.stepId,
          childRunId: failure.childRunId,
        },
      };
    case 'delegation-already-claimed':
      return {
        code: 'DELEGATION_ALREADY_CLAIMED',
        message: 'This delegation has already been claimed and cannot be claimed again.',
        details: {
          parentRunId: failure.parentRunId,
          stepId: failure.stepId,
          childRunId: failure.childRunId,
        },
      };
    case 'child-missing':
      return {
        code: 'CHILD_RUN_MISSING',
        message: `Child run ${failure.childRunId} no longer exists on disk. Delegation cannot be claimed.`,
        details: {
          parentRunId: failure.parentRunId,
          stepId: failure.stepId,
          childRunId: failure.childRunId,
        },
      };
    case 'linkage-mismatch':
      return {
        code: 'CHILD_LINKAGE_MISMATCH',
        message: `Persisted linkage for child run ${failure.childRunId} does not match the verified delegation. State may be corrupted; recover with \`rundown prune\` and restart the parent from source.`,
        details: {
          parentRunId: failure.parentRunId,
          stepId: failure.stepId,
          childRunId: failure.childRunId,
        },
      };
    case 'delegation-superseded':
      return {
        code: 'DELEGATION_SUPERSEDED',
        // Sourced from the registry rather than retyped. This message was a
        // verbatim copy of RD-825's description minus its last sentence, so the
        // two were free to drift with nothing to catch it — and the sentence the
        // copy dropped (when the latch refuses) is the operative one.
        message: ErrorCodes.DELEGATION_SUPERSEDED.description,
        details: {
          parentRunId: failure.parentRunId,
          stepId: failure.stepId,
          ...(failure.childRunId !== undefined ? { childRunId: failure.childRunId } : {}),
        },
      };
    case 'concurrent-modification':
      return {
        code: 'CONCURRENT_MODIFICATION',
        message: 'The parent changed while the delegated child claim was being committed. Retry.',
        details: {
          parentRunId: failure.parentRunId,
          stepId: failure.stepId,
          childRunId: failure.childRunId,
        },
      };
    case 'prepare-failed':
      return {
        code: failure.code,
        message: failure.cause,
        details: failure.details,
      };
    case 'launch-failed':
      return {
        code: failure.code,
        message: failure.cause,
        details: failure.details,
      };
    default: {
      const _exhaustive: never = failure;
      throw new Error(`Unhandled claim failure reason: ${(_exhaustive as ClaimFailure).reason}`);
    }
  }
}

/**
 * Registers the 'claim' command for claiming delegation tokens.
 *
 * Claims a delegation token, reconstitutes inherited context, and launches
 * the child runbook specified in the delegation metadata.
 *
 * @param program - Commander program instance to register the command on
 */
export function registerClaimCommand(program: Command): void {
  program
    .command('claim <token>')
    .description('Claim a delegation token and launch the child runbook')
    .option('--text', 'Output as human-readable text')
    .addOption(
      new Option('--input-file <path>', 'Load inputs from YAML file (repeatable)')
        .argParser(collect)
        .default([])
        .helpGroup('Input options:'),
    )
    .addOption(
      new Option('--input <key=value>', 'Set input (repeatable, omit =value to inherit from env)')
        .argParser(parseInputOption)
        .default([])
        .helpGroup('Input options:'),
    )
    .addOption(
      new Option('--input-json <key=json>', 'Set input with JSON value (repeatable)')
        .argParser(parseInputJsonOption)
        .default([])
        .helpGroup('Input options:'),
    )
    .addOption(
      new Option('--artifacts <key=uri>', 'Supply an input artifact by rd:// URI (repeatable)')
        .argParser(parseArtifactOption)
        .default([])
        .helpGroup('Input options:'),
    )
    .addOption(
      new Option(
        '--artifacts-json <key=json>',
        'Supply input artifacts as a JSON array of rd:// URIs (repeatable)',
      )
        .argParser(parseArtifactJsonOption)
        .default([])
        .helpGroup('Input options:'),
    )
    .action(
      async (
        token: string,
        options: {
          text?: boolean;
          inputFile?: string[];
          input?: string[];
          inputJson?: string[];
          artifacts?: string[];
          artifactsJson?: string[];
        },
      ) => {
        await withErrorHandling(
          async () => {
            const output = new OutputEmitter({
              text: options.text,
              command: 'claim',
            });
            const cwd = getCwd();
            const manager = new RunbookStateManager(cwd);
            const actorService = createCliRunbookActorService(manager);
            const sessionService = new SessionService(manager);
            const lifecycleService = new ExecutionLifecycleService(manager);
            const commandStreamOptions = commandStreamOptionsForOutputMode(options.text);

            const ctx: RunPipelineContext = {
              output,
              manager,
              actorService,
              sessionService,
              lifecycleService,
              cwd,
              commandStreamOptions,
            };

            const inputOpts = {
              inputFile: options.inputFile,
              input: options.input,
              inputJson: options.inputJson,
              artifacts: options.artifacts,
              artifactsJson: options.artifactsJson,
            };
            const result = await claimAndLaunch(
              ctx,
              token,
              inputOpts,
              createCliRunProgressionDriver({
                manager,
                cwd,
                output,
                sessionService,
                commandStreamOptions,
              }),
            );

            if (!result.ok) {
              if (result.reason === 'session-refused') {
                renderSessionMutationRefusal(output, result.refusal);
              } else {
                const envelope = claimFailureToEnvelope(result);
                output.error(envelope.message, envelope.code, envelope.details);
              }
              output.flush();
              process.exitCode = 1;
              return;
            }

            output.flush();
            if (progressionFailedClosed(result.progression)) {
              process.exit(1);
            }
          },
          { text: options.text },
        );
      },
    );
}
