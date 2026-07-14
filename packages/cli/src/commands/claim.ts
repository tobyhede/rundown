import { type Command, Option } from 'commander';
import {
  DELEGATION_TOKEN_PREFIX,
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
import { propagateDrivenRunTerminal } from '../helpers/delegation-completion.js';

function claimFailureToEnvelope(failure: ClaimFailure): {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
} {
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
      return {
        code: 'TOKEN_NOT_FOUND',
        message: `Parent run ${failure.parentRunId} no longer exists.`,
        details: { parentRunId: failure.parentRunId },
      };
    case 'parent-ended':
      return {
        code: 'TOKEN_NOT_FOUND',
        message: `Parent run has been ${failure.lifecycle}. Delegation cannot be claimed.`,
        details: { parentRunId: failure.parentRunId, lifecycle: failure.lifecycle },
      };
    case 'delegation-removed':
      return {
        code: 'TOKEN_NOT_FOUND',
        message: 'Delegation no longer exists on parent step.',
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
        message: `Persisted linkage for child run ${failure.childRunId} does not match the verified delegation. State may be corrupted; inspect .rundown/runs/${failure.childRunId}.json.`,
        details: {
          parentRunId: failure.parentRunId,
          stepId: failure.stepId,
          childRunId: failure.childRunId,
        },
      };
    case 'lock-timeout':
      return {
        code: 'DELEGATION_LOCK_TIMEOUT',
        message: `Could not acquire delegation lock for run ${failure.parentRunId}. Another operation may be in progress.`,
        details: { parentRunId: failure.parentRunId },
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
            const output = new OutputEmitter({ text: options.text, command: 'claim' });
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
            const result = await claimAndLaunch(ctx, token, inputOpts);

            if (!result.ok) {
              const envelope = claimFailureToEnvelope(result);
              output.error(envelope.message, envelope.code, envelope.details);
              output.flush();
              process.exitCode = 1;
              return;
            }

            // Claimed children are delegated children. If a non-prompted child
            // reaches terminal during launch, report its terminal outcome to
            // the delegating parent. Reporting is side-effect-only; the child's
            // own loopResult governs this command's exit code.
            const shouldExitWithError = result.loopResult === 'stopped';
            if (result.loopResult === 'done' || result.loopResult === 'stopped') {
              await propagateDrivenRunTerminal(
                manager,
                result.childRunId,
                cwd,
                output,
                { kind: 'loop-inferred' },
                commandStreamOptions,
              );
            }

            output.flush();
            if (shouldExitWithError) {
              process.exit(1);
            }
          },
          { text: options.text },
        );
      },
    );
}
