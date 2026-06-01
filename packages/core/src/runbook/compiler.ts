// cspell:words SUBSTATES substates

import { setup, assign, assertEvent, raise as raiseEvent } from 'xstate';
import type {
  Action,
  Aggregation,
  Transitions,
  LastAction,
  ForContext,
  ResolvedStep,
  ResolvedStepHavingSubsteps,
  Lifecycle,
  SubstepState,
  TemplateVarValue,
  RunId,
} from './types.js';
import { isResolvedVariableForContext } from './types.js';
import {
  brandInitialTemplateVars,
  type InitialTemplateVars,
  mergeEffectiveVars,
  type TrustedArtifactValue,
} from './effective-vars.js';
import type { VariableValue } from './effective-vars.js';
import type { StepId } from './step-id.js';
import type { ArtifactDeclaration, ForClause, OutputDeclaration } from '@rundown-org/parser';
import type { NakedOutput, OutputScope, PreparedChannel } from './output-channels.js';
import {
  artifactResolveActor,
  type ArtifactResolveInput,
} from './actors/artifact-resolve-actor.js';
import {
  forIterateActor,
  ForResolutionError,
  type ForIterateOutput,
  type ForResolutionFailureCode,
} from './actors/for-iterate-actor.js';
import { outputCaptureActor } from './actors/output-capture-actor.js';
import {
  delegationIssueActor,
  type DelegationIssueOutput,
} from './actors/delegation-issue-actor.js';
import {
  inlineLaunchIntentActor,
  type InlineLaunchIntentOutput,
  type InlineLaunchIntentWithoutParentEntry,
  type ResolveInlineRunbook,
} from './actors/inline-launch-intent-actor.js';
import {
  commandExecActor,
  type CommandExecutionCompletedOutput,
  type CommandExecutionInput,
  type CommandExecutionOutput,
  type CommandExecutionServices,
} from './actors/command-exec-actor.js';
import {
  isSourced,
  isWindowed,
  resolvedStepHasSubsteps,
  isAccumulatingAction,
  isBreakAction,
  isTerminalAction,
  isStepExitAction,
} from '@rundown-org/parser';
import { shouldAggregationPass } from './transition-handler.js';
import { actionRef, type ActionDefs, type ActionRef } from './compiler-actions.js';
import {
  buildExecutionFrame,
  evaluateFrontmatterOutputDeclarations,
  evaluateStepOutputDeclarations,
  type EvaluateOutputOptions,
  type FlattenedTemplateVars,
  type OutputVars,
} from './output-evaluator.js';
import type { DelegateFrontierEntry } from '../events/types.js';
import type { MachineExecutionObserver } from '../events/execution-observation.js';
import { buildFrameKey, deriveExecutionAt, findSubstepState, type FrameKey } from './targeting.js';
import { runRetryHook } from './retry-hook.js';
import { asTemplateVars } from './template-vars.js';
import { getErrorMessage } from '../errors.js';
import { assertRunId } from './run-id.js';
import { generateRunId } from './state.js';
import { RunbookRefSchema, type RunbookRef } from './runbook-ref.js';
import { MAX_FILE_ITERATIONS } from './for-iteration-constants.js';
import type { ParentLinkage } from './types.js';
import type { ResolveDelegationRunbook } from './delegation-inference.js';
import type { CurrentCursorResolvedCompletion } from './completion-service.js';
import type { TemplateHelperRegistry } from './helper-invoke.js';
import {
  clearAggregationRetryOnExhaustion,
  makeAggregationLastAction,
  makeDirectLastAction,
} from './last-action.js';

export { MAX_FILE_ITERATIONS } from './for-iteration-constants.js';

/**
 * Tag applied to transient machine-owned side-effect states.
 *
 * `RunbookActorService.sendAndSync()` waits for this tag to clear before
 * persisting the actor snapshot, so async invokes cannot be torn off by the
 * actor being stopped immediately after `.send()`.
 */
export const PENDING_MACHINE_EFFECT_TAG = 'pending-machine-effect' as const;

/**
 * Module-level XState setup with typed context, events, and named actions.
 *
 * Extracted to module scope so `runbookSetup.assign()` provides
 * compile-time context/event type inference throughout the compiler.
 */
/**
 * Shape of the machine output emitted when the runbook reaches a terminal
 * state (COMPLETE or STOPPED). Mirrors the `finalVars` snapshot persisted
 * on {@link RunbookContext} by `storeFrontmatterOutputs`.
 */
export interface RunbookMachineOutput {
  readonly finalVars: Readonly<Record<string, string>>;
}

interface StoreInlineLaunchIntentParams {
  readonly intent: InlineLaunchIntentWithoutParentEntry;
  readonly substepStates: readonly SubstepState[];
}

interface SetInlineLaunchFailedParams {
  readonly reason: 'inline_launch_failed' | 'inline_launch_forbidden';
  readonly message: string;
}

type InlineChildStartedEvent = Extract<RunbookEvent, { type: 'INLINE_CHILD_STARTED' }>;

function updateInlineStarted(
  substepStates: readonly SubstepState[] | undefined,
  event: InlineChildStartedEvent,
): readonly SubstepState[] | undefined {
  if (!substepStates) {
    return substepStates;
  }

  const target = findSubstepState(substepStates, event.parentStepId, event.parentFrameKey);
  if (!target?.inline) {
    return substepStates;
  }
  const inline = target.inline;
  if (inline.childRunId !== event.childRunId) {
    throw new Error(`Inline child run mismatch for ${event.parentStepId}`);
  }

  return substepStates.map((substepState) =>
    substepState === target
      ? {
          ...substepState,
          inline: {
            ...inline,
            startedAt: event.startedAt,
          },
        }
      : substepState,
  );
}

const baseRunbookSetup = setup({
  types: {
    context: {} as RunbookContext,
    events: {} as RunbookEvent,
    output: {} as RunbookMachineOutput,
    tags: {} as typeof PENDING_MACHINE_EFFECT_TAG,
  },
  actions: {
    /** Set lastAction and optional lastMessage. */
    setLastAction: assign({
      lastAction: (_, params: ActionDefs['setLastAction']) => params.action,
      lastMessage: (_, params: ActionDefs['setLastAction']) => params.msg,
    }),
    /** Merge variables captured by outputCaptureActor into live context variables. */
    storeCapturedVariables: assign({
      variables: ({ context }, params: ActionDefs['storeCapturedVariables']) => ({
        ...context.variables,
        ...params.variables,
      }),
    }),
    /** Mark output capture failure before routing to STOPPED. */
    setOutputCaptureFailed: assign({
      lifecycle: () => 'stopped' as const,
      lastAction: (_, params: ActionDefs['setOutputCaptureFailed']) =>
        makeDirectLastAction({
          type: 'OUTPUT_CAPTURE_FAILED' as const,
          message: params.message,
        }),
    }),
    /** Mark ARTIFACTS resolution failure before routing to STOPPED. */
    setArtifactResolutionFailed: assign({
      lifecycle: () => 'stopped' as const,
      lastAction: (_, params: ActionDefs['setArtifactResolutionFailed']) =>
        makeDirectLastAction({
          type: 'ARTIFACT_RESOLUTION_FAILED' as const,
          message: params.message,
        }),
    }),
    /** Mark command policy denial before routing to STOPPED. */
    setPolicyDenied: assign({
      lifecycle: () => 'stopped' as const,
      lastAction: (_, params: ActionDefs['setPolicyDenied']) =>
        makeDirectLastAction({
          type: 'POLICY_DENIED' as const,
          message: params.message,
        }),
    }),
    /** Mark catastrophic command execution failure before routing to STOPPED. */
    setCommandExecutionFailed: assign({
      lifecycle: () => 'stopped' as const,
      lastAction: (_, params: ActionDefs['setCommandExecutionFailed']) =>
        makeDirectLastAction({
          type: 'COMMAND_EXECUTION_FAILED' as const,
          message: params.message,
        }),
    }),
    /** Store the hydrated FOR value returned by forIterateActor. */
    storeReadyIteration: assign({
      forStack: ({ context }, params: ActionDefs['storeReadyIteration']) => {
        if (params.output.kind !== 'ready') return context.forStack;
        const stack = [...context.forStack];
        const top = stack.at(-1);
        if (!top) return context.forStack;
        const { snapshot: _previousSnapshot, ...topWithoutSnapshot } = top;
        stack[stack.length - 1] = {
          ...topWithoutSnapshot,
          iteration: params.output.forIndex,
          currentValue: params.output.forValue,
          snapshot: params.output.snapshot,
          ...(params.output.total !== undefined && top.end === undefined
            ? { end: params.output.total }
            : {}),
        };
        return stack;
      },
    }),
    /** Store a FOR exhaustion signal and prepare parent-level loop exit. */
    storeExhaustedIteration: assign({
      completedForContext: ({ context }, params: ActionDefs['storeExhaustedIteration']) => {
        if (params.output.kind !== 'exhausted') return context.completedForContext;
        const top = context.forStack.at(-1);
        return top ? { ...top, end: params.output.forIndex } : context.completedForContext;
      },
      forStack: ({ context }, params: ActionDefs['storeExhaustedIteration']) => {
        if (params.output.kind !== 'exhausted') return context.forStack;
        return EMPTY_FOR_STACK;
      },
      lastAction: ({ context }, params: ActionDefs['storeExhaustedIteration']) => {
        if (params.output.kind !== 'exhausted') return context.lastAction;
        return clearAggregationRetryOnExhaustion(context.lastAction);
      },
      substep: () => undefined,
      completedSubstep: () => undefined,
    }),
    /** Mark FOR resolution failure before routing to STOPPED. */
    setForResolutionFailed: assign({
      lifecycle: () => 'stopped' as const,
      lastAction: (_, params: ActionDefs['setForResolutionFailed']) =>
        makeDirectLastAction({
          type: 'FOR_RESOLUTION_FAILED' as const,
          code: params.code,
          message: params.message,
        }),
    }),
    /** Mark delegation issuance failure before routing to STOPPED. */
    setDelegationIssuanceFailed: assign({
      lifecycle: () => 'stopped' as const,
      lastAction: (_, params: ActionDefs['setDelegationIssuanceFailed']) =>
        makeDirectLastAction({
          type: 'DELEGATION_ISSUANCE_FAILED' as const,
          reason: params.reason,
          message: params.message,
        }),
    }),
    /** Store issued delegation frontier and updated substep state. */
    storeDelegateFrontier: assign({
      delegateFrontier: (_, params: ActionDefs['storeDelegateFrontier']) => params.frontier,
      substepStates: (_, params: ActionDefs['storeDelegateFrontier']) => params.substepStates,
    }),
    /** Store prepared inline launch intent and updated substep state. */
    storeInlineLaunchIntent: assign({
      inlineLaunchIntent: (_, params: StoreInlineLaunchIntentParams) => params.intent,
      substepStates: (_, params: StoreInlineLaunchIntentParams) => params.substepStates,
    }),
    /** Clear the one-shot inline launch intent after a front end consumes it. */
    clearInlineLaunchIntent: assign({
      inlineLaunchIntent: () => undefined,
    }),
    /** Mark an inline child run as started on the matching substep state. */
    storeInlineChildStarted: assign({
      substepStates: ({ context }, params: InlineChildStartedEvent) =>
        updateInlineStarted(context.substepStates, params),
    }),
    /** Mark inline launch preparation failure before routing to STOPPED. */
    setInlineLaunchFailed: assign({
      lifecycle: () => 'stopped' as const,
      lastAction: (_, params: SetInlineLaunchFailedParams) =>
        makeDirectLastAction({
          type: 'INLINE_LAUNCH_FAILED' as const,
          reason: params.reason,
          message: params.message,
        }),
    }),
    /** Merge variables resolved by artifactResolveActor into live context variables. */
    storeResolvedArtifacts: assign({
      variables: ({ context }, params: ActionDefs['storeResolvedArtifacts']) => ({
        ...context.variables,
        ...params.variables,
      }),
      enteredArtifacts: ({ context }, params: ActionDefs['storeResolvedArtifacts']) => ({
        ...(context.enteredArtifacts ?? {}),
        ...params.variables,
      }),
    }),
    /**
     * Evaluate a step or substep's OUTPUTS declarations and merge the result
     * into context.variables. Builds a fresh execution frame from the current
     * step/substep cursor before evaluating each declaration.
     */
    storeStepOutputs: assign({
      variables: ({ context }, params: ActionDefs['storeStepOutputs']) => {
        const substepId =
          params.substepId ?? (params.useCompletedSubstep ? context.completedSubstep : undefined);
        const baseFrameState = context;
        const activeFor = baseFrameState.forStack.at(-1);
        const completedFor = context.completedForContext;
        const frameState =
          params.useCompletedForContext &&
          activeFor?.stepId !== params.stepName &&
          completedFor?.stepId === params.stepName
            ? { ...baseFrameState, forStack: [completedFor] }
            : baseFrameState;
        const frame = buildExecutionFrame(frameState, {
          stepName: params.stepName,
          substepId,
        });
        const evaluated = evaluateStepOutputDeclarations(
          params.outputs,
          frame,
          params.evaluationOptions,
        );
        return { ...context.variables, ...evaluated };
      },
    }),
    /**
     * Evaluate the runbook's frontmatter OUTPUTS declarations against the current
     * execution frame and persist the snapshot to context.finalVars. Invoked on
     * terminal-state entry (COMPLETE / STOPPED). When invoked from terminal entry
     * there is no active step cursor — `stepName` is omitted and the frame's
     * `Step`/`step` keys render as empty strings (inert for outputs that resolve
     * by variable name from `templateVars` or `variables`).
     */
    storeFrontmatterOutputs: assign({
      finalVars: ({ context }, params: ActionDefs['storeFrontmatterOutputs']) => {
        if (context.frontmatterOutputs.length === 0) {
          return context.finalVars;
        }
        const frame = buildExecutionFrame(context, {
          stepName: params.stepName ?? '',
          substepId: params.substepId,
        });
        return evaluateFrontmatterOutputDeclarations(
          context.frontmatterOutputs,
          frame,
          params.evaluationOptions,
        );
      },
    }),
  },
  guards: {
    anyIterationFailed: ({ context }) => (context.iterationResults ?? []).some((r) => r === 'fail'),
    loopExitedViaControl: ({ context }) =>
      context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT',
    loopCompletedNormally: ({ context }) =>
      !(context.iterationResults ?? []).some((r) => r === 'fail') &&
      context.lastAction?.type !== 'BREAK' &&
      context.lastAction?.type !== 'NEXT',
  },
  actors: {
    outputCaptureActor,
    artifactResolveActor,
    forIterateActor,
    delegationIssueActor,
    inlineLaunchIntentActor,
    commandExecActor,
  },
});

/**
 * Extended XState setup that layers PASS/FAIL raisers on top of base compiler actions.
 *
 * Provides `raisePass` and `raiseFail` actions for dispatching result events
 * from step definitions into the state machine.
 *
 * @returns Extended setup with PASS/FAIL action raisers.
 */
export const runbookSetup = baseRunbookSetup.extend({
  actions: {
    raisePass: baseRunbookSetup.raise({ type: 'PASS' }),
    raiseFail: baseRunbookSetup.raise({ type: 'FAIL' }),
  },
});

/** Machine type produced by {@link compileRunbookToMachine}. */
export type RunbookMachine = ReturnType<typeof runbookSetup.createMachine>;

/** XState state-node config type inferred from the runbook setup. */
type RunbookStateConfig = Parameters<typeof runbookSetup.createStateConfig>[0];

/**
 * Shape of a single entry in a state's `on: { ... }` event-triggered transition map,
 * extracted from the XState-inferred state config. Accepted forms include
 * `{ target, actions?, guard? }` objects (what every builder in this file returns)
 * and, per XState, bare target strings or arrays of objects.
 */
type RunbookEventTransition =
  NonNullable<RunbookStateConfig['on']> extends Record<string, infer T> ? T : never;

/**
 * Shape of a single entry in a state's `always: [...]` event-less transition array,
 * extracted from the XState-inferred state config.
 */
type RunbookAlwaysEntry = Extract<
  NonNullable<RunbookStateConfig['always']>,
  readonly unknown[]
>[number];

function withEvaluationOptions<T extends object>(
  params: T,
  evaluationOptions: EvaluateOutputOptions | undefined,
): T & { readonly evaluationOptions?: EvaluateOutputOptions } {
  const withOptions = { ...params };
  if (evaluationOptions === undefined) {
    return withOptions;
  }
  return Object.defineProperty(withOptions, 'evaluationOptions', {
    value: evaluationOptions,
    enumerable: false,
  });
}

function requireStringTemplateVar(
  vars: OutputVars,
  key: 'WorkPath' | 'ContextId' | 'RunId',
): string {
  const value = vars[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`ARTIFACTS resolution requires template variable ${key}`);
  }
  return value;
}

/**
 * Pull the {@link RunbookRef} for the current runbook out of the per-machine
 * `templateVars` bag and validate it.
 *
 * **Key naming note.** The templateVars key is `RunbookRef`, not `Runbook`.
 * The variable carries the PARSED object form `{ source, path }` (validated
 * by {@link RunbookRefSchema}), distinct from the user-facing text form
 * `{{ Runbook }}` which earlier plans used as a placeholder name. Renaming
 * the key to `RunbookRef` keeps the parsed-object semantics explicit at
 * every callsite that needs the `{ source, path }` projection, and removes
 * the ambiguity with the rendered string form referenced in author markdown.
 * Authors do NOT see `RunbookRef`; the variable is internal-only.
 *
 * @param vars - Flattened template variables bag from machine compilation
 * @returns Validated {@link RunbookRef} for the current run
 * @throws {Error} When `vars.RunbookRef` is missing or fails schema validation
 */
function requireRunbookRef(vars: OutputVars): RunbookRef {
  const result = RunbookRefSchema.safeParse(vars.RunbookRef);
  if (!result.success) {
    throw new Error(`Invalid RunbookRef: ${result.error.message}`);
  }
  return result.data;
}

function requireArtifactsCwd(evaluationOptions: EvaluateOutputOptions | undefined): string {
  if (!evaluationOptions?.cwd) {
    throw new Error('ARTIFACTS resolution requires compileRunbookToMachine evaluationOptions.cwd');
  }
  return evaluationOptions.cwd;
}

function requireCommandServices(
  services: CommandExecutionServices | undefined,
): CommandExecutionServices {
  if (!services) {
    throw new Error('Command execution requires compileRunbookToMachine options.commandServices');
  }
  return services;
}

function requireCommandCwd(evaluationOptions: EvaluateOutputOptions | undefined): string {
  if (!evaluationOptions?.cwd) {
    throw new Error('Command execution requires compileRunbookToMachine evaluationOptions.cwd');
  }
  return evaluationOptions.cwd;
}

function buildCommandExecutionInput(
  event: Extract<RunbookEvent, { type: 'EXECUTE_COMMAND' }>,
  context: RunbookContext,
  evaluationOptions: EvaluateOutputOptions | undefined,
  commandServices: CommandExecutionServices | undefined,
): CommandExecutionInput {
  return {
    services: requireCommandServices(commandServices),
    command: event.command,
    displayCommand: event.displayCommand,
    cwd: requireCommandCwd(evaluationOptions),
    runId: assertRunId(requireStringTemplateVar(context.templateVars, 'RunId')),
    runbookPath: event.runbookPath,
    runbook: requireRunbookRef(context.templateVars),
    outputScope: event.outputScope,
    nakedOutputs: event.nakedOutputs,
    rdInjected: event.rdInjected,
  };
}

function isCommandCompletedOutput(
  output: CommandExecutionOutput,
): output is CommandExecutionCompletedOutput {
  return output.kind === 'completed';
}

function buildArtifactResolveInput(
  declarations: readonly ArtifactDeclaration[],
  stepName: string,
  substepId: string | undefined,
  context: RunbookContext,
  evaluationOptions: EvaluateOutputOptions | undefined,
): ArtifactResolveInput {
  const scopeVars = {
    ...mergeEffectiveVars({ templateVars: context.templateVars, variables: context.variables }),
    ...buildArtifactRuntimeScope(stepName, substepId, context.forStack),
  };
  return {
    declarations,
    cwd: requireArtifactsCwd(evaluationOptions),
    workPath: requireStringTemplateVar(context.templateVars, 'WorkPath'),
    contextId: requireStringTemplateVar(context.templateVars, 'ContextId'),
    runId: assertRunId(requireStringTemplateVar(context.templateVars, 'RunId')),
    runbook: requireRunbookRef(context.templateVars),
    scopeVars,
    fileArtifactSearchRoots: evaluationOptions?.fileArtifactSearchRoots,
    allowFileArtifactRead: evaluationOptions?.allowFileArtifactRead,
  };
}

function buildArtifactRuntimeScope(
  stepName: string,
  substepId: string | undefined,
  forStack: readonly ForContext[],
): Record<string, unknown> {
  const step = substepId ? `${stepName}.${substepId}` : stepName;
  const vars: Record<string, unknown> = {
    Step: step,
    step,
    'context.current.step': step,
    'context.current.at': deriveExecutionAt(stepName, substepId),
  };
  if (substepId) {
    vars['context.current.substep'] = substepId;
  }
  const top = forStack.at(-1);
  if (top && !top.implicit) {
    vars.Index = String(top.iteration);
    vars.index = String(top.iteration);
    vars['context.current.index'] = String(top.iteration);
    vars['context.current.at'] = deriveExecutionAt(stepName, substepId, top.iteration);
    if (top.variable) {
      if (top.source.kind === 'range') {
        vars[top.variable] = String(top.iteration);
      } else if (isResolvedVariableForContext(top)) {
        vars[top.variable] = top.currentValue;
      }
    }
  }
  return vars;
}

// Typed constants for empty array values that need explicit types
// (bare `[]` infers as `never[]`, not the required array type).
const EMPTY_FOR_STACK: RunbookContext['forStack'] = Object.freeze([]);
const EMPTY_RESULTS = Object.freeze([]) as unknown as NonNullable<
  RunbookContext['iterationResults']
>;

/** Name of the top-level STOPPED final state; used for both `id:` and name-based targets. */
const STOPPED_STATE_NAME = 'STOPPED' as const;
/**
 * XState absolute ID reference for the STOPPED final state.
 * Required for `onError` targets inside nested compound children where
 * a plain name-based target would not cross the compound-state boundary.
 * Derived from `STOPPED_STATE_NAME` so both strings share a single source of truth.
 */
const STOPPED_STATE_REF = `#${STOPPED_STATE_NAME}` as const; // '#STOPPED'

/** Name of the top-level transient state used for sourced-FOR exhaustion. */
const ITERATION_EXHAUSTED_STATE_NAME = 'iteration_exhausted' as const;

/** Top-level transient state ID used as the typed exhaustion target. */
export const ITERATION_EXHAUSTED_STATE_REF = `#${ITERATION_EXHAUSTED_STATE_NAME}` as const;

/** Compiler-owned child substate names for execution-unit leaves. */
export const LEAF_SUBSTATES = [
  'idle',
  '__capture',
  '__execute-command',
  '__resolve-artifacts',
  '__resolve-iteration',
  '__issue-delegations',
  '__prepare-inline-launch',
] as const;

/** Child state names owned by a compiled execution-unit leaf. */
export type LeafSubstate = (typeof LEAF_SUBSTATES)[number];

const LEAF_SUBSTATE_SET: ReadonlySet<string> = new Set(LEAF_SUBSTATES);

/**
 * Return true when an XState compound value names a known leaf substate.
 *
 * @param value - Nested compound-state child value
 * @returns true for compiler-owned leaf substates
 */
export function isCompoundLeafValue(value: unknown): value is LeafSubstate {
  return typeof value === 'string' && LEAF_SUBSTATE_SET.has(value);
}

/**
 * Context passed through the XState runbook state machine.
 *
 * Maintains runtime state that persists across transitions including
 * retry counts, current substep, and runbook variables.
 */
export interface RunbookContext {
  /** Current retry count for the active step */
  retryCount: number;
  /** Retry count for parent-step aggregation retries (separate from substep retryCount). */
  parentRetryCount: number;
  /** Retry count for iteration-level retries within FOR loops (separate from retryCount and parentRetryCount). */
  iterationRetryCount: number;
  /** Maximum retries allowed for current RETRY action (source of truth for retry limits) */
  retryMax?: number;
  /** Current substep ID within the active step */
  substep?: string;
  /** Most recently completed substep, preserved for parent OUTPUTS evaluation. */
  completedSubstep?: string;
  /**
   * FOR frame snapshot captured just before a parent self-transition clears forStack.
   * Preserved so parent OUTPUTS can reconstruct loop-scoped values (Index, loop variable,
   * context.current.at) after the loop has exited. Only valid when stepId matches the
   * evaluating step; the step-id check in storeStepOutputs guards against stale values.
   */
  completedForContext?: ForContext;
  /**
   * User-defined runbook variables. Carries strings (OUTPUTS), `ArtifactRecord`
   * (exact ARTIFACT), and `readonly ArtifactRecord[]` (wildcard ARTIFACT).
   * Artifact-shape detection at read time is structural.
   */
  variables: Record<string, VariableValue>;
  /** Current execution unit's resolved ARTIFACTS working set for STEP_ENTERED. */
  enteredArtifacts?: Readonly<Record<string, TrustedArtifactValue>>;
  /** Last action taken by the state machine (source of truth for transition type) */
  lastAction?: LastAction;
  /** Message from STOP/COMPLETE actions */
  lastMessage?: string;
  /** FOR loop execution stack (empty when not in a loop). Currently depth-1 only; nested loop support is reserved. */
  readonly forStack: readonly ForContext[];
  /** Per-iteration outcomes for FOR loops ('pass' or 'fail'). One entry per completed iteration. */
  iterationResults?: ('pass' | 'fail')[];
  /** Navigation counter: incremented by ALL completed substeps. Used by advance guards only. */
  substepCompletedCount: number;
  /** Deferred results: only appended by DEFER. Used exclusively for ALL/ANY aggregation. */
  deferredResults?: ('pass' | 'fail')[];
  /** Seeded template variables for OUTPUTS evaluation (built-ins, frontmatter inputs, CLI overrides). */
  readonly templateVars: OutputVars;
  /** Frontmatter `outputs:` declarations evaluated when the runbook reaches a terminal state. */
  readonly frontmatterOutputs: readonly OutputDeclaration[];
  /** Final OUTPUTS snapshot persisted at terminal entry. Exposed via machine output. */
  readonly finalVars: RunbookMachineOutput['finalVars'];
  /** Machine-owned lifecycle flag. 'running' during execution; 'completed' or 'stopped' on final entry. */
  readonly lifecycle: Lifecycle;
  /**
   * Mirror of RunbookState.substepStates so the retry hook (running inside
   * an XState assign) can inspect delegation records and write back updates.
   * Populated at actor bootstrap (Task 4) and updated by the retry hook.
   */
  readonly substepStates?: readonly SubstepState[];
  /** Frontier of newly-minted delegation tokens owned by the machine. */
  readonly delegateFrontier?: ReadonlyArray<DelegateFrontierEntry>;
  /** One-shot machine-owned intent for launching a non-DELEGATE child runbook inline. */
  readonly inlineLaunchIntent?: InlineLaunchIntentWithoutParentEntry;
  /** Parent linkage data used by machine-owned delegation issuance. */
  readonly parentLinkage?: ParentLinkage;
}

/**
 * Events that can be sent to the XState runbook state machine.
 *
 * - PASS: Mark the current step as passed, triggering the PASS transition
 * - FAIL: Mark the current step as failed, triggering the FAIL transition
 * - RETRY: Increment retry count and re-enter the current step
 * - GOTO: Jump directly to a specific step by ID
 * - FORCE_STOP: User-forced stop command intent routed through the machine
 * - FORCE_COMPLETE: User-forced complete command intent routed through the machine
 * - SET_VARIABLES: Merge variables into context.variables without changing step.
 *   Available as a general-purpose variable-merge primitive; delegation
 *   completion now flows through APPLY_CURRENT_RESOLVED_COMPLETION below, which
 *   merges `finalVars` atomically with the pass/fail raise. OUTPUTS capture
 *   uses COMMAND_RESULT below.
 * - DELEGATE_FRONTIER_CONSUMED: Clear the one-shot delegation frontier after
 *   a frontend emits the plain claim tokens.
 * - APPLY_CURRENT_RESOLVED_COMPLETION: Apply a core-validated resolved completion
 *   at the current cursor, merging child finalVars before raising PASS/FAIL
 * - COMMAND_RESULT: Result of a CLI-driven command execution. Carries captured
 *   channels. Unconditionally transitions the leaf to its `__capture` child,
 *   which invokes `outputCaptureActor`. Channels may be empty; the actor
 *   resolves with an empty `variables` record and still fires the result-driven
 *   `PASS` or `FAIL` event.
 */
export type RunbookEvent =
  | { type: 'PASS' }
  | { type: 'FAIL' }
  | { type: 'RETRY' }
  | { type: 'GOTO'; target: StepId }
  | { type: 'FORCE_STOP'; message?: string }
  | { type: 'FORCE_COMPLETE'; message?: string }
  | { type: 'SET_VARIABLES'; vars: Record<string, VariableValue> }
  | { type: 'DELEGATE_FRONTIER_CONSUMED' }
  | { type: 'INLINE_LAUNCH_CONSUMED' }
  | {
      type: 'INLINE_CHILD_STARTED';
      parentStepId: string;
      parentFrameKey: FrameKey;
      childRunId: RunId;
      startedAt: string;
    }
  | {
      type: 'APPLY_CURRENT_RESOLVED_COMPLETION';
      completionKey: string;
      completion: CurrentCursorResolvedCompletion;
    }
  | {
      type: 'EXECUTE_COMMAND';
      command: string;
      displayCommand: string;
      runbookPath?: string;
      outputScope: OutputScope;
      nakedOutputs: readonly NakedOutput[];
      rdInjected: Record<string, string>;
    }
  | {
      type: 'COMMAND_RESULT';
      result: 'pass' | 'fail';
      channels: readonly PreparedChannel[];
    };

/**
 * Object-form XState transition entry — the `{ target?, actions?, guard? }` variant.
 *
 * `RunbookEventTransition` is a union that includes bare target strings and arrays;
 * this alias extracts only the object form used by every builder in this file.
 */
type RunbookTransitionObject = Extract<RunbookEventTransition, { target?: unknown }>;

/**
 * Union of all action types accepted by XState transitions.
 *
 * Extracted from `RunbookTransitionObject['actions']` (excluding undefined) to avoid
 * verbose inline type unions throughout the compiler.
 */
type RunbookAction = NonNullable<RunbookTransitionObject['actions']>;

/**
 * Return shape for transition builder functions.
 *
 * Either a single XState-inferred transition entry or an array of them. Extracted
 * from `runbookSetup.createStateConfig()` so the `actions` field is validated
 * end-to-end against the setup's action map.
 */
type TransitionConfig = RunbookEventTransition | RunbookEventTransition[];

/**
 * Child/leaf state configuration — represents a concrete substep or simple step.
 */
interface ChildStateConfig {
  id: string;
  stepName: string;
  substepId?: string;
  transitions: Transitions;
  artifacts?: readonly ArtifactDeclaration[];
  isParentState?: false;
}

/**
 * Parent aggregation state configuration — represents a transient step that
 * aggregates substep results via `always` transitions.
 */
interface ParentStateConfig {
  id: string;
  stepName: string;
  substepId?: string;
  transitions: Transitions;
  isParentState: true;
  parentStep: ResolvedStepHavingSubsteps;
}

/**
 * Internal state configuration entry used to track all XState states during compilation.
 * Discriminated on `isParentState` so that `parentStep` is guaranteed present
 * when `isParentState` is `true`.
 */
type StateConfig = ChildStateConfig | ParentStateConfig;

/**
 * Internal helper to format state IDs for the XState machine.
 * Uses _ instead of . to avoid XState path resolution issues.
 *
 * @param stepName - The step name (e.g., "1", "ErrorHandler")
 * @param substepId - Optional substep identifier within the step
 * @returns Formatted state ID string (e.g., "step::1" or "step::1::2")
 */
function formatStateId(stepName: string, substepId?: string): string {
  return substepId ? `step::${stepName}::${substepId}` : `step::${stepName}`;
}

function parentEntryStateId(stepName: string, substepId: string): string {
  return `step::${stepName}::__parent-entry::${substepId}`;
}

/**
 * Extract substep ID from a state ID string, or undefined if no substep.
 *
 * @param stateId - The state ID to parse (e.g., "step::3::2")
 * @returns The substep ID if present, otherwise undefined
 */
function extractSubstepFromStateId(stateId: string): string | undefined {
  const parentEntryMatch = /^step::([^:]+)::__parent-entry::(.+)$/.exec(stateId);
  if (parentEntryMatch) return parentEntryMatch[2];
  const match = /^step::([^:]+)::(.+)$/.exec(stateId);
  return match?.[2];
}

function routeThroughParentArtifactsIfNeeded(
  target: string,
  steps: readonly ResolvedStep[],
): string {
  if (target.includes('::__parent-entry::')) return target;
  const match = /^step::([^:]+)::(.+)$/.exec(target);
  if (!match) return target;
  const [, stepName, substepId] = match;
  const parent = steps.find((step) => step.name === stepName);
  if (!parent || !resolvedStepHasSubsteps(parent) || !parent.artifacts?.length) {
    return target;
  }
  return parentEntryStateId(stepName, substepId);
}

/**
 * Build a structured GOTO LastAction from a StepId target.
 *
 * Note: StepId.at is validated against TEMPLATE_VAR_PATTERN at parse time,
 * but Zod's .regex() doesn't narrow the TypeScript type from `string`.
 * The cast here bridges the gap between the runtime guarantee and the type.
 *
 * @param target - The parsed GOTO target with step, substep, and optional at
 * @returns A structured GOTO LastAction
 */
function buildGotoLastAction(
  target: StepId,
): Omit<Extract<LastAction, { type: 'GOTO' }>, 'origin'> {
  return {
    type: 'GOTO' as const,
    target: target.step,
    ...(target.substep && { substep: target.substep }),
    ...(target.at !== undefined && { at: target.at as number | `{{${string}}}` }),
  };
}

/**
 * Build a lastAction function that extracts GOTO target info from an event.
 *
 * Returns a function compatible with XState assign that produces a
 * {@link LastAction} from a GOTO event, or `undefined` for non-GOTO events.
 * Reuses {@link buildGotoLastAction} internally.
 *
 * @param fallbackSubstepId - Substep ID to use when the event doesn't specify one
 * @returns A function suitable for use as a lastAction assign value
 */
function buildGotoLastActionFromEvent(
  fallbackSubstepId: string | undefined,
): (args: { event: RunbookEvent }) => LastAction | undefined {
  return ({ event }) => {
    if (event.type !== 'GOTO') return undefined;
    return makeDirectLastAction(
      buildGotoLastAction({
        step: event.target.step,
        substep: event.target.substep ?? fallbackSubstepId,
        at: event.target.at,
      }),
    );
  };
}

/**
 * Check if a state represents the first substep of a step with substeps.
 * Returns step info with either the explicit forClause or a synthetic { start: 1, end: 1 }.
 *
 * @param stateId - The state ID to check (e.g., "step::3::1")
 * @param steps - The full steps array
 * @returns The step, its ForClause (explicit or synthetic), and implicit flag, or null otherwise
 */
function getStepForFirstSubstep(
  stateId: string,
  steps: readonly ResolvedStep[],
): { step: ResolvedStepHavingSubsteps; forClause: ForClause; implicit: boolean } | null {
  const match = /^step::(.+?)::(.+)$/.exec(stateId);
  if (!match) return null;

  const [, stepName, substepId] = match;
  const step = steps.find((s) => s.name === stepName);
  if (!step || !resolvedStepHasSubsteps(step)) return null;

  if (substepId === step.substeps[0].id) {
    return {
      step,
      forClause: step.kind === 'for' ? step.forClause : { start: 1, end: 1 },
      implicit: step.kind !== 'for',
    };
  }

  return null;
}

/**
 * Check if a state represents the last substep of a step with substeps.
 *
 * @param stepName - The step name
 * @param substepId - The substep ID (undefined if not a substep)
 * @param steps - The full steps array
 * @returns True if this is the last substep of a step with substeps
 */
function isLastSubstepOfStep(
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
): boolean {
  if (!substepId) return false;
  const step = steps.find((s) => s.name === stepName);
  if (!step || !resolvedStepHasSubsteps(step)) return false;

  const lastSubstepId = step.substeps[step.substeps.length - 1].id;
  return substepId === lastSubstepId;
}

/**
 * Peek at the top of the FOR context stack.
 *
 * @param stack - The FOR context stack to inspect
 * @returns The topmost ForContext, or undefined if the stack is empty
 */
function peekForStack(stack: readonly ForContext[]): ForContext | undefined {
  return stack.length > 0 ? stack[stack.length - 1] : undefined;
}

/**
 * Check if a FOR context iterates in descending order.
 *
 * @param fc - The FOR context to check
 * @returns True if start is greater than end
 */
function isDescending(fc: ForContext): boolean {
  if (fc.end === undefined) return false;
  return fc.start > fc.end;
}

/**
 * Advance iteration by one step in the appropriate direction.
 *
 * @param fc - The FOR context with current iteration position
 * @returns The next iteration number (incremented or decremented based on direction)
 */
function nextIteration(fc: ForContext): number {
  return isDescending(fc) ? fc.iteration - 1 : fc.iteration + 1;
}

/**
 * Check whether the loop has more iterations remaining.
 *
 * @param fc - The FOR context to evaluate
 * @returns True if the loop should continue iterating
 */
function hasMoreIterations(fc: ForContext): boolean {
  if (fc.end === undefined) {
    // Safety net for variable sources: if the resolver hasn't populated
    // currentValue, don't iterate. In normal operation, exhaustion
    // is handled by forIterateActor routing through #iteration_exhausted.
    if (fc.source.kind === 'variable' && !isResolvedVariableForContext(fc)) return false;
    return fc.iteration - fc.start < MAX_FILE_ITERATIONS;
  }
  return isDescending(fc) ? fc.iteration > fc.end : fc.iteration < fc.end;
}

/**
 * Resolve an AT value (number | string | undefined) to a numeric iteration.
 * Template variable strings that don't resolve to numbers fall back to defaultValue.
 *
 * @param at - The AT value to resolve
 * @param defaultValue - Fallback value when AT is undefined or non-numeric string
 * @returns Resolved numeric iteration value
 */
function resolveAtValue(at: number | string | undefined, defaultValue: number): number {
  if (at === undefined) return defaultValue;
  if (typeof at === 'number') return at;
  const parsed = Number(at);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Resolve AT value at runtime, expanding template variables from forStack context.
 *
 * @param at - The AT value to resolve (number, template string, or undefined)
 * @param defaultValue - Fallback value when AT is undefined or non-resolvable
 * @param forStack - Current FOR context stack for template variable resolution
 * @returns Resolved numeric iteration value
 */
function resolveAtValueRuntime(
  at: number | string | undefined,
  defaultValue: number,
  forStack: readonly ForContext[],
): number {
  if (at === undefined) return defaultValue;
  if (typeof at === 'number') return at;
  const parsed = Number(at);
  if (!Number.isNaN(parsed)) return parsed;
  // Try template variable resolution from current forStack
  // NOTE: Only resolves from the topmost loop context. Nested loop support
  // would require walking the full forStack to find matching variable names.
  const top = forStack.length > 0 ? forStack[forStack.length - 1] : undefined;
  if (at === '{{Index}}' && top) {
    return top.iteration;
  }
  if (top?.variable && at === `{{${top.variable}}}`) {
    return top.iteration;
  }
  return defaultValue;
}

/**
 * Create a ForContext for a step's FOR clause.
 *
 * @param stepName - The step name that owns the loop
 * @param forClause - The FOR clause definition
 * @param atValue - Optional AT value for starting iteration
 * @param implicit - Optional flag indicating implicit FOR context
 * @returns A new ForContext
 */
function createForContext(
  stepName: string,
  forClause: ForClause,
  atValue?: number | string,
  implicit = false,
): ForContext {
  let source: ForContext['source'];
  let start: number;
  let end: number | undefined;

  if (isSourced(forClause)) {
    // Record variable name; the machine-invoked actor resolves value and bounds at runtime.
    source = { kind: 'variable', name: forClause.source };
    start = forClause.start;
    end = isWindowed(forClause) ? forClause.end : undefined;
  } else {
    source = { kind: 'range' };
    start = forClause.start;
    end = forClause.end;
  }

  const iteration = resolveAtValue(atValue, start);
  const currentValue = undefined; // Resolved by forIterateActor before execution.
  return {
    stepId: stepName,
    iteration,
    start,
    end,
    variable: forClause.variable,
    implicit,
    source,
    currentValue,
  };
}

function sourceTemplateVarsFromFlattened(
  templateVars: FlattenedTemplateVars | undefined,
): InitialTemplateVars {
  const sourceTemplateVars: Record<string, TemplateVarValue> = {};
  for (const [key, value] of Object.entries(templateVars ?? {})) {
    sourceTemplateVars[key] = value === null || typeof value === 'boolean' ? String(value) : value;
  }
  return brandInitialTemplateVars(sourceTemplateVars);
}

/**
 * Initialise the forStack for a transition into a FOR step.
 *
 * If the topmost context already targets `targetStepName` (intra-loop GOTO),
 * the existing stack is preserved. Otherwise a fresh single-entry stack is
 * created via {@link createForContext}.
 *
 * @param currentForStack - The current forStack from machine context
 * @param targetStepName - The step name being entered
 * @param forClause - The FOR clause of the target step
 * @param atValue - Optional AT value from a GOTO action
 * @param implicit - Whether the FOR loop is implicit (no explicit FOR clause)
 * @returns The forStack to assign
 * @throws {Error} When the FOR clause contains unresolved template references
 */
function initForStack(
  currentForStack: readonly ForContext[],
  targetStepName: string,
  forClause: ForClause,
  atValue: number | string | undefined,
  implicit: boolean,
): readonly ForContext[] {
  const top = peekForStack(currentForStack);
  if (top?.stepId === targetStepName) {
    return currentForStack;
  }
  const iteration = resolveAtValueRuntime(atValue, forClause.start, currentForStack);
  return [createForContext(targetStepName, forClause, iteration, implicit)];
}

/**
 * Initialise iterationResults for a transition into a FOR step.
 *
 * If the topmost context already targets `targetStepName` (intra-loop GOTO),
 * the existing results are preserved. Otherwise returns a fresh empty array
 * when aggregation is needed, or `undefined` when it is not.
 *
 * @param currentForStack - The current forStack from machine context
 * @param currentResults - The current iterationResults from machine context
 * @param targetStepName - The step name being entered
 * @param needsAggregation - Whether this step needs aggregation results
 * @returns The iterationResults to assign
 */
function initIterationResults(
  currentForStack: readonly ForContext[],
  currentResults: ('pass' | 'fail')[] | undefined,
  targetStepName: string,
  needsAggregation: boolean,
): ('pass' | 'fail')[] | undefined {
  const top = peekForStack(currentForStack);
  if (top?.stepId === targetStepName) {
    return currentResults;
  }
  return needsAggregation ? [] : undefined;
}

/**
 * True when a leaf belongs to a FOR step whose iteration value must be
 * hydrated by the machine before authored work can run.
 *
 * Range loops derive their value from the iteration counter and implicit 1..1
 * loops do not have sourced values, so neither needs the actor.
 *
 * @param step - Owning step for the leaf state.
 * @returns True when the leaf needs a `__resolve-iteration` child.
 */
function leafNeedsIterationResolution(step: ResolvedStep): boolean {
  if (step.kind !== 'for') return false;
  return isSourced(step.forClause);
}

/**
 * True when this leaf is the first auto-delegated substep of its parent step.
 *
 * @param stepName - Parent step name for the leaf.
 * @param substepId - Substep id for the leaf, if any.
 * @param steps - Resolved runbook steps.
 * @returns True when this leaf should invoke machine-owned delegation issuance.
 */
function leafIssuesDelegations(
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
): boolean {
  if (!substepId) return false;
  const step = steps.find((candidate) => candidate.name === stepName);
  if (!step || !resolvedStepHasSubsteps(step)) return false;
  return step.substeps.some((substep) => substep.id === substepId && substep.delegate === true);
}

/**
 * True when this leaf is a non-DELEGATE substep that references a child runbook.
 *
 * @param stepName - Parent step name for the leaf.
 * @param substepId - Substep id for the leaf, if any.
 * @param steps - Resolved runbook steps.
 * @returns True when this leaf should prepare inline child launch intent.
 */
function leafPreparesInlineLaunch(
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
): boolean {
  if (!substepId) return false;
  const step = steps.find((candidate) => candidate.name === stepName);
  if (!step || !resolvedStepHasSubsteps(step)) return false;
  return step.substeps.some(
    (substep) =>
      substep.id === substepId &&
      substep.delegate !== true &&
      Array.isArray(substep.runbooks) &&
      substep.runbooks.length > 0,
  );
}

/**
 * Check if a state represents ANY substep of a step with substeps.
 *
 * @param stateId - The state ID to check (e.g., "step::3::2")
 * @param steps - The full steps array
 * @returns The step, its ForClause (explicit or synthetic), and implicit flag, or null otherwise
 */
function getStepForSubstep(
  stateId: string,
  steps: readonly ResolvedStep[],
): { step: ResolvedStepHavingSubsteps; forClause: ForClause; implicit: boolean } | null {
  const match = /^step::(.+?)::(.+)$/.exec(stateId);
  if (!match) return null;
  const [, stepName] = match;
  const step = steps.find((s) => s.name === stepName);
  if (!step || !resolvedStepHasSubsteps(step)) return null;
  return {
    step,
    forClause: step.kind === 'for' ? step.forClause : { start: 1, end: 1 },
    implicit: step.kind !== 'for',
  };
}

type GotoAssignValue<T> = T | ((args: { event: RunbookEvent }) => T);

/**
 * Build assign action for simple GOTO transitions.
 * Handles retry count increment for GOTO-to-self and clears next instance flags.
 * Skips lastAction update when GOTO is internal (raised by RETRY) to preserve the originating action.
 *
 * @param options - Configuration object for the GOTO assign action
 * @param options.lastAction - The lastAction value or factory function
 * @param options.resolvedSubstepId - Substep ID value or factory function
 * @param options.isGotoToSelf - Whether this GOTO targets the current state
 * @param options.preserveForContext - Whether to preserve the FOR context stack
 * @param options.preserveParentRetryCount - Whether to preserve the parent retry counter
 * @returns XState assign action
 */
function buildSimpleGotoAssign(options: {
  lastAction: GotoAssignValue<LastAction | undefined>;
  resolvedSubstepId: GotoAssignValue<string | undefined>;
  isGotoToSelf: boolean;
  preserveForContext?: boolean;
  preserveParentRetryCount?: boolean;
}): ReturnType<typeof runbookSetup.assign> {
  return runbookSetup.assign({
    lastAction: ({ event }: { event: RunbookEvent }) => {
      return typeof options.lastAction === 'function'
        ? options.lastAction({ event })
        : options.lastAction;
    },
    parentRetryCount: options.preserveParentRetryCount
      ? ({ context }: { context: RunbookContext }) => context.parentRetryCount
      : 0,
    retryCount: options.isGotoToSelf
      ? ({ context }: { context: RunbookContext }) => context.retryCount + 1
      : 0,
    retryMax: undefined,
    substep: options.resolvedSubstepId,
    ...(options.preserveForContext
      ? {}
      : {
          forStack: EMPTY_FOR_STACK,
          iterationResults: undefined,
          iterationRetryCount: 0,
        }),
  });
}

function appendDeferredResult(result: 'pass' | 'fail') {
  return ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] => {
    return [...(context.deferredResults ?? []), result];
  };
}

/**
 * Check if a step is a numbered step (vs named step).
 * Numbered steps: "1", "2", "10"
 * Named steps: "ErrorHandler", "Cleanup", "Recovery"
 *
 * @param step - The step to check
 * @returns True if the step name is purely numeric
 */
function isNumberedStep(step: ResolvedStep): boolean {
  // Numeric step names: 1, 2, 3, etc.
  return /^\d+$/.test(step.name);
}

/**
 * Build XState transition config from a TransitionObject.
 * Handles retry property uniformly for all transitions.
 *
 * @param transition - The transition definition with kind, retry count, and action
 * @param transition.kind - Whether this is a 'pass' or 'fail' transition
 * @param transition.retry - Number of retries before executing the action
 * @param transition.action - The terminal action to execute when retries are exhausted
 * @param currentStateId - The XState state ID of the current state
 * @param stepName - The step name for target resolution
 * @param substepId - Optional substep ID within the step
 * @param steps - All parsed runbook steps for target lookup
 * @param evaluationOptions - Filesystem options threaded through to OUTPUTS evaluation
 * @returns XState transition configuration
 */
function buildTransition(
  transition: { kind: string; retry: number; action: Action },
  currentStateId: string,
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
  evaluationOptions: EvaluateOutputOptions | undefined,
): TransitionConfig {
  const { retry, action, kind } = transition;
  // Normalize kind to pass/fail for iteration result recording
  const resultKind: 'pass' | 'fail' = kind === 'pass' || kind === 'yes' ? 'pass' : 'fail';

  if (retry > 0) {
    // Route to transient retry state — it handles guard + exhausted logic
    const retryStateId = `${currentStateId}::${resultKind}-retry`;
    return { target: retryStateId };
  }

  // No retry: execute action directly
  return buildActionTransition(action, stepName, substepId, steps, resultKind, evaluationOptions);
}

/**
 * Find the next state ID in the flattened sequence.
 *
 * @param stepName - The current step name
 * @param substepId - Optional current substep ID
 * @param steps - All parsed runbook steps
 * @returns The next state ID, or 'COMPLETE' if at the end
 */
function findNextStateId(
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
): string {
  // Find current step by name
  const currentStepIndex = steps.findIndex((s) => s.name === stepName);
  if (currentStepIndex === -1) return 'COMPLETE';
  const currentStep = steps[currentStepIndex];

  // If we are in a substep, check if there is a next sibling
  if (substepId && resolvedStepHasSubsteps(currentStep)) {
    const currentIndex = currentStep.substeps.findIndex((s) => s.id === substepId);
    if (currentIndex !== -1 && currentIndex < currentStep.substeps.length - 1) {
      const nextSubstep = currentStep.substeps[currentIndex + 1];
      return formatStateId(stepName, nextSubstep.id);
    }
  }

  // Move to next NUMBERED H2 step (skip named steps)
  for (let i = currentStepIndex + 1; i < steps.length; i++) {
    const nextStep = steps[i];
    // Skip named steps - they're only reachable via GOTO
    if (!isNumberedStep(nextStep)) continue;

    if (resolvedStepHasSubsteps(nextStep) && nextStep.substeps.length > 0) {
      return formatStateId(nextStep.name, nextStep.substeps[0].id);
    }
    return formatStateId(nextStep.name);
  }

  // End of rundown
  return 'COMPLETE';
}

/**
 * Build assign action for parent state exit paths.
 *
 * Designed for use in `always` transitions
 * of parent aggregation states. Does not record iteration results (that happens at
 * the substep level). Records the parent step's transition action as lastAction and
 * initializes forStack when the target is a FOR step.
 *
 * All actions produced by parent-exit aggregation carry `origin: 'aggregation'`
 * on their `lastAction`, allowing consumers to distinguish aggregation-terminal
 * transitions from direct step transitions.
 *
 * @param parentAction - The parent step's transition action
 * @param exitTarget - The resolved XState target state ID
 * @param steps - The full steps array (for GOTO target lookup)
 * @returns XState assign action
 * @throws {Error} When a GOTO target's FOR clause contains unresolved template references
 */
function buildParentExitAssign(
  parentAction: Action,
  exitTarget: string,
  steps: readonly ResolvedStep[],
): ReturnType<typeof runbookSetup.assign> {
  const baseAssign = {
    retryCount: 0,
    parentRetryCount: 0,
    iterationRetryCount: 0,
    substep: extractSubstepFromStateId(exitTarget),
  } satisfies Pick<
    RunbookContext,
    'retryCount' | 'parentRetryCount' | 'iterationRetryCount' | 'substep'
  >;

  switch (parentAction.type) {
    case 'GOTO': {
      const targetStep = steps.find((s) => s.name === parentAction.target.step);
      if (targetStep?.kind === 'for') {
        const forClause = targetStep.forClause;
        return runbookSetup.assign({
          ...baseAssign,
          // Parent exit always creates fresh ForContext — never preserve an
          // exhausted stack (initForStack's intra-loop check is wrong here).
          forStack: ({ context }: { context: RunbookContext }): readonly ForContext[] => {
            const iteration = resolveAtValueRuntime(
              parentAction.target.at,
              forClause.start,
              context.forStack,
            );
            return [createForContext(targetStep.name, forClause, iteration, false)];
          },
          iterationResults: EMPTY_RESULTS,
          substepCompletedCount: 0,
          deferredResults: EMPTY_RESULTS,
          lastAction: makeAggregationLastAction(buildGotoLastAction(parentAction.target)),
          substep: parentAction.target.substep ?? targetStep.substeps[0]?.id,
        });
      }
      const targetHasSubsteps = targetStep && resolvedStepHasSubsteps(targetStep);
      const targetHasAggregationTransitions = !!targetStep?.transitions;
      return runbookSetup.assign({
        ...baseAssign,
        forStack: EMPTY_FOR_STACK,
        ...(targetHasSubsteps
          ? {
              iterationResults: targetHasAggregationTransitions ? EMPTY_RESULTS : undefined,
              substepCompletedCount: 0,
              deferredResults: EMPTY_RESULTS,
            }
          : {}),
        lastAction: makeAggregationLastAction(buildGotoLastAction(parentAction.target)),
      });
    }
    case 'STOP':
      return runbookSetup.assign({
        ...baseAssign,
        forStack: EMPTY_FOR_STACK,
        lastAction: makeAggregationLastAction({ type: 'STOP' as const }),
        lastMessage: parentAction.message,
      });
    case 'COMPLETE':
      return runbookSetup.assign({
        ...baseAssign,
        forStack: EMPTY_FOR_STACK,
        lastAction: makeAggregationLastAction({ type: 'COMPLETE' as const }),
        lastMessage: parentAction.message,
      });
    case 'CONTINUE':
      return runbookSetup.assign({
        ...baseAssign,
        forStack: EMPTY_FOR_STACK,
        lastAction: makeAggregationLastAction({ type: 'CONTINUE' as const }),
        lastMessage: undefined,
      });
    default:
      return runbookSetup.assign({
        ...baseAssign,
        forStack: EMPTY_FOR_STACK,
        lastAction: makeAggregationLastAction({ type: parentAction.type }),
        lastMessage: undefined,
      });
  }
}

/**
 * Build the `always` (event-less) transition configuration for a parent aggregation state.
 *
 * Parent states are intermediate states that a step's last substep transitions to after
 * completing. The parent state then immediately (via `always`) routes to the correct
 * next state based on accumulated iteration results and configured transitions.
 *
 * Handles four cases:
 * - Case A: FOR step with transitions — loop-back guard + aggregation pass/fail guards
 * - Case B: Non-FOR step with transitions — aggregation pass/fail guards only
 * - Case C: FOR step without transitions — loop-back guard + unconditional exit
 * - Case D: Non-FOR step without transitions — unconditional pass-through
 *
 * @param config - The parent state config (discriminated by isParentState=true)
 * @param steps - The full steps array
 * @param evaluationOptions - Filesystem options threaded through to OUTPUTS evaluation
 * @returns XState state config with `always` transitions
 */
function buildParentStateConfig(
  config: ParentStateConfig,
  steps: readonly ResolvedStep[],
  evaluationOptions: EvaluateOutputOptions | undefined,
): RunbookStateConfig {
  const parentStep = config.parentStep;
  const stepName = config.stepName;

  const hasFor = parentStep.kind === 'for';
  const hasAggregation = !!parentStep.aggregation;
  const nextTarget = routeThroughParentArtifactsIfNeeded(
    findNextStateId(stepName, undefined, steps),
    steps,
  );
  const firstSubstep = parentStep.substeps[0] as (typeof parentStep.substeps)[number] | undefined;
  const firstSubstepStateId = firstSubstep
    ? routeThroughParentArtifactsIfNeeded(formatStateId(stepName, firstSubstep.id), steps)
    : nextTarget;

  const always: (RunbookAlwaysEntry & object)[] = [];

  // FOR iteration-level aggregation/transitions — default when iteration machinery is needed
  const needsIterationMachinery =
    hasFor &&
    (parentStep.forClause.transitions ?? parentStep.forClause.aggregation ?? hasAggregation);
  const forAggregation: Aggregation | undefined = needsIterationMachinery
    ? (parentStep.forClause.aggregation ?? { strategy: 'ALL' })
    : undefined;
  const forTransitions: Transitions | undefined = needsIterationMachinery
    ? (parentStep.forClause.transitions ?? {
        pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
      })
    : undefined;

  type GuardFn = (args: { context: RunbookContext; event: RunbookEvent }) => boolean;

  // Build retry-aware transition entries for one aggregated outcome branch.
  const buildOutcomeEntries = (
    branchGuard: GuardFn,
    transition: { retry: number; action: Action },
    target: string,
  ): (RunbookAlwaysEntry & object)[] => {
    const exhausted = {
      guard: ({ context, event }: { context: RunbookContext; event: RunbookEvent }) =>
        branchGuard({ context, event }) &&
        (transition.retry <= 0 || context.parentRetryCount >= transition.retry),
      target,
      actions: [
        buildParentExitAssign(transition.action, target, steps),
        runbookSetup.assign({
          retryMax: transition.retry > 0 ? transition.retry : undefined,
        }),
      ],
    };

    if (transition.retry <= 0) return [exhausted];

    return [
      {
        guard: ({ context, event }: { context: RunbookContext; event: RunbookEvent }) =>
          branchGuard({ context, event }) && context.parentRetryCount < transition.retry,
        // Target the parent state itself (self re-enter). On success a
        // sibling priority-0 always entry observes lastAction.type === 'RETRY'
        // (aggregated) and routes to firstSubstepStateId; on error the
        // priority-0 RETRY_ERROR always entry routes to STOPPED. Routing
        // via always-entries ensures the error-path never enters the substep
        // state (whose PASS/FAIL transitions would overwrite the
        // RETRY_ERROR lastAction before the priority-0 guard could fire).
        target: formatStateId(stepName),
        actions: runbookSetup.assign(({ context }: { context: RunbookContext }) => {
          // Run the retry hook: iterate every delegated substep in the active
          // frame, re-issue their delegations, collect new tokens into a
          // frontier. Uniform re-delegation (docs/spec/language.md §4.2, §5). Never throws.
          const hook = runRetryHook(context, parentStep, steps);
          if (hook.status === 'error') {
            // RETRY_ERROR variant: structurally distinct LastAction type. The
            // priority-0 always entry routes to STOPPED on this discriminant
            // — no counter increments, no frontier population, no substep
            // reset. Aggregation origin mirrors the sibling RETRY emission:
            // both sit on the parent-aggregation retry path.
            return {
              lastAction: makeAggregationLastAction({
                type: 'RETRY_ERROR' as const,
                code: hook.code,
                message: hook.message,
              }),
              substepStates: hook.substepStates,
            };
          }
          return {
            // Aggregation origin marks this RETRY as aggregation-driven (spec §3.5).
            lastAction: makeAggregationLastAction({ type: 'RETRY' as const }),
            parentRetryCount: context.parentRetryCount + 1,
            // Counter contract on parent-aggregation retry (see docs/internal/architecture.md §Retry Counters):
            //   parentRetryCount — machine-invariant counter used by the retry-budget guards
            //     above (`context.parentRetryCount < transition.retry`). Must be incremented
            //     here or the guard never exhausts. RESET the sibling `iterationRetryCount`
            //     to 0 because re-entering the parent frame from the top invalidates any
            //     in-progress FOR iteration's budget.
            //   retryCount — user-visible counter surfaced to the execution layer
            //     (actor-service) and to commands like `rd echo --result`. Always
            //     incremented on any retry transition (both this site and the adjacent
            //     FOR-iteration retry site below).
            // Do NOT unify these counters: the parent-retry-budget guards would break.
            retryCount: context.retryCount + 1,
            retryMax: transition.retry,
            forStack: EMPTY_FOR_STACK,
            iterationResults: EMPTY_RESULTS,
            substepCompletedCount: 0,
            deferredResults: EMPTY_RESULTS,
            iterationRetryCount: 0,
            lastMessage: undefined,
            substep: firstSubstep?.id,
            substepStates: hook.substepStates,
            delegateFrontier: hook.frontier.length > 0 ? hook.frontier : undefined,
          };
        }),
      },
      exhausted,
    ];
  };

  // Helper: build guards to advance to next substep within an iteration.
  // Results count determines which substep to route to next.
  const substeps = parentStep.substeps;
  const pushAdvanceGuards = (): void => {
    for (let i = 1; i < substeps.length; i++) {
      const prevSubstepId = substeps[i - 1].id;
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          // substep === undefined means sequence complete or loop control — don't advance
          if (context.substep === undefined) return false;
          return context.substepCompletedCount === i && context.substep === prevSubstepId;
        },
        target: routeThroughParentArtifactsIfNeeded(formatStateId(stepName, substeps[i].id), steps),
        actions: runbookSetup.assign({
          substep: substeps[i].id,
        }),
      });
    }
  };

  // FOR iteration guards — order matters: retry → direct-exit → loop-back → aggregation
  // FOR substeps advance to siblings directly (not through parent), so no advance guards needed.
  if (hasFor) {
    if (forAggregation && forTransitions) {
      // Aggregating mode: iteration-level aggregation with configured transitions

      const computeIterationResult = (context: RunbookContext): 'pass' | 'fail' => {
        const results = context.deferredResults ?? [];
        const hasFailed = results.some((r) => r === 'fail');
        const passCount = results.filter((r) => r === 'pass').length;
        return shouldAggregationPass(hasFailed, passCount, forAggregation.strategy)
          ? 'pass'
          : 'fail';
      };

      const getIterationTransition = (
        context: RunbookContext,
      ): {
        result: 'pass' | 'fail';
        transition: { retry: number; action: Action };
      } => {
        const result = computeIterationResult(context);
        return {
          result,
          transition: result === 'pass' ? forTransitions.pass : forTransitions.fail,
        };
      };

      // Guard 1: Iteration-level retry
      const pushIterationRetry = (
        kind: 'pass' | 'fail',
        transition: { retry: number; action: Action },
      ): void => {
        if (transition.retry <= 0) return;
        always.push({
          guard: ({ context }: { context: RunbookContext }) => {
            if (context.substep !== undefined) return false; // mid-iteration — not ready
            if (context.forStack.length === 0) return false; // loop already exited
            const selected = getIterationTransition(context);
            return (
              selected.result === kind && context.iterationRetryCount < selected.transition.retry
            );
          },
          // Target parent self so post-assign always entries route based
          // on the resulting lastAction variant (RETRY → firstSubstep,
          // RETRY_ERROR → STOPPED). Targeting the substep directly would
          // let its PASS/FAIL transitions overwrite lastAction before the
          // priority-0 RETRY_ERROR guard could fire.
          target: formatStateId(stepName),
          actions: runbookSetup.assign(({ context }: { context: RunbookContext }) => {
            // Run the retry hook: iterate every delegated substep in the
            // current iteration frame, re-issue their delegations, collect new
            // tokens into a frontier. Uniform re-delegation within the frame
            // (docs/spec/language.md §4.2, §5). activeFrameKey scopes the hook to this
            // iteration — other iterations' substep states remain untouched.
            const hook = runRetryHook(context, parentStep, steps);
            if (hook.status === 'error') {
              // RETRY_ERROR variant: structurally distinct LastAction type.
              // The sibling priority-0 always entry on the parent state
              // routes to STOPPED on this discriminant. Counters are not
              // incremented (retry was never actually taken); no frontier
              // is populated; no substep reset. Aggregation origin mirrors
              // the iteration RETRY emission below.
              return {
                lastAction: makeAggregationLastAction({
                  type: 'RETRY_ERROR' as const,
                  code: hook.code,
                  message: hook.message,
                }),
                substepStates: hook.substepStates,
              };
            }
            return {
              iterationRetryCount: context.iterationRetryCount + 1,
              // Counter contract on FOR-iteration retry (see docs/internal/architecture.md §Retry Counters):
              //   iterationRetryCount — machine-invariant counter used by the iteration
              //     retry-budget guard above. Must be incremented here or the guard never
              //     exhausts. Leave `parentRetryCount` UNTOUCHED: a nested iteration retry
              //     does not consume a parent-level retry attempt.
              //   retryCount — always incremented; see the parent-aggregation retry site
              //     above for the contract.
              retryCount: context.retryCount + 1,
              retryMax: transition.retry,
              // Aggregation origin marks this RETRY as aggregation-driven (spec §3.5).
              lastAction: makeAggregationLastAction({ type: 'RETRY' as const }),
              substepCompletedCount: 0,
              deferredResults: EMPTY_RESULTS,
              substep: firstSubstep?.id,
              substepStates: hook.substepStates,
              delegateFrontier: hook.frontier.length > 0 ? hook.frontier : undefined,
            };
          }),
        });
      };
      pushIterationRetry('pass', forTransitions.pass);
      pushIterationRetry('fail', forTransitions.fail);

      // Guard 2: BREAK exit — substep BREAK exits the loop (after any configured retry).
      // Pushed after retry so retry gets first chance to intercept.
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.forStack.length === 0) return false;
          return context.lastAction?.type === 'BREAK';
        },
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          completedForContext: ({ context }: { context: RunbookContext }) =>
            peekForStack(context.forStack),
          forStack: EMPTY_FOR_STACK,
          lastAction: makeDirectLastAction({ type: 'BREAK' as const }),
          iterationResults: ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] =>
            context.iterationResults ?? [],
          deferredResults: EMPTY_RESULTS,
        }),
      });

      // Guard 4a: NEXT loop-back — substep NEXT advances to next iteration (no accumulation).
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type !== 'NEXT') return false;
          const top = peekForStack(context.forStack);
          return top !== undefined && hasMoreIterations(top);
        },
        target: firstSubstepStateId,
        actions: runbookSetup.assign({
          forStack: ({ context }: { context: RunbookContext }) => {
            const top = peekForStack(context.forStack);
            if (!top) return context.forStack;
            return [{ ...top, iteration: nextIteration(top), currentValue: undefined }];
          },
          iterationResults: ({ context }: { context: RunbookContext }) =>
            context.iterationResults ?? [],
          substepCompletedCount: 0,
          deferredResults: EMPTY_RESULTS,
          retryCount: 0,
          iterationRetryCount: 0,
          substep: firstSubstep?.id,
        }),
      });

      // Guard 4b: NEXT at last iteration — exit loop to aggregation (no accumulation).
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type !== 'NEXT') return false;
          if (context.forStack.length === 0) return false; // Already exited loop
          const top = peekForStack(context.forStack);
          return top === undefined || !hasMoreIterations(top);
        },
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          completedForContext: ({ context }: { context: RunbookContext }) =>
            peekForStack(context.forStack),
          forStack: EMPTY_FOR_STACK,
        }),
      });

      // Guard 3: Direct iteration exit (terminal actions bypass parent aggregation)
      const pushDirectIterationExit = (
        kind: 'pass' | 'fail',
        transition: { retry: number; action: Action },
      ): void => {
        if (!isTerminalAction(transition.action)) {
          return;
        }

        const target = resolveActionTarget(transition.action, stepName, steps);
        always.push({
          guard: ({ context }: { context: RunbookContext }) => {
            if (context.substep !== undefined) return false; // mid-iteration — not ready
            if (context.forStack.length === 0) return false; // loop already exited
            // Only fire for configured transitions — substep loop control (BREAK/NEXT) is handled above
            if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
              return false;
            const selected = getIterationTransition(context);
            if (selected.result !== kind) return false;
            return transition.retry <= 0 || context.iterationRetryCount >= transition.retry;
          },
          target,
          actions: [
            buildParentExitAssign(transition.action, target, steps),
            runbookSetup.assign({
              retryMax: transition.retry > 0 ? transition.retry : undefined,
            }),
          ],
        });
      };
      pushDirectIterationExit('pass', forTransitions.pass);
      pushDirectIterationExit('fail', forTransitions.fail);

      // Guard 3b: Iteration-level CONTINUE — exit loop + route to parent aggregation.
      const pushIterationContinueExit = (
        kind: 'pass' | 'fail',
        transition: { retry: number; action: Action },
      ): void => {
        if (!isStepExitAction(transition.action)) return;

        always.push({
          guard: ({ context }: { context: RunbookContext }) => {
            if (context.substep !== undefined) return false;
            if (context.forStack.length === 0) return false; // Already exited loop
            // Only fire for configured transitions — substep loop control (BREAK/NEXT) is handled above
            if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
              return false;
            const selected = getIterationTransition(context);
            if (selected.result !== kind) return false;
            return transition.retry <= 0 || context.iterationRetryCount >= transition.retry;
          },
          target: formatStateId(stepName),
          actions: runbookSetup.assign({
            completedForContext: ({ context }: { context: RunbookContext }) =>
              peekForStack(context.forStack),
            forStack: EMPTY_FOR_STACK,
            lastAction: makeDirectLastAction({ type: 'CONTINUE' as const }),
            iterationResults: ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] =>
              context.iterationResults ?? [],
            deferredResults: EMPTY_RESULTS,
          }),
        });
      };
      pushIterationContinueExit('pass', forTransitions.pass);
      pushIterationContinueExit('fail', forTransitions.fail);

      // Guard 3c: Iteration-level BREAK — exit loop without accumulation.
      const pushIterationBreakExit = (
        kind: 'pass' | 'fail',
        transition: { retry: number; action: Action },
      ): void => {
        if (!isBreakAction(transition.action)) return;

        always.push({
          guard: ({ context }: { context: RunbookContext }) => {
            if (context.substep !== undefined) return false;
            if (context.forStack.length === 0) return false;
            if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
              return false;
            const selected = getIterationTransition(context);
            if (selected.result !== kind) return false;
            return transition.retry <= 0 || context.iterationRetryCount >= transition.retry;
          },
          target: formatStateId(stepName),
          actions: runbookSetup.assign({
            completedForContext: ({ context }: { context: RunbookContext }) =>
              peekForStack(context.forStack),
            forStack: EMPTY_FOR_STACK,
            lastAction: makeAggregationLastAction({ type: 'BREAK' as const }),
            iterationResults: ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] =>
              context.iterationResults ?? [],
            deferredResults: EMPTY_RESULTS,
          }),
        });
      };
      pushIterationBreakExit('pass', forTransitions.pass);
      pushIterationBreakExit('fail', forTransitions.fail);

      // Guard 4c: Configured loop-back — DEFER/NEXT from iteration-level transition (not substep loop control).
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
            return false;
          const selected = getIterationTransition(context).transition;
          if (!isAccumulatingAction(selected.action) && selected.action.type !== 'NEXT')
            return false;
          const top = peekForStack(context.forStack);
          return top !== undefined && hasMoreIterations(top);
        },
        target: firstSubstepStateId,
        actions: runbookSetup.assign({
          forStack: ({ context }: { context: RunbookContext }) => {
            const top = peekForStack(context.forStack);
            if (!top) return context.forStack;
            return [{ ...top, iteration: nextIteration(top), currentValue: undefined }];
          },
          iterationResults: ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] => {
            const results = context.iterationResults ?? [];
            const selected = getIterationTransition(context).transition;
            // Only DEFER accumulates iteration result; NEXT skips accumulation
            if (isAccumulatingAction(selected.action)) {
              return [...results, computeIterationResult(context)];
            }
            return results;
          },
          substepCompletedCount: 0,
          deferredResults: EMPTY_RESULTS,
          retryCount: 0,
          iterationRetryCount: 0,
          substep: firstSubstep?.id,
        }),
      });

      // Guard 4d: Last iteration finalization — persist result to iterationResults before aggregation.
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
            return false;
          if (context.forStack.length === 0) return false; // Already exited loop
          const selected = getIterationTransition(context).transition;
          if (!isAccumulatingAction(selected.action) && selected.action.type !== 'NEXT')
            return false;
          const top = peekForStack(context.forStack);
          return top === undefined || !hasMoreIterations(top);
        },
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          completedForContext: ({ context }: { context: RunbookContext }) =>
            peekForStack(context.forStack),
          forStack: EMPTY_FOR_STACK,
          iterationResults: ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] => {
            const results = context.iterationResults ?? [];
            const selected = getIterationTransition(context).transition;
            // Only DEFER accumulates iteration result; NEXT skips accumulation
            if (isAccumulatingAction(selected.action)) {
              return [...results, computeIterationResult(context)];
            }
            return results;
          },
        }),
      });
    } else {
      // Sequential mode: simple loop-back/exit without aggregation

      // BREAK exit: substep BREAK exits the loop immediately
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.forStack.length === 0) return false;
          return context.lastAction?.type === 'BREAK';
        },
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          completedForContext: ({ context }: { context: RunbookContext }) =>
            peekForStack(context.forStack),
          forStack: EMPTY_FOR_STACK,
          lastAction: makeDirectLastAction({ type: 'BREAK' as const }),
          iterationResults: ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] =>
            context.iterationResults ?? [],
          deferredResults: EMPTY_RESULTS,
        }),
      });

      // NEXT loop-back: substep NEXT advances to next iteration (no accumulation).
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type !== 'NEXT') return false;
          const top = peekForStack(context.forStack);
          return top !== undefined && hasMoreIterations(top);
        },
        target: firstSubstepStateId,
        actions: runbookSetup.assign({
          forStack: ({ context }: { context: RunbookContext }) => {
            const top = peekForStack(context.forStack);
            if (!top) return context.forStack;
            return [{ ...top, iteration: nextIteration(top), currentValue: undefined }];
          },
          iterationResults: ({ context }: { context: RunbookContext }) =>
            context.iterationResults ?? [],
          substepCompletedCount: 0,
          deferredResults: EMPTY_RESULTS,
          retryCount: 0,
          iterationRetryCount: 0,
          substep: firstSubstep?.id,
        }),
      });

      // NEXT at last iteration: exit loop (no accumulation).
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type !== 'NEXT') return false;
          if (context.forStack.length === 0) return false;
          const top = peekForStack(context.forStack);
          return top === undefined || !hasMoreIterations(top);
        },
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          completedForContext: ({ context }: { context: RunbookContext }) =>
            peekForStack(context.forStack),
          forStack: EMPTY_FOR_STACK,
        }),
      });

      // Sequential loop-back: all substeps done, more iterations remain
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
            return false;
          const top = peekForStack(context.forStack);
          return top !== undefined && hasMoreIterations(top);
        },
        target: firstSubstepStateId,
        actions: runbookSetup.assign({
          forStack: ({ context }: { context: RunbookContext }) => {
            const top = peekForStack(context.forStack);
            if (!top) return context.forStack;
            return [{ ...top, iteration: nextIteration(top), currentValue: undefined }];
          },
          substepCompletedCount: 0,
          retryCount: 0,
          iterationRetryCount: 0,
          substep: firstSubstep?.id,
        }),
      });

      // Sequential exit: all substeps done, no more iterations.
      // Targets nextTarget directly (not self) so that any decoration of this
      // transition (e.g. storeStepOutputs) observes the still-populated forStack
      // before the assign clears it. A self-target here would force a second
      // `always` evaluation cycle in which the case C unguarded exit would fire
      // with an already-empty forStack, losing per-iteration template variables
      // (Index, loop variable, etc.).
      always.push({
        guard: ({ context }: { context: RunbookContext }) => {
          if (context.substep !== undefined) return false;
          if (context.lastAction?.type === 'BREAK' || context.lastAction?.type === 'NEXT')
            return false;
          if (context.forStack.length === 0) return false;
          const top = peekForStack(context.forStack);
          return top === undefined || !hasMoreIterations(top);
        },
        target: nextTarget,
        actions: runbookSetup.assign({
          forStack: EMPTY_FOR_STACK,
          retryCount: 0,
          parentRetryCount: 0,
          iterationRetryCount: 0,
          substep: extractSubstepFromStateId(nextTarget),
        }),
      });
    }
  }

  // Aggregation guards (Cases A & B: steps with explicit aggregation)
  if (hasAggregation) {
    const passTarget = resolveActionTarget(parentStep.transitions.pass.action, stepName, steps);
    const failTarget = resolveActionTarget(parentStep.transitions.fail.action, stepName, steps);

    // All iteration results are already persisted to iterationResults by guards 2/4a-4d.
    // Aggregation simply reads from the uniform source — no inline computation needed.
    const aggregationPasses = ({ context }: { context: RunbookContext }): boolean => {
      const allResults = hasFor
        ? (context.iterationResults ?? [])
        : (context.deferredResults ?? []);
      const hasFailed = allResults.some((r) => r === 'fail');
      const passCount = allResults.filter((r) => r === 'pass').length;
      return shouldAggregationPass(hasFailed, passCount, parentStep.aggregation!.strategy);
    };

    const passBranchGuard: GuardFn = aggregationPasses;
    const failBranchGuard: GuardFn = ({ context }) => !aggregationPasses({ context });

    // Advance to next substep (both FOR and non-FOR — substep === undefined prevents
    // advance guards from firing on completed iterations or loop control)
    pushAdvanceGuards();

    // Final aggregation: all results in — evaluate and apply transition
    always.push(
      ...buildOutcomeEntries(passBranchGuard, parentStep.transitions.pass, passTarget),
      ...buildOutcomeEntries(failBranchGuard, parentStep.transitions.fail, failTarget),
    );
  } else {
    // Unconditional exit (Cases C & D: no explicit aggregation)
    // Advance to next substep (both FOR and non-FOR)
    pushAdvanceGuards();

    // Resolve PASS / FAIL targets from the parent's declared transitions so we
    // honor `## 1. Parent\n- FAIL STOP` even without an AGGREGATION modifier.
    // Without this, parent-level FAIL was unreachable in two cases:
    // - Case C (FOR without aggregation): any iteration failed, but
    //   iterationResults was never checked.
    // - Case D (non-FOR pass-through): a substep FAIL/DEFER populated
    //   deferredResults, but there was no guarded exit that read it.
    const parentPassTarget = resolveActionTarget(
      parentStep.transitions.pass.action,
      stepName,
      steps,
    );
    const parentFailTarget = resolveActionTarget(
      parentStep.transitions.fail.action,
      stepName,
      steps,
    );

    // Derive a LastAction variant + optional message from the parent's
    // configured FAIL action. Mirrors the shape used elsewhere (e.g.
    // buildParentExitAssign) but with direct origin — the unconditional-exit
    // branch is not aggregation.
    const failAction = parentStep.transitions.fail.action;
    const failLastAction: LastAction =
      failAction.type === 'GOTO'
        ? makeDirectLastAction(buildGotoLastAction(failAction.target))
        : makeDirectLastAction({ type: failAction.type });
    const failLastMessage =
      failAction.type === 'STOP' || failAction.type === 'COMPLETE' ? failAction.message : undefined;

    const passAction = parentStep.transitions.pass.action;
    const passLastAction: LastAction =
      passAction.type === 'GOTO'
        ? makeDirectLastAction(buildGotoLastAction(passAction.target))
        : makeDirectLastAction({ type: passAction.type });
    const passLastMessage =
      passAction.type === 'STOP' || passAction.type === 'COMPLETE' ? passAction.message : undefined;

    const commonAssign = {
      forStack: EMPTY_FOR_STACK,
      retryCount: 0,
      parentRetryCount: 0,
      iterationRetryCount: 0,
    } satisfies Pick<
      RunbookContext,
      'forStack' | 'retryCount' | 'parentRetryCount' | 'iterationRetryCount'
    >;

    if (hasFor) {
      // Case C: FOR without aggregation.
      //
      // Discriminator: any FAIL in iterationResults routes to parent FAIL target;
      // otherwise route to parent PASS target. BOTH entries must be guarded —
      // an unguarded earlier entry would shadow the guarded one (XState v5
      // evaluates `always` entries in order).
      // Guards: loopExitedViaControl, loopCompletedNormally, anyIterationFailed — registered in runbookSetup.

      // BREAK/NEXT PASS routing: exit was via BREAK or NEXT — preserve lastAction as-is.
      // lastMessage is cleared: BREAK/NEXT carry no message; any stale substep message must not leak.
      // Safety: in Case C (no aggregation), iterationResults is never populated by sequential guards,
      // so anyIterationFailed is always false when loopExitedViaControl is true. If this invariant changes,
      // revisit guard ordering — loopExitedViaControl must either check for fails or be merged with anyIterationFailed.
      always.push({
        guard: 'loopExitedViaControl',
        target: parentPassTarget,
        actions: runbookSetup.assign({
          ...commonAssign,
          substep: extractSubstepFromStateId(parentPassTarget),
          lastMessage: undefined,
        }),
      });
      // Normal PASS routing: no failed iterations and no BREAK/NEXT → parent's PASS action target.
      // The BREAK/NEXT exclusion duplicates loopExitedViaControl because XState evaluates guards
      // independently (not as an if-else chain) — both guards must be self-contained.
      always.push({
        guard: 'loopCompletedNormally',
        target: parentPassTarget,
        actions: runbookSetup.assign({
          ...commonAssign,
          substep: extractSubstepFromStateId(parentPassTarget),
          lastAction: passLastAction,
          lastMessage: passLastMessage,
        }),
      });
      // FAIL routing: any failed iteration → parent's FAIL action target.
      always.push({
        guard: 'anyIterationFailed',
        target: parentFailTarget,
        actions: runbookSetup.assign({
          ...commonAssign,
          substep: extractSubstepFromStateId(parentFailTarget),
          lastAction: failLastAction,
          lastMessage: failLastMessage,
        }),
      });
    } else {
      // Case D: non-FOR pass-through.
      //
      // Discriminator: any FAIL in deferredResults routes to parent FAIL target;
      // otherwise route to parent PASS target. BOTH entries must be guarded —
      // an unguarded earlier entry would shadow the guarded one (XState v5
      // evaluates `always` entries in order).
      const anyDeferredFail: GuardFn = ({ context }) =>
        (context.deferredResults ?? []).some((r) => r === 'fail');
      const noDeferredFail: GuardFn = ({ context }) =>
        !(context.deferredResults ?? []).some((r) => r === 'fail');

      // PASS routing: no failed deferred substeps → parent's PASS action target.
      always.push({
        guard: noDeferredFail,
        target: parentPassTarget,
        actions: runbookSetup.assign({
          ...commonAssign,
          substep: extractSubstepFromStateId(parentPassTarget),
          substepCompletedCount: 0,
          deferredResults: undefined,
          lastAction: passLastAction,
          lastMessage: passLastMessage,
        }),
      });
      // FAIL routing: any failed deferred substep → parent's FAIL action target.
      always.push({
        guard: anyDeferredFail,
        target: parentFailTarget,
        actions: runbookSetup.assign({
          ...commonAssign,
          substep: extractSubstepFromStateId(parentFailTarget),
          substepCompletedCount: 0,
          deferredResults: undefined,
          lastAction: failLastAction,
          lastMessage: failLastMessage,
        }),
      });
    }
  }

  // Priority-0 (terminal) always entries, in reverse-insert order so that
  // after two `unshift` calls the RETRY_ERROR guard lands at position 0 and
  // the RETRY (aggregated) router at position 1 — both ahead of the retry
  // and exhaustion branches below.
  //
  // (1) RETRY (aggregated, success): the retry-hook `assign` completed
  //     without error. Routes to firstSubstepStateId to re-enter the
  //     substep chain with fresh delegation tokens. Must precede the retry
  //     branches so a re-evaluation of the aggregation path cannot re-run
  //     the hook that just succeeded. Guarded on aggregation origin to
  //     avoid matching non-retry RETRY actions (none exist today, but the
  //     marker narrows intent).
  if (firstSubstep !== undefined) {
    always.unshift({
      guard: ({ context }: { context: RunbookContext }) =>
        context.lastAction?.type === 'RETRY' && context.lastAction.origin === 'aggregation',
      target: firstSubstepStateId,
    });
  }

  // (2) RETRY_ERROR: fires when a retry-transition assign wrote a
  // RetryErrorLastAction onto lastAction (parent or iteration retry-hook
  // failure). The type discriminant is structurally unique — no other code
  // path writes this variant. The payload is already on lastAction; no
  // action needed, which preserves code/message verbatim into STOPPED.
  // Must precede every other always entry so a re-evaluation of the
  // aggregation branch cannot re-run the broken hook. Counters are
  // preserved (the retry was never actually taken); the STOPPED.entry
  // action assigns lifecycle='stopped' on arrival.
  always.unshift({
    guard: ({ context }: { context: RunbookContext }) => context.lastAction?.type === 'RETRY_ERROR',
    target: STOPPED_STATE_NAME,
  });

  return {
    always: always.map((transition) =>
      decorateParentTransition(transition, stepName, parentStep.outputs, evaluationOptions),
    ),
  } satisfies RunbookStateConfig;
}

/**
 * Build the top-level transient landing state for sourced-FOR exhaustion.
 *
 * The actor has already recorded the exhausted FOR frame in
 * `completedForContext` and cleared `forStack`; this state only routes to the
 * owning parent state so normal parent aggregation/pass-through logic can
 * finish the loop without synthesizing a PASS event.
 *
 * @param steps - Resolved runbook steps.
 * @returns Top-level transient state config for `#iteration_exhausted`.
 */
function buildIterationExhaustedStateConfig(steps: readonly ResolvedStep[]): RunbookStateConfig {
  const always = steps
    .filter(
      (step): step is ResolvedStep & { readonly kind: 'for' } =>
        step.kind === 'for' && isSourced(step.forClause),
    )
    .map((step): RunbookAlwaysEntry & object => ({
      guard: ({ context }: { context: RunbookContext }) =>
        context.completedForContext?.stepId === step.name,
      target: formatStateId(step.name),
    }));

  return { id: ITERATION_EXHAUSTED_STATE_NAME, always } satisfies RunbookStateConfig;
}

/**
 * Decorate a parent-state `always` transition with OUTPUTS-related actions.
 *
 * Adds a `storeStepOutputs` action when the transition exits the parent state
 * (i.e. its target is neither the parent state itself nor a substep beneath it)
 * and the parent step declares OUTPUTS.
 *
 * Self-targeting (`step::N`) and substep-internal (`step::N::M`) transitions are
 * intra-parent routing and never carry step OUTPUTS — those represent BREAK
 * cleanup, advance-to-substep, or loop-back machinery, not parent-step exit.
 *
 * Frontmatter OUTPUTS are NOT attached here: they are emitted exactly once from
 * the terminal states' `entry` actions (COMPLETE.entry / STOPPED.entry) under
 * the single-owner terminal-entry architecture.
 *
 * @param transition - The always transition entry to decorate
 * @param stepName - The parent step name
 * @param outputs - The parent step's OUTPUTS declarations (if any)
 * @param evaluationOptions - Filesystem options threaded through to OUTPUTS evaluation
 * @returns The decorated transition (or the original if no decoration applies)
 */
function decorateParentTransition<T extends RunbookAlwaysEntry & object>(
  transition: T,
  stepName: string,
  outputs: readonly OutputDeclaration[] | undefined,
  evaluationOptions: EvaluateOutputOptions | undefined,
): T {
  const extra: RunbookAction[] = [];
  const target = typeof transition.target === 'string' ? transition.target : undefined;
  const exitsParent =
    target !== undefined &&
    target !== formatStateId(stepName) &&
    !target.startsWith(`${formatStateId(stepName)}::`);

  if (exitsParent && outputs && outputs.length > 0) {
    extra.push(
      actionRef(
        'storeStepOutputs',
        withEvaluationOptions(
          {
            outputs,
            stepName,
            useCompletedSubstep: true,
            useCompletedForContext: true,
          },
          evaluationOptions,
        ),
      ),
    );
  }

  return prependActions(transition, extra);
}

/**
 * Build configuration for a transient retry state.
 *
 * Uses `always` transitions to evaluate retry guard synchronously:
 * if retryCount < retry, self-transition back to step with increment;
 * otherwise, execute the exhausted action via `buildActionTransition`.
 *
 * @param transition - The transition object with retry count and exhausted action
 * @param transition.kind - Whether this is a 'pass' or 'fail' transition
 * @param transition.retry - Maximum retry attempts before executing the exhausted action
 * @param transition.action - The action to execute when retries are exhausted
 * @param currentStateId - The state ID to loop back to on retry
 * @param stepName - Step name for the exhausted action builder
 * @param substepId - Substep ID for the exhausted action builder
 * @param steps - All parsed steps
 * @param resultKind - 'pass' or 'fail' for iteration result recording
 * @param evaluationOptions - Filesystem options threaded through to OUTPUTS evaluation
 * @returns XState state config with `always` transitions
 */
function buildRetryStateConfig(
  transition: { kind: string; retry: number; action: Action },
  currentStateId: string,
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
  resultKind: 'pass' | 'fail',
  evaluationOptions: EvaluateOutputOptions | undefined,
): RunbookStateConfig {
  const exhaustedTransition = buildActionTransition(
    transition.action,
    stepName,
    substepId,
    steps,
    resultKind,
    evaluationOptions,
  );
  const rawEntries = Array.isArray(exhaustedTransition)
    ? exhaustedTransition
    : [exhaustedTransition];

  return {
    always: [
      {
        guard: ({ context }: { context: RunbookContext }) => context.retryCount < transition.retry,
        target: routeThroughParentArtifactsIfNeeded(currentStateId, steps),
        actions: runbookSetup.assign({
          lastAction: makeDirectLastAction({ type: 'RETRY' as const }),
          retryCount: ({ context }: { context: RunbookContext }) => context.retryCount + 1,
          retryMax: transition.retry,
        }),
      },
      ...(rawEntries as RunbookAlwaysEntry[]),
    ],
  } satisfies RunbookStateConfig;
}

/**
 * Resolve an Action to an XState target state ID for aggregation routing.
 *
 * @param action - The terminal action to resolve
 * @param stepName - The parent step name (for CONTINUE target resolution)
 * @param steps - The full steps array
 * @returns The target state ID string
 * @throws {Error} If GOTO target step does not exist in the steps array
 * @throws {Error} If NEXT or BREAK appears as a parent-step action (compiler invariant violation)
 */
function resolveActionTarget(
  action: Action,
  stepName: string,
  steps: readonly ResolvedStep[],
): string {
  switch (action.type) {
    case 'CONTINUE':
      return routeThroughParentArtifactsIfNeeded(
        findNextStateId(stepName, undefined, steps),
        steps,
      );
    case 'COMPLETE':
      return 'COMPLETE';
    case 'STOP':
      return 'STOPPED';
    case 'GOTO': {
      const targetStep = steps.find((s) => s.name === action.target.step);
      if (!targetStep) {
        throw new Error(`Compiler error: GOTO target step "${action.target.step}" does not exist`);
      }
      const substep = resolvedStepHasSubsteps(targetStep)
        ? (action.target.substep ?? targetStep.substeps[0]?.id)
        : action.target.substep;
      return routeThroughParentArtifactsIfNeeded(formatStateId(targetStep.name, substep), steps);
    }
    // DEFER/NEXT/BREAK are substep-only actions. This guard is the primary
    // enforcement point for all parent-step paths (aggregation + direct exit).
    case 'NEXT':
    case 'BREAK':
    case 'DEFER':
      throw new Error(
        `Compiler invariant violation: ${action.type} appeared as parent-step action. ` +
          `DEFER is only valid in substep or FOR iteration contexts.`,
      );
  }
}

/**
 * Build an XState transition for COMPLETE or STOP terminal actions.
 *
 * Both actions produce a transition to a terminal state with a lastAction
 * record and an optional user-provided message.
 *
 * @param target - The terminal state ID ('COMPLETE' or 'STOPPED')
 * @param actionType - The action type literal ('COMPLETE' or 'STOP')
 * @param message - Optional message from the action
 * @returns XState transition configuration targeting the terminal state
 */
function buildTerminalTransition(
  target: 'COMPLETE' | 'STOPPED',
  actionType: 'COMPLETE' | 'STOP',
  message: string | undefined,
): RunbookTransitionObject {
  return {
    target,
    actions: actionRef('setLastAction', {
      action: makeDirectLastAction({ type: actionType }),
      msg: message,
    }),
  };
}

function buildForceCompleteTransition(): {
  readonly target: '.COMPLETE';
  readonly actions: ActionRef<'setLastAction'>;
} {
  return {
    target: '.COMPLETE',
    actions: actionRef('setLastAction', ({ event }) => {
      assertEvent(event, 'FORCE_COMPLETE');
      return {
        action: makeDirectLastAction({ type: 'COMPLETE' as const }),
        msg: event.message,
      };
    }),
  };
}

function buildForceStopTransition(): {
  readonly target: '.STOPPED';
  readonly actions: ActionRef<'setLastAction'>;
} {
  return {
    target: `.${STOPPED_STATE_NAME}`,
    actions: actionRef('setLastAction', ({ event }) => {
      assertEvent(event, 'FORCE_STOP');
      return {
        action: makeDirectLastAction({ type: 'STOP' as const }),
        msg: event.message,
      };
    }),
  };
}
/**
 * Build an XState transition for NEXT or BREAK loop control actions.
 *
 * Validates that the step has a FOR clause. If not, routes to STOPPED as a
 * defensive fallback. Otherwise routes to the parent aggregation state
 * with substep result accumulation.
 *
 * @param actionType - The loop control action ('NEXT' or 'BREAK')
 * @param stepName - The current step name
 * @param substepId - The completing substep ID when loop control is fired from a substep
 * @param steps - The full array of runbook steps
 * @returns XState transition configuration
 */
function buildLoopControlTransition(
  actionType: 'NEXT' | 'BREAK',
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
): RunbookTransitionObject {
  const currentStep = steps.find((s) => s.name === stepName);
  if (currentStep?.kind !== 'for') {
    return {
      target: STOPPED_STATE_NAME,
      actions: actionRef('setLastAction', {
        action: makeDirectLastAction({ type: actionType }),
      }),
    };
  }
  // FOR step: increment completed count before transitioning to parent (no deferred result — flow control only)
  // BREAK does NOT clear forStack here — it's a pure signal. Loop state persists
  // until the loop actually exits (via the BREAK exit guard after retry evaluation).
  return {
    target: formatStateId(stepName),
    actions: runbookSetup.assign({
      substepCompletedCount: ({ context }: { context: RunbookContext }) =>
        context.substepCompletedCount + 1,
      lastAction: makeDirectLastAction({ type: actionType }),
      lastMessage: undefined,
      completedSubstep: substepId,
      substep: undefined,
    }),
  };
}

/**
 * Build an XState transition for the DEFER action.
 *
 * DEFER always routes substeps to the parent aggregation state with result
 * accumulation, enabling fail-fast ALL/ANY evaluation. For non-last substeps,
 * the parent's advance guards handle routing to the next sibling.
 * DEFER at step level is invalid and rejected by the parser/validator.
 *
 * **Aggregation and `lastAction` reporting:**
 * - Non-last substeps: DEFER routes to parent, the advance guard advances to the
 *   next sibling. The transition reports `action=DEFER`.
 * - Last substep: DEFER routes to parent, the aggregation guard fires, and
 *   `lastAction` is overwritten by the parent's resolved action (COMPLETE, STOP,
 *   CONTINUE, etc.) with `origin: 'aggregation'`. The transition reports the **parent's
 *   action**, not DEFER. This is expected — the DEFER was accumulated and resolved
 *   by aggregation.
 *
 * @param stepName - The current step name
 * @param substepId - The current substep ID within the step
 * @param steps - The full array of runbook steps
 * @param kind - Whether this is a 'pass' or 'fail' transition
 * @returns XState transition configuration
 * @throws {Error} If DEFER is used at step level (invariant violation — should be rejected by parser/validator)
 */
function buildDeferTransition(
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
  kind: 'pass' | 'fail',
): RunbookTransitionObject {
  const currentStep = steps.find((s) => s.name === stepName);

  // Substeps: DEFER always routes to parent (enables fail-fast ALL/ANY evaluation)
  if (substepId && currentStep && resolvedStepHasSubsteps(currentStep)) {
    const isLast = isLastSubstepOfStep(stepName, substepId, steps);
    return {
      target: formatStateId(stepName),
      actions: runbookSetup.assign({
        deferredResults: appendDeferredResult(kind),
        substepCompletedCount: ({ context }: { context: RunbookContext }) =>
          context.substepCompletedCount + 1,
        lastAction: makeDirectLastAction({ type: 'DEFER' as const }),
        lastMessage: undefined,
        completedSubstep: substepId,
        // Keep substep set for non-last (advance guard signal); clear for last
        substep: isLast ? undefined : substepId,
      }),
    };
  }

  // Step-level DEFER should be rejected by the parser/validator.
  // If we reach here, it's an invariant violation.
  throw new Error(
    `Invariant violation: DEFER at step level for "${stepName}". ` +
      `DEFER is only valid in substep or FOR iteration contexts.`,
  );
}

/**
 * Build an XState transition for the CONTINUE action.
 *
 * Handles three scenarios:
 * 1. Last substep of a parent step — routes to the parent aggregation state
 * 2. Non-last substep with implicit aggregation — advances with iteration accumulation
 * 3. Non-last substep without aggregation — simple advance to next sibling substep
 *
 * @param stepName - The current step name
 * @param substepId - The current substep ID within the step
 * @param steps - The full array of runbook steps
 * @returns XState transition configuration
 */
function buildContinueTransition(
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
): RunbookTransitionObject {
  const currentStep = steps.find((s) => s.name === stepName);

  // Substeps: uniform routing regardless of parent type (FOR or non-FOR)
  if (substepId && currentStep && resolvedStepHasSubsteps(currentStep)) {
    const isLast = isLastSubstepOfStep(stepName, substepId, steps);
    if (isLast) {
      // Last substep: route to parent (iteration-level or final aggregation)
      return {
        target: formatStateId(stepName),
        actions: runbookSetup.assign({
          substepCompletedCount: ({ context }: { context: RunbookContext }) =>
            context.substepCompletedCount + 1,
          lastAction: makeDirectLastAction({ type: 'CONTINUE' as const }),
          lastMessage: undefined,
          completedSubstep: substepId,
          substep: undefined,
        }),
      };
    }
    // Non-last substep: advance to next sibling
    const target = routeThroughParentArtifactsIfNeeded(
      findNextStateId(stepName, substepId, steps),
      steps,
    );
    return {
      target,
      actions: runbookSetup.assign({
        substepCompletedCount: ({ context }: { context: RunbookContext }) =>
          context.substepCompletedCount + 1,
        lastAction: makeDirectLastAction({ type: 'CONTINUE' as const }),
        lastMessage: undefined,
        // Parent OUTPUTS only read this after a parent-exit transition. A later
        // completing substep must overwrite this sibling-routing value first.
        completedSubstep: substepId,
        substep: extractSubstepFromStateId(target),
      }),
    };
  }

  // Non-substep CONTINUE: advance to next step
  const target = routeThroughParentArtifactsIfNeeded(
    findNextStateId(stepName, substepId, steps),
    steps,
  );
  return {
    target,
    actions: runbookSetup.assign({
      lastAction: makeDirectLastAction({ type: 'CONTINUE' as const }),
      lastMessage: undefined,
      substep: extractSubstepFromStateId(target),
    }),
  };
}

/**
 * Build an XState transition for the GOTO action.
 *
 * Handles two paths:
 * 1. Target step has substeps (explicit FOR or implicit 1..1) — initializes
 *    FOR stack, iteration results, and retry counts
 * 2. Simple target — delegates to {@link buildSimpleGotoAssign} with
 *    intra-loop detection for context preservation
 *
 * @param target - The parsed GOTO target (step + optional substep + optional at)
 * @param stepName - The current step name (for self-goto detection)
 * @param substepId - The current substep ID (for self-goto detection)
 * @param steps - The full array of runbook steps
 * @returns XState transition configuration
 * @throws {Error} If the GOTO target step does not exist
 */
function buildGotoTransition(
  target: StepId,
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
): RunbookTransitionObject {
  const targetStep = target.step;

  // Named/numeric step target (both are strings now)
  const targetStepObj = steps.find((s) => s.name === targetStep);
  if (!targetStepObj) {
    throw new Error(`Compiler error: GOTO target step "${targetStep}" does not exist`);
  }

  // Do not set completedSubstep here: GOTO is routing, not completion.
  // External GOTO parent OUTPUTS receive the current substep explicitly; sibling
  // GOTO waits for the eventual completing substep to record completedSubstep.
  // Handle GOTO to step with substeps (explicit FOR or implicit 1..1)
  if (resolvedStepHasSubsteps(targetStepObj)) {
    const forClause = targetStepObj.kind === 'for' ? targetStepObj.forClause : { start: 1, end: 1 };
    const isImplicit = targetStepObj.kind !== 'for';
    // Target either the specified substep or default to first
    const resolvedSubstepId = target.substep ?? targetStepObj.substeps[0].id;
    const targetStateId = routeThroughParentArtifactsIfNeeded(
      formatStateId(targetStepObj.name, resolvedSubstepId),
      steps,
    );
    const isGotoToSelf = targetStepObj.name === stepName && resolvedSubstepId === substepId;
    return {
      target: targetStateId,
      actions: runbookSetup.assign({
        forStack: ({ context }: { context: RunbookContext }): readonly ForContext[] =>
          initForStack(context.forStack, targetStepObj.name, forClause, target.at, isImplicit),
        iterationResults: ({
          context,
        }: {
          context: RunbookContext;
        }): ('pass' | 'fail')[] | undefined =>
          initIterationResults(
            context.forStack,
            context.iterationResults,
            targetStepObj.name,
            !isImplicit || !!targetStepObj.aggregation,
          ),
        lastAction: makeDirectLastAction(buildGotoLastAction(target)),
        parentRetryCount:
          targetStepObj.name === stepName
            ? ({ context }: { context: RunbookContext }) => context.parentRetryCount
            : 0,
        retryCount: isGotoToSelf
          ? ({ context }: { context: RunbookContext }) => context.retryCount + 1
          : 0,
        retryMax: undefined,
        iterationRetryCount: 0,
        substep: resolvedSubstepId,
        substepCompletedCount: !isImplicit
          ? ({ context }: { context: RunbookContext }): number => {
              const top = peekForStack(context.forStack);
              if (top?.stepId === targetStepObj.name) return context.substepCompletedCount;
              return 0;
            }
          : 0,
        deferredResults: !isImplicit
          ? ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] | undefined => {
              const top = peekForStack(context.forStack);
              if (top?.stepId === targetStepObj.name) return context.deferredResults;
              return [];
            }
          : EMPTY_RESULTS,
      }),
    };
  }

  const resolvedSubstepId = target.substep;

  const computedTarget = routeThroughParentArtifactsIfNeeded(
    formatStateId(targetStepObj.name, resolvedSubstepId),
    steps,
  );
  const currentStateId = formatStateId(stepName, substepId);
  const isGotoToSelf = computedTarget === currentStateId;

  // Detect intra-loop GOTO: target is within same FOR step
  const currentStep = steps.find((s) => s.name === stepName);
  const isIntraLoopGoto = currentStep?.kind === 'for' && targetStepObj.name === stepName;

  return {
    target: computedTarget,
    actions: buildSimpleGotoAssign({
      lastAction: makeDirectLastAction(buildGotoLastAction(target)),
      resolvedSubstepId,
      isGotoToSelf,
      preserveForContext: isIntraLoopGoto,
      preserveParentRetryCount: isGotoToSelf || isIntraLoopGoto,
    }),
  };
}

/**
 * Normalize a single action or array of actions into a guaranteed array.
 *
 * @param actions - Single action, array of actions, or undefined
 * @returns Array form (empty if undefined)
 */
function toActionArray(actions: RunbookAction | RunbookAction[] | undefined): RunbookAction[] {
  if (!actions) return [];
  return Array.isArray(actions) ? actions : [actions];
}

/**
 * Prepend extra actions to a transition's existing actions list.
 *
 * Extra actions run BEFORE the transition's pre-existing actions so that
 * OUTPUTS evaluation observes the variable state captured at exit time
 * (not the post-assign state from later cleanup actions).
 *
 * @param transition - Transition to decorate (event or always entry)
 * @param extra - Actions to prepend
 * @returns A new transition with the extra actions prepended (or the original if extra is empty)
 */
function prependActions<T extends RunbookTransitionObject | (RunbookAlwaysEntry & object)>(
  transition: T,
  extra: readonly RunbookAction[],
): T {
  if (extra.length === 0) return transition;
  return {
    ...transition,
    actions: [...extra, ...toActionArray(transition.actions)],
  };
}

/**
 * Build XState transition config by dispatching on Action type
 * (CONTINUE, GOTO, NEXT, BREAK, COMPLETE, STOP).
 *
 * After building the base transition, decorates it with `storeStepOutputs`
 * actions for any OUTPUTS directives that must fire on this exit path:
 *
 * 1. The unit's own OUTPUTS (substep or step) when declared.
 * 2. The parent step's OUTPUTS when a substep's transition bypasses the parent
 *    aggregation state entirely (COMPLETE, STOP, or GOTO to a different step).
 *    In the normal CONTINUE/DEFER/BREAK/NEXT path the substep routes back to the
 *    parent state first, where `decorateParentTransition` injects parent OUTPUTS;
 *    for direct-to-terminal or direct-to-other-step transitions that path is
 *    unreachable, so parent OUTPUTS are injected here instead.
 *
 * Frontmatter OUTPUTS are NOT attached here: they are emitted exactly once from
 * the terminal states' `entry` actions (COMPLETE.entry / STOPPED.entry) under
 * the single-owner terminal-entry architecture.
 *
 * @param action - The action to build a transition for
 * @param stepName - The current step name
 * @param substepId - Optional current substep ID
 * @param steps - All parsed runbook steps
 * @param kind - Whether this transition is for 'pass' or 'fail'
 * @param evaluationOptions - Filesystem options threaded through to OUTPUTS evaluation
 * @returns XState transition configuration
 */
function buildActionTransition(
  action: Action,
  stepName: string,
  substepId: string | undefined,
  steps: readonly ResolvedStep[],
  kind: 'pass' | 'fail',
  evaluationOptions: EvaluateOutputOptions | undefined,
): TransitionConfig {
  const resultKind: 'pass' | 'fail' = kind === 'fail' ? 'fail' : 'pass';

  let transition: RunbookTransitionObject;
  switch (action.type) {
    case 'CONTINUE':
      transition = buildContinueTransition(stepName, substepId, steps);
      break;
    case 'DEFER':
      transition = buildDeferTransition(stepName, substepId, steps, resultKind);
      break;
    case 'COMPLETE':
      transition = buildTerminalTransition('COMPLETE', 'COMPLETE', action.message);
      break;
    case 'STOP':
      transition = buildTerminalTransition('STOPPED', 'STOP', action.message);
      break;
    case 'GOTO':
      transition = buildGotoTransition(action.target, stepName, substepId, steps);
      break;
    case 'NEXT':
      transition = buildLoopControlTransition('NEXT', stepName, substepId, steps);
      break;
    case 'BREAK':
      transition = buildLoopControlTransition('BREAK', stepName, substepId, steps);
      break;
  }

  const currentStep = steps.find((step) => step.name === stepName);
  const unitOutputs =
    substepId && currentStep && resolvedStepHasSubsteps(currentStep)
      ? (currentStep.substeps.find((substep) => substep.id === substepId)?.outputs ?? [])
      : (currentStep?.outputs ?? []);

  const extra: RunbookAction[] = [];
  if (unitOutputs.length > 0) {
    extra.push(
      actionRef(
        'storeStepOutputs',
        withEvaluationOptions(
          {
            outputs: unitOutputs,
            stepName,
            substepId,
          },
          evaluationOptions,
        ),
      ),
    );
  }

  // When a substep bypasses the parent aggregation state by transitioning directly
  // to a terminal state or a different step, the parent's `always` transitions never
  // run and `decorateParentTransition` is unreachable. Inject parent OUTPUTS here so
  // they fire regardless of which exit path the substep takes.
  if (substepId && currentStep && resolvedStepHasSubsteps(currentStep)) {
    const parentOutputs = currentStep.outputs;
    const target = typeof transition.target === 'string' ? transition.target : undefined;
    const exitsParent =
      target !== undefined &&
      target !== formatStateId(stepName) &&
      !target.startsWith(`${formatStateId(stepName)}::`);
    if (exitsParent && parentOutputs && parentOutputs.length > 0) {
      extra.push(
        actionRef(
          'storeStepOutputs',
          withEvaluationOptions(
            {
              outputs: parentOutputs,
              stepName,
              substepId,
            },
            evaluationOptions,
          ),
        ),
      );
    }
  }

  return prependActions(transition, extra);
}

/**
 * Extract all transition target strings from a state config.
 *
 * Walks `on`, `always`, and guarded transition arrays to collect every
 * `target` value referenced by the state.
 *
 * @param config - A {@link RunbookStateConfig} from the generated states record
 * @returns Array of target strings (may include duplicates)
 */
function extractTargets(config: RunbookStateConfig): string[] {
  const targets: string[] = [];

  const collectFromEntry = (entry: RunbookEventTransition | RunbookAlwaysEntry | string): void => {
    if (typeof entry === 'string') {
      // Skip relative descendant refs ('.' prefix) — resolved at runtime
      // against the current state, not the top-level states record.
      // Absolute ID refs ('#' prefix, e.g. '#STOPPED') ARE included so
      // validateGraph can check them after stripping the '#'.
      if (!entry.startsWith('.')) {
        targets.push(entry);
      }
      return;
    }
    if (entry && typeof entry === 'object' && 'target' in entry) {
      const { target: t } = entry;
      if (typeof t === 'string' && !t.startsWith('.')) {
        targets.push(t);
      }
    }
  };

  const collectFromTransitionConfig = (
    tc: RunbookEventTransition | readonly RunbookEventTransition[] | string | undefined,
  ): void => {
    if (tc === undefined) return;
    if (Array.isArray(tc)) {
      tc.forEach(collectFromEntry);
    } else {
      // RunbookEventTransition is a wide union that includes array members; cast to the non-array form.
      collectFromEntry(tc as RunbookEventTransition | string);
    }
  };

  if (config.on) {
    for (const tc of Object.values(config.on)) {
      collectFromTransitionConfig(tc);
    }
  }

  if (config.always) {
    const always = config.always as readonly RunbookAlwaysEntry[] | RunbookAlwaysEntry;
    if (Array.isArray(always)) {
      always.forEach(collectFromEntry);
    } else {
      // Same wide-union issue: cast to the non-array element form.
      collectFromEntry(always);
    }
  }

  // invoke.onDone / invoke.onError carry transition targets that must be
  // validated against the state set.
  if ('invoke' in config && config.invoke && typeof config.invoke === 'object') {
    const invoke = config.invoke as {
      onDone?: unknown;
      onError?: unknown;
    };
    if (invoke.onDone !== undefined) {
      collectFromTransitionConfig(
        invoke.onDone as Parameters<typeof collectFromTransitionConfig>[0],
      );
    }
    if (invoke.onError !== undefined) {
      collectFromTransitionConfig(
        invoke.onError as Parameters<typeof collectFromTransitionConfig>[0],
      );
    }
  }

  return targets;
}

function extractRelativeTargets(config: RunbookStateConfig): string[] {
  const targets: string[] = [];

  const collectFromTransitionConfig = (transition: unknown): void => {
    if (transition === undefined || transition === null) return;
    if (Array.isArray(transition)) {
      for (const entry of transition) {
        collectFromTransitionConfig(entry);
      }
      return;
    }
    if (typeof transition === 'string') {
      if (transition.startsWith('.')) targets.push(transition);
      return;
    }
    if (typeof transition === 'object' && 'target' in transition) {
      const { target } = transition;
      if (typeof target === 'string' && target.startsWith('.')) targets.push(target);
    }
  };

  if (config.on) {
    for (const transitions of Object.values(config.on)) {
      collectFromTransitionConfig(transitions);
    }
  }
  collectFromTransitionConfig(config.always);
  if ('invoke' in config && config.invoke && typeof config.invoke === 'object') {
    const invoke = config.invoke as {
      onDone?: unknown;
      onError?: unknown;
    };
    collectFromTransitionConfig(invoke.onDone);
    collectFromTransitionConfig(invoke.onError);
  }

  return targets;
}

/**
 * Validate the generated state graph for structural integrity.
 *
 * Checks that cannot be performed at compile time because state IDs and
 * transition targets are dynamically computed strings:
 * 1. Initial state exists in the generated set
 * 2. All transition targets reference existing states or terminal states
 * 3. Nested leaf substates are known compiler-owned substates
 * 4. Every side-effect child has the pending-effect tag
 * 5. Every side-effect child has `onError.target` equal to `captureErrorTarget`
 * 6. Every side-effect child `onDone.target` references a sibling child state
 *
 * @param states - The generated states record
 * @param initialState - The computed initial state ID
 * @param terminalStates - Set of terminal state IDs (COMPLETE, STOPPED)
 * @param captureErrorTarget - Expected `onError.target` for every side-effect child (e.g. `'#STOPPED'`)
 * @throws {Error} If any structural invariant is violated
 */
function validateGraph(
  states: Record<string, RunbookStateConfig>,
  initialState: string,
  terminalStates: Set<string>,
  captureErrorTarget: string,
): void {
  const stateIds = new Set([...Object.keys(states), ...terminalStates]);
  const generatedStateIds = new Set(Object.keys(states));

  if (!stateIds.has(initialState)) {
    throw new Error(`Compiler error: initial state "${initialState}" not in generated states`);
  }

  // Invariant: top-level parent-entry states are transient machine-owned
  // ARTIFACTS resolvers. They must behave like pending side-effect states and
  // route only to fail-closed terminal handling or a generated successor.
  for (const [stateId, config] of Object.entries(states)) {
    if (!stateId.includes('::__parent-entry::')) continue;

    const tags = graphTags(config as unknown as Record<string, unknown>);
    if (!tags.includes(PENDING_MACHINE_EFFECT_TAG)) {
      throw new Error(
        `Compiler invariant: parent-entry state "${stateId}" must include ` +
          `"${PENDING_MACHINE_EFFECT_TAG}" tag`,
      );
    }

    const graphConfig = config as unknown as Record<string, unknown>;
    if (!isGraphRecord(graphConfig.invoke)) {
      throw new Error(`Compiler invariant: parent-entry state "${stateId}.invoke" must be defined`);
    }

    const errorTargets = graphTransitionTargets(graphConfig.invoke.onError);
    if (errorTargets.length !== 1 || errorTargets[0] !== captureErrorTarget) {
      throw new Error(
        `Compiler invariant: parent-entry state "${stateId}.onError.target" must be ` +
          `"${captureErrorTarget}", got "${errorTargets.join(', ') || 'undefined'}"`,
      );
    }

    const successTargets = graphTransitionTargets(graphConfig.invoke.onDone);
    if (successTargets.length !== 1) {
      throw new Error(
        `Compiler invariant: parent-entry state "${stateId}.onDone.target" must reference ` +
          `an existing generated state, got "${successTargets.join(', ') || 'undefined'}"`,
      );
    }

    const successTarget = successTargets[0];
    const successLookupTarget = successTarget.startsWith('#')
      ? successTarget.slice(1)
      : successTarget;
    if (!generatedStateIds.has(successLookupTarget)) {
      throw new Error(
        `Compiler invariant: parent-entry state "${stateId}.onDone.target" must reference ` +
          `an existing generated state, got "${successTargets.join(', ') || 'undefined'}"`,
      );
    }
  }

  for (const [sourceId, config] of Object.entries(states)) {
    for (const target of extractTargets(config)) {
      // Absolute XState ID refs like '#STOPPED' resolve to the bare name.
      const lookupTarget = target.startsWith('#') ? target.slice(1) : target;
      if (!stateIds.has(lookupTarget)) {
        throw new Error(
          `Compiler error: unknown target "${target}" referenced from state "${sourceId}"`,
        );
      }
    }
    for (const target of extractRelativeTargets(config)) {
      const childTarget = target.slice(1);
      const childStates = config.states as Record<string, unknown> | undefined;
      if (!childStates || !(childTarget in childStates)) {
        throw new Error(
          `Compiler error: unknown relative target "${target}" referenced from state "${sourceId}"`,
        );
      }
    }
  }

  // Invariant: every nested side-effect child is a known compiler-owned leaf
  // substate, carries the pending-effect tag, routes errors to the terminal
  // STOPPED state, and only targets sibling child states on successful invoke
  // completion.
  for (const [stateId, config] of Object.entries(states)) {
    const childStates = isGraphRecord(config.states) ? config.states : undefined;
    if (!childStates) continue;

    for (const [childName, child] of Object.entries(childStates)) {
      if (!LEAF_SUBSTATE_SET.has(childName)) {
        throw new Error(
          `Compiler invariant: "${stateId}" has unknown leaf substate "${childName}"`,
        );
      }
      if (!isSideEffectLeafSubstate(childName)) continue;

      if (!isGraphRecord(child)) {
        throw new Error(`Compiler invariant: "${stateId}.${childName}" must be an object`);
      }

      const tags = graphTags(child);
      if (!tags.includes(PENDING_MACHINE_EFFECT_TAG)) {
        throw new Error(
          `Compiler invariant: "${stateId}.${childName}" must include "${PENDING_MACHINE_EFFECT_TAG}" tag`,
        );
      }

      if (!isGraphRecord(child.invoke)) {
        throw new Error(`Compiler invariant: "${stateId}.${childName}.invoke" must be defined`);
      }

      const errorTargets = graphTransitionTargets(child.invoke.onError);
      if (errorTargets.length !== 1 || errorTargets[0] !== captureErrorTarget) {
        throw new Error(
          `Compiler invariant: "${stateId}.${childName}.onError.target" must be ` +
            `"${captureErrorTarget}", got "${errorTargets.join(', ') || 'undefined'}"`,
        );
      }

      for (const target of graphTransitionTargets(child.invoke.onDone)) {
        if (target.startsWith('#')) {
          // Current absolute machine targets in scope: #STOPPED, #iteration_exhausted.
          const lookupTarget = target.slice(1);
          if (!stateIds.has(lookupTarget)) {
            throw new Error(
              `Compiler invariant: "${stateId}.${childName}.onDone.target" references ` +
                `unknown absolute target "${target}"`,
            );
          }
          continue;
        }
        const childTarget = target.startsWith('.') ? target.slice(1) : target;
        if (!(childTarget in childStates)) {
          throw new Error(
            `Compiler invariant: "${stateId}.${childName}.onDone.target" references ` +
              `unknown child "${target}"`,
          );
        }
      }
    }
  }
}

function isGraphRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSideEffectLeafSubstate(
  value: string,
): value is
  | '__capture'
  | '__execute-command'
  | '__resolve-artifacts'
  | '__resolve-iteration'
  | '__issue-delegations'
  | '__prepare-inline-launch' {
  return (
    value === '__capture' ||
    value === '__execute-command' ||
    value === '__resolve-artifacts' ||
    value === '__resolve-iteration' ||
    value === '__issue-delegations' ||
    value === '__prepare-inline-launch'
  );
}

function graphTags(config: Record<string, unknown>): readonly unknown[] {
  const tags = config.tags;
  if (Array.isArray(tags)) return tags;
  return tags === undefined ? [] : [tags];
}

function graphTransitionTargets(transition: unknown): string[] {
  if (Array.isArray(transition)) {
    return transition.flatMap((entry) => graphTransitionTargets(entry));
  }
  if (typeof transition === 'string') return [transition];
  if (isGraphRecord(transition) && typeof transition.target === 'string') {
    return [transition.target];
  }
  return [];
}

/** Test hook for generated graph structural validation. */
export const validateGraphForTest = validateGraph;

/**
 * Insert a state config into the states record, throwing on duplicate IDs.
 *
 * @param states - The mutable states record
 * @param id - The state ID to insert
 * @param config - The state configuration
 * @throws {Error} If a state with the given ID already exists
 */
function checkedStateInsert(
  states: Record<string, RunbookStateConfig>,
  id: string,
  config: RunbookStateConfig,
): void {
  if (id in states) {
    throw new Error(`Compiler error: duplicate state ID "${id}"`);
  }
  states[id] = config;
}

/**
 * Compile runbook steps into an XState state machine.
 *
 * Generates a finite state machine from the runbook definition with:
 * - One state per step (or substep if the step has substeps)
 * - PASS/FAIL/RETRY/GOTO transitions based on step transitions
 * - COMPLETE and STOPPED final states
 *
 * @param steps - The parsed runbook steps to compile
 * @param options - Optional compilation inputs
 * @param options.templateVars - Seeded template variables for OUTPUTS evaluation
 * @param options.sourceTemplateVars - Full seeded template variables for machine-owned FOR source resolution.
 * @param options.initialVariables - Seeded runtime variables for persisted OUTPUTS and ARTIFACTS values.
 * @param options.evaluationOptions - Filesystem options used by artifact-producing OUTPUTS helpers.
 *   If omitted, artifact-producing helpers fail closed instead of writing under `process.cwd()`.
 * @param options.frontmatterOutputs - Frontmatter `outputs:` declarations. Callers that pass a
 *   value loaded from persisted {@link RunbookState} must validate that the field is not `undefined`
 *   before calling (stale run states pre-dating the OUTPUTS feature will have it absent); the
 *   {@link RunbookActorService} enforces this guard. Direct callers from tests or CLI inspection
 *   that omit the option receive an empty array default.
 * @param options.helpers - Template helpers available to machine-owned OUTPUTS evaluation.
 * @param options.substepStates - Seeds `RunbookContext.substepStates` at machine bootstrap. Used
 *   by the actor service to hydrate substep delegation state from persisted state in a single
 *   `createActor` call.
 * @param options.parentLinkage - Seeds parent linkage data for machine-owned delegation issuance.
 * @param options.resolveDelegationRunbook - Runtime resolver for machine-owned delegation issuance.
 * @param options.resolveInlineRunbook - Runtime resolver for machine-owned inline launch intent preparation.
 * @param options.generateChildRunId - Runtime ID generator for machine-owned child run launches.
 * @param options.now - Runtime clock for machine-owned timestamps.
 * @param options.commandServices - Runtime callables for machine-owned command execution.
 * @param options.executionObserver - Non-persisted observer for command actor output and failures.
 * @returns An XState state machine definition
 * @throws {Error} When a GOTO target references a non-existent step or when graph invariants are violated (e.g., duplicate state IDs)
 */
// Return type validated via `satisfies RunbookMachine` at the return site.
// Explicit annotation would erase XState's inferred event types, breaking actor.send() downstream.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type, @typescript-eslint/explicit-module-boundary-types
export function compileRunbookToMachine(
  steps: readonly ResolvedStep[],
  options?: {
    templateVars?: FlattenedTemplateVars;
    sourceTemplateVars?: InitialTemplateVars;
    initialVariables?: Readonly<Record<string, VariableValue>>;
    frontmatterOutputs?: readonly OutputDeclaration[];
    evaluationOptions?: EvaluateOutputOptions;
    helpers?: TemplateHelperRegistry;
    substepStates?: readonly SubstepState[];
    parentLinkage?: ParentLinkage;
    resolveDelegationRunbook?: ResolveDelegationRunbook;
    resolveInlineRunbook?: ResolveInlineRunbook;
    generateChildRunId?: () => RunId;
    now?: () => string;
    commandServices?: CommandExecutionServices;
    executionObserver?: MachineExecutionObserver;
  },
) {
  const evaluationOptions = options?.evaluationOptions
    ? { ...options.evaluationOptions, helpers: options.helpers }
    : undefined;
  const sourceTemplateVars =
    options?.sourceTemplateVars ?? sourceTemplateVarsFromFlattened(options?.templateVars);
  // Pass through evaluationOptions.cwd as-is; file-backed FOR sources
  // (JsonArrayStream) fail closed inside resolveFromJsonArrayStream when cwd
  // is missing, while in-memory JsonArray sources need no cwd at all.
  const sourceResolutionCwd = evaluationOptions?.cwd;
  const states: Record<string, RunbookStateConfig> = {};
  const clearCurrentEntryArtifacts = runbookSetup.assign({
    enteredArtifacts: () => undefined,
  });
  const artifactFailureTransition = {
    target: STOPPED_STATE_REF,
    actions: {
      type: 'setArtifactResolutionFailed' as const,
      params: ({ event }: { event: { error: unknown } }) => ({
        message: getErrorMessage(event.error),
      }),
    },
  };
  const forResolutionFailureTransition = {
    target: STOPPED_STATE_REF,
    actions: {
      type: 'setForResolutionFailed' as const,
      params: ({ event }: { event: { error: unknown } }) => {
        const err = event.error;
        const code: ForResolutionFailureCode =
          err instanceof ForResolutionError ? err.code : 'parse-failure';
        return { code, message: getErrorMessage(err) };
      },
    },
  };
  const buildArtifactResolveInvokeBlock = (
    declarations: readonly ArtifactDeclaration[],
    stepName: string,
    substepId: string | undefined,
    target: string,
  ): NonNullable<RunbookStateConfig['invoke']> => ({
    src: 'artifactResolveActor' as const,
    input: ({ context }: { context: RunbookContext }) =>
      buildArtifactResolveInput(declarations, stepName, substepId, context, evaluationOptions),
    onDone: {
      target,
      actions: {
        type: 'storeResolvedArtifacts' as const,
        params: ({
          event,
        }: {
          // Track the actor's declared Output exactly so provenance survives
          // the event.output boundary in the type system.
          event: { output: { variables: Record<string, TrustedArtifactValue> } };
        }) => ({
          variables: event.output.variables,
        }),
      },
    },
    onError: artifactFailureTransition,
  });
  const buildForIterateInvokeBlock = (
    readyTarget: string,
  ): NonNullable<RunbookStateConfig['invoke']> => ({
    src: 'forIterateActor' as const,
    input: ({ context }: { context: RunbookContext }) => {
      const top = context.forStack.at(-1);
      if (!top) {
        throw new Error('forIterateActor invoked with empty forStack');
      }
      // Merge the seeded sourceTemplateVars (preserves JsonArrayStream refs
      // from CLI/init) with the runtime context.variables accumulator
      // (step OUTPUTS and ARTIFACTS resolutions). Mirrors the precedence
      // used by {{ var }} expansion so FOR sources can iterate
      // runtime-captured arrays as well as seeded ones.
      return {
        forContext: top,
        templateVars: mergeEffectiveVars({
          templateVars: sourceTemplateVars,
          variables: context.variables,
        }),
        cwd: sourceResolutionCwd,
      };
    },
    onDone: [
      {
        guard: ({ event }: { event: { output: ForIterateOutput } }) =>
          event.output.kind === 'ready',
        target: readyTarget,
        actions: {
          type: 'storeReadyIteration' as const,
          params: ({ event }: { event: { output: ForIterateOutput } }) => ({
            output: event.output,
          }),
        },
      },
      {
        guard: ({ event }: { event: { output: ForIterateOutput } }) =>
          event.output.kind === 'exhausted',
        target: ITERATION_EXHAUSTED_STATE_REF,
        actions: {
          type: 'storeExhaustedIteration' as const,
          params: ({ event }: { event: { output: ForIterateOutput } }) => ({
            output: event.output,
          }),
        },
      },
    ],
    onError: forResolutionFailureTransition,
  });
  const buildDelegationIssueInvokeBlock = (
    stepName: string,
    substepId: string | undefined,
  ): NonNullable<RunbookStateConfig['invoke']> => ({
    src: 'delegationIssueActor' as const,
    input: ({ context }: { context: RunbookContext }) => {
      const activeFor = peekForStack(context.forStack);
      const frameKey = buildFrameKey(
        stepName,
        activeFor && !activeFor.implicit ? activeFor.iteration : undefined,
      );
      const runIdValue = context.templateVars.RunId;
      return {
        state: {
          id: assertRunId(typeof runIdValue === 'string' ? runIdValue : ''),
          step: stepName,
          ...(substepId ? { substep: substepId } : {}),
          substepStates: context.substepStates,
          activeFrameKey: frameKey,
          parentLinkage: context.parentLinkage,
          templateVars: brandInitialTemplateVars(asTemplateVars(context.templateVars)),
          variables: context.variables,
          forStack: context.forStack,
        },
        steps,
        frameKey,
        resolveRunbook: options?.resolveDelegationRunbook ?? (() => Promise.resolve(null)),
      };
    },
    onDone: [
      {
        guard: ({ event }: { event: { output: DelegationIssueOutput } }) =>
          event.output.status === 'issued',
        target: 'idle',
        actions: {
          type: 'storeDelegateFrontier' as const,
          params: ({ event }: { event: { output: DelegationIssueOutput } }) => {
            if (event.output.status !== 'issued') {
              return { frontier: undefined, substepStates: [] };
            }
            return {
              frontier: event.output.frontier,
              substepStates: event.output.substepStates,
            };
          },
        },
      },
      {
        guard: ({ event }: { event: { output: DelegationIssueOutput } }) =>
          event.output.status === 'skipped',
        target: 'idle',
      },
      {
        target: STOPPED_STATE_REF,
        actions: {
          type: 'setDelegationIssuanceFailed' as const,
          params: ({ event }: { event: { output: DelegationIssueOutput } }) => {
            if (event.output.status === 'failed') {
              return { reason: event.output.reason, message: event.output.message };
            }
            return {
              reason: 'delegation_resolution_failed' as const,
              message: 'Delegation issuance failed',
            };
          },
        },
      },
    ],
    onError: {
      target: STOPPED_STATE_REF,
      actions: {
        type: 'setDelegationIssuanceFailed' as const,
        params: ({ event }: { event: { error: unknown } }) => ({
          reason: 'delegation_resolution_failed' as const,
          message: getErrorMessage(event.error),
        }),
      },
    },
  });
  const buildInlineLaunchInvokeBlock = (
    stepName: string,
    substepId: string | undefined,
  ): NonNullable<RunbookStateConfig['invoke']> => ({
    src: 'inlineLaunchIntentActor' as const,
    input: ({ context }: { context: RunbookContext }) => {
      if (!substepId) {
        throw new Error('inlineLaunchIntentActor invoked without substep id');
      }
      const activeFor = peekForStack(context.forStack);
      const frameKey = buildFrameKey(
        stepName,
        activeFor && !activeFor.implicit ? activeFor.iteration : undefined,
      );
      const runIdValue = context.templateVars.RunId;
      return {
        state: {
          id: assertRunId(typeof runIdValue === 'string' ? runIdValue : ''),
          step: stepName,
          substep: substepId,
          substepStates: context.substepStates,
          activeFrameKey: frameKey,
          parentLinkage: context.parentLinkage,
          templateVars: brandInitialTemplateVars(asTemplateVars(context.templateVars)),
          variables: context.variables,
          forStack: context.forStack,
        },
        steps,
        substepId,
        frameKey,
        resolveRunbook:
          options?.resolveInlineRunbook ??
          (() => {
            throw new Error('Inline child runbook resolver is not configured');
          }),
        generateChildRunId: options?.generateChildRunId ?? generateRunId,
        now: options?.now ?? (() => new Date().toISOString()),
      };
    },
    onDone: [
      {
        guard: ({ event }: { event: { output: InlineLaunchIntentOutput } }) =>
          event.output.status === 'prepared',
        target: 'idle',
        actions: {
          type: 'storeInlineLaunchIntent' as const,
          params: ({ event }: { event: { output: InlineLaunchIntentOutput } }) => {
            if (event.output.status !== 'prepared') {
              throw new Error('Expected prepared inline launch output');
            }
            return {
              intent: event.output.intent,
              substepStates: event.output.substepStates,
            };
          },
        },
      },
      {
        guard: ({ event }: { event: { output: InlineLaunchIntentOutput } }) =>
          event.output.status === 'skipped',
        target: 'idle',
      },
      {
        guard: ({ event }: { event: { output: InlineLaunchIntentOutput } }) =>
          event.output.status === 'failed',
        target: STOPPED_STATE_REF,
        actions: {
          type: 'setInlineLaunchFailed' as const,
          params: ({ event }: { event: { output: InlineLaunchIntentOutput } }) => {
            if (event.output.status !== 'failed') {
              return {
                reason: 'inline_launch_failed' as const,
                message: 'Inline launch preparation failed',
              };
            }
            return {
              reason: event.output.reason,
              message: event.output.message,
            };
          },
        },
      },
    ],
    onError: {
      target: STOPPED_STATE_REF,
      actions: {
        type: 'setInlineLaunchFailed' as const,
        params: ({ event }: { event: { error: unknown } }) => ({
          reason: 'inline_launch_failed' as const,
          message: getErrorMessage(event.error),
        }),
      },
    },
  });

  // Build a flat list of all states to generate GOTO transitions
  const allStates: StateConfig[] = [];

  steps.forEach((step) => {
    const stepName = step.name;
    if (resolvedStepHasSubsteps(step)) {
      step.substeps.forEach((substep) => {
        allStates.push({
          id: formatStateId(stepName, substep.id),
          stepName,
          substepId: substep.id,
          transitions: substep.transitions, // always concrete — parser filled in defaults
          artifacts: substep.artifacts,
        });
      });
      // Parent aggregation state
      allStates.push({
        id: formatStateId(stepName),
        stepName,
        transitions: step.transitions,
        isParentState: true,
        parentStep: step,
      });
    } else {
      allStates.push({
        id: formatStateId(stepName),
        stepName,
        transitions: step.transitions,
        artifacts: step.artifacts,
      });
    }
  });

  // Pre-filter GOTO targets once (skip parent states — they are transient)
  const gotoTargets = allStates.filter((t) => !t.isParentState);

  for (const step of steps) {
    if (!resolvedStepHasSubsteps(step) || !step.artifacts?.length) {
      continue;
    }
    for (const substep of step.substeps) {
      checkedStateInsert(
        states,
        parentEntryStateId(step.name, substep.id),
        runbookSetup.createStateConfig({
          entry: clearCurrentEntryArtifacts,
          tags: [PENDING_MACHINE_EFFECT_TAG],
          invoke: buildArtifactResolveInvokeBlock(
            step.artifacts,
            step.name,
            substep.id,
            formatStateId(step.name, substep.id),
          ),
        }),
      );
    }
  }

  /**
   * Build the {@link RunbookStateConfig} for a single non-parent leaf state.
   *
   * Extracted from the inline `allStates.forEach` body to keep the outer
   * compile entry readable. Closes over the surrounding scope
   * (`gotoTargets`, `allStates`, `steps`, `evaluationOptions`, and the
   * per-machine helpers above) so behaviour is preserved verbatim — the
   * structural snapshot test pins this.
   *
   * @param config - The {@link ChildStateConfig} describing the leaf
   * @returns The {@link RunbookStateConfig} to feed into `checkedStateInsert`
   */
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  function buildLeafSubstateConfig(config: ChildStateConfig) {
    // Extract retryMax from transitions (check both PASS and FAIL)
    const retryMaxFromTransitions =
      config.transitions.pass.retry > 0
        ? config.transitions.pass.retry
        : config.transitions.fail.retry > 0
          ? config.transitions.fail.retry
          : 0;

    // Check if this state is the first substep of a FOR step
    // If so, add entry action to initialize FOR context
    const stepInfo = getStepForFirstSubstep(config.id, steps);
    const entryActions = stepInfo
      ? {
          entry: runbookSetup.assign({
            forStack: ({ context }: { context: RunbookContext }): readonly ForContext[] =>
              initForStack(
                context.forStack,
                stepInfo.step.name,
                stepInfo.forClause,
                undefined,
                stepInfo.implicit,
              ),
            iterationResults: ({
              context,
            }: {
              context: RunbookContext;
            }): ('pass' | 'fail')[] | undefined =>
              initIterationResults(
                context.forStack,
                context.iterationResults,
                stepInfo.step.name,
                !stepInfo.implicit || !!stepInfo.step.aggregation,
              ),
            // Reset substep tracking at start of iteration (FOR) or on first entry (non-FOR)
            substepCompletedCount: !stepInfo.implicit
              ? ({ context }: { context: RunbookContext }): number => {
                  // Preserve if re-entering same FOR step (intra-loop GOTO)
                  const top = peekForStack(context.forStack);
                  if (top?.stepId === stepInfo.step.name) return context.substepCompletedCount;
                  return 0;
                }
              : 0,
            deferredResults: !stepInfo.implicit
              ? ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] | undefined => {
                  // Preserve if re-entering same FOR step (intra-loop GOTO)
                  const top = peekForStack(context.forStack);
                  if (top?.stepId === stepInfo.step.name) return context.deferredResults;
                  return [];
                }
              : EMPTY_RESULTS,
            // Ensure substep is set so advance guards can use it
            substep: ({ context }: { context: RunbookContext }): string | undefined =>
              context.substep ?? config.substepId,
          }),
        }
      : {};
    const artifactDeclarations = config.artifacts ?? [];
    const hasArtifactDeclarations = artifactDeclarations.length > 0;
    const shouldIssueDelegations = leafIssuesDelegations(config.stepName, config.substepId, steps);
    const shouldPrepareInlineLaunch = leafPreparesInlineLaunch(
      config.stepName,
      config.substepId,
      steps,
    );
    const hasParentArtifactDeclarations =
      config.substepId !== undefined &&
      steps.some(
        (step) =>
          step.name === config.stepName &&
          resolvedStepHasSubsteps(step) &&
          !!step.artifacts?.length,
      );
    const shouldClearLeafEntryArtifacts = !hasParentArtifactDeclarations;
    const currentEntryActions =
      'entry' in entryActions && entryActions.entry !== undefined
        ? Array.isArray(entryActions.entry)
          ? entryActions.entry
          : [entryActions.entry]
        : [];
    const leafEntryActions = [
      ...currentEntryActions,
      ...(shouldClearLeafEntryArtifacts ? [clearCurrentEntryArtifacts] : []),
    ];
    const owningStep = steps.find((step) => step.name === config.stepName);
    const needsIteration = owningStep !== undefined && leafNeedsIterationResolution(owningStep);
    const afterArtifactsTarget = shouldIssueDelegations
      ? '__issue-delegations'
      : shouldPrepareInlineLaunch
        ? '__prepare-inline-launch'
        : 'idle';
    const artifactResolveInvokeBlock = buildArtifactResolveInvokeBlock(
      artifactDeclarations,
      config.stepName,
      config.substepId,
      afterArtifactsTarget,
    );
    const initialSubstate = needsIteration
      ? '__resolve-iteration'
      : hasArtifactDeclarations
        ? '__resolve-artifacts'
        : afterArtifactsTarget;
    const iterationReadyTarget = hasArtifactDeclarations
      ? '__resolve-artifacts'
      : afterArtifactsTarget;
    const applyCurrentResolvedCompletionTransitions = [
      {
        guard: ({ event }: { event: RunbookEvent }) => {
          assertEvent(event, 'APPLY_CURRENT_RESOLVED_COMPLETION');
          return event.completion.result === 'pass';
        },
        actions: [
          runbookSetup.assign({
            variables: ({ context, event }) => {
              assertEvent(event, 'APPLY_CURRENT_RESOLVED_COMPLETION');
              return { ...context.variables, ...(event.completion.finalVars ?? {}) };
            },
          }),
          { type: 'raisePass' as const },
        ],
      },
      {
        actions: [
          runbookSetup.assign({
            variables: ({ context, event }) => {
              assertEvent(event, 'APPLY_CURRENT_RESOLVED_COMPLETION');
              return { ...context.variables, ...(event.completion.finalVars ?? {}) };
            },
          }),
          { type: 'raiseFail' as const },
        ],
      },
    ];

    // Build per-state GOTO transitions
    const buildGotoTransitionsForState = gotoTargets.map((target) => {
      // Compute isGotoToSelf at build time since target and config are known
      const isGotoToSelf = target.id === config.id;

      // Check if this target is ANY substep of a FOR step (widened from first-only)
      const forStepForTarget = getStepForSubstep(target.id, steps);
      const routedTarget = routeThroughParentArtifactsIfNeeded(target.id, steps);

      return {
        guard: ({ event }: { event: RunbookEvent }) => {
          if (event.type !== 'GOTO') return false;

          const targetStep = event.target.step;

          // If target is just a step name, it matches the first state of that step
          if (!event.target.substep) {
            // Find first state for this step
            const firstStateForStep = allStates.find((s) => s.stepName === targetStep);
            return target.id === firstStateForStep?.id;
          }

          // Exact match for step and substep
          return targetStep === target.stepName && event.target.substep === target.substepId;
        },
        target: routedTarget,
        actions: forStepForTarget
          ? runbookSetup.assign({
              forStack: ({
                context,
                event,
              }: {
                context: RunbookContext;
                event: RunbookEvent;
              }): readonly ForContext[] => {
                if (event.type !== 'GOTO') return [];
                return initForStack(
                  context.forStack,
                  forStepForTarget.step.name,
                  forStepForTarget.forClause,
                  event.target.at,
                  forStepForTarget.implicit,
                );
              },
              iterationResults: ({
                context,
              }: {
                context: RunbookContext;
              }): ('pass' | 'fail')[] | undefined =>
                initIterationResults(
                  context.forStack,
                  context.iterationResults,
                  forStepForTarget.step.name,
                  !forStepForTarget.implicit || !!forStepForTarget.step.aggregation,
                ),
              lastAction: buildGotoLastActionFromEvent(target.substepId),
              parentRetryCount:
                target.stepName === config.stepName
                  ? ({ context }: { context: RunbookContext }) => context.parentRetryCount
                  : 0,
              retryCount: isGotoToSelf
                ? ({ context }: { context: RunbookContext }) => context.retryCount + 1
                : 0,
              retryMax: undefined,
              iterationRetryCount: 0,
              substep: ({ event }: { event: RunbookEvent }) =>
                event.type === 'GOTO' ? (event.target.substep ?? target.substepId) : undefined,
              substepCompletedCount: !forStepForTarget.implicit
                ? ({ context }: { context: RunbookContext }): number => {
                    const top = peekForStack(context.forStack);
                    if (top?.stepId === forStepForTarget.step.name)
                      return context.substepCompletedCount;
                    return 0;
                  }
                : 0,
              deferredResults: !forStepForTarget.implicit
                ? ({ context }: { context: RunbookContext }): ('pass' | 'fail')[] | undefined => {
                    const top = peekForStack(context.forStack);
                    if (top?.stepId === forStepForTarget.step.name) return context.deferredResults;
                    return [];
                  }
                : EMPTY_RESULTS,
            })
          : buildSimpleGotoAssign({
              lastAction: buildGotoLastActionFromEvent(target.substepId),
              resolvedSubstepId: ({ event }: { event: RunbookEvent }) =>
                event.type === 'GOTO' ? (event.target.substep ?? target.substepId) : undefined,
              isGotoToSelf,
              preserveParentRetryCount: isGotoToSelf,
            }),
      };
    });

    return runbookSetup.createStateConfig({
      id: config.id,
      ...(leafEntryActions.length > 0 ? { entry: leafEntryActions } : {}),
      initial: initialSubstate,
      on: {
        PASS: buildTransition(
          config.transitions.pass,
          config.id,
          config.stepName,
          config.substepId,
          steps,
          evaluationOptions,
        ),
        FAIL: buildTransition(
          config.transitions.fail,
          config.id,
          config.stepName,
          config.substepId,
          steps,
          evaluationOptions,
        ),
        RETRY: {
          actions: runbookSetup.assign({
            lastAction: makeDirectLastAction({ type: 'RETRY' as const }),
            lastMessage: undefined,
            retryCount: ({ context }) => context.retryCount + 1,
            retryMax: retryMaxFromTransitions,
          }),
          target: routeThroughParentArtifactsIfNeeded(config.id, steps),
        },
        GOTO: buildGotoTransitionsForState,
      } as NonNullable<RunbookStateConfig['on']>,
      states: {
        ...(needsIteration
          ? {
              '__resolve-iteration': {
                tags: [PENDING_MACHINE_EFFECT_TAG],
                invoke: buildForIterateInvokeBlock(iterationReadyTarget),
              },
            }
          : {}),
        ...(hasArtifactDeclarations
          ? {
              '__resolve-artifacts': {
                tags: [PENDING_MACHINE_EFFECT_TAG],
                invoke: artifactResolveInvokeBlock,
              },
            }
          : {}),
        ...(shouldIssueDelegations
          ? {
              '__issue-delegations': {
                tags: [PENDING_MACHINE_EFFECT_TAG],
                invoke: buildDelegationIssueInvokeBlock(config.stepName, config.substepId),
              },
            }
          : {}),
        ...(shouldPrepareInlineLaunch
          ? {
              '__prepare-inline-launch': {
                tags: [PENDING_MACHINE_EFFECT_TAG],
                invoke: buildInlineLaunchInvokeBlock(config.stepName, config.substepId),
              },
            }
          : {}),
        idle: {
          on: {
            // Single unguarded transition. The result discriminant rides through
            // the actor's typed input/output (Task 1) — no context field, no
            // routing guard.
            COMMAND_RESULT: {
              target: `#${config.id}.__capture`,
            },
            EXECUTE_COMMAND: {
              target: `#${config.id}.__execute-command`,
            },
            APPLY_CURRENT_RESOLVED_COMPLETION: applyCurrentResolvedCompletionTransitions,
          },
        },
        '__execute-command': {
          tags: [PENDING_MACHINE_EFFECT_TAG],
          invoke: {
            src: 'commandExecActor',
            input: ({ event, context }) => {
              assertEvent(event, 'EXECUTE_COMMAND');
              return buildCommandExecutionInput(
                event,
                context,
                evaluationOptions,
                options?.commandServices,
              );
            },
            onDone: [
              {
                guard: ({ event }) => event.output.kind === 'policy_denied',
                target: STOPPED_STATE_REF,
                actions: [
                  ({ event }) => {
                    options?.executionObserver?.recordCommandOutput(event.output);
                  },
                  {
                    type: 'setPolicyDenied',
                    params: ({ event }) => ({
                      message:
                        event.output.kind === 'policy_denied'
                          ? event.output.denialReason
                          : 'Permission denied',
                    }),
                  },
                ],
              },
              {
                guard: ({ event }) => isCommandCompletedOutput(event.output),
                target: 'idle',
                actions: [
                  ({ event }) => {
                    options?.executionObserver?.recordCommandOutput(event.output);
                  },
                  raiseEvent(({ event }) => {
                    if (!isCommandCompletedOutput(event.output)) {
                      throw new Error('Expected completed command output');
                    }
                    return {
                      type: 'COMMAND_RESULT' as const,
                      result: event.output.result,
                      channels: event.output.channels,
                    };
                  }),
                ],
              },
            ],
            onError: {
              target: STOPPED_STATE_REF,
              actions: [
                ({ event }) => {
                  options?.executionObserver?.recordCommandFailure(getErrorMessage(event.error));
                },
                {
                  type: 'setCommandExecutionFailed',
                  params: ({ event }) => ({
                    message: getErrorMessage(event.error),
                  }),
                },
              ],
            },
          },
        },
        // `__capture` invokes `outputCaptureActor` to read naked OUTPUT
        // channel files for the current leaf. The actor contract is that
        // it ALWAYS resolves under normal filesystem conditions — per-
        // channel failures (missing file, empty file, non-UTF-8) are
        // logged and silently omitted from the result. `onError` therefore
        // exists as a fail-closed branch for CATASTROPHIC I/O failures
        // only (OOM, hard OS-level errors). See the contract documented
        // on `outputCaptureActor` in `actors/output-capture-actor.ts`:
        // if that contract weakens to per-channel rejection, this
        // `onError` will route benign missing channels to `#STOPPED` and
        // tear the runbook down.
        __capture: {
          tags: [PENDING_MACHINE_EFFECT_TAG],
          invoke: {
            src: 'outputCaptureActor',
            input: ({ event }) => {
              assertEvent(event, 'COMMAND_RESULT');
              return {
                channels: event.channels,
                result: event.result,
              };
            },
            onDone: [
              {
                guard: ({ event }) => event.output.result === 'pass',
                // No target — raised PASS|FAIL bubbles up to the leaf's
                // handlers. Merge runs first so downstream consumers see
                // captured variables; raise reads from event.output and is
                // order-independent with the merge.
                actions: [
                  {
                    type: 'storeCapturedVariables',
                    params: ({ event }) => ({ variables: event.output.variables }),
                  },
                  { type: 'raisePass' },
                ],
              },
              {
                actions: [
                  {
                    type: 'storeCapturedVariables',
                    params: ({ event }) => ({ variables: event.output.variables }),
                  },
                  { type: 'raiseFail' },
                ],
              },
            ],
            onError: {
              target: STOPPED_STATE_REF,
              actions: {
                type: 'setOutputCaptureFailed',
                params: ({ event }) => ({ message: getErrorMessage(event.error) }),
              },
            },
          },
        },
      },
    } satisfies RunbookStateConfig);
  }

  // Build the machine states
  allStates.forEach((config) => {
    if (config.isParentState) {
      checkedStateInsert(
        states,
        config.id,
        runbookSetup.createStateConfig(buildParentStateConfig(config, steps, evaluationOptions)),
      );
      return;
    }

    checkedStateInsert(states, config.id, buildLeafSubstateConfig(config));

    // Register retry states for transitions with retry > 0
    if (config.transitions.pass.retry > 0) {
      checkedStateInsert(
        states,
        `${config.id}::pass-retry`,
        runbookSetup.createStateConfig(
          buildRetryStateConfig(
            config.transitions.pass,
            config.id,
            config.stepName,
            config.substepId,
            steps,
            'pass',
            evaluationOptions,
          ),
        ),
      );
    }
    if (config.transitions.fail.retry > 0) {
      checkedStateInsert(
        states,
        `${config.id}::fail-retry`,
        runbookSetup.createStateConfig(
          buildRetryStateConfig(
            config.transitions.fail,
            config.id,
            config.stepName,
            config.substepId,
            steps,
            'fail',
            evaluationOptions,
          ),
        ),
      );
    }
  });

  checkedStateInsert(
    states,
    ITERATION_EXHAUSTED_STATE_NAME,
    runbookSetup.createStateConfig(buildIterationExhaustedStateConfig(steps)),
  );

  // Phase 5: Runtime graph validation — catch dynamic errors types cannot prove
  const terminalStates = new Set(['COMPLETE', 'STOPPED']);
  const initialState =
    allStates.length > 0 ? routeThroughParentArtifactsIfNeeded(allStates[0].id, steps) : 'step::1';
  validateGraph(states, initialState, terminalStates, STOPPED_STATE_REF);

  return runbookSetup.createMachine({
    id: 'runbook',
    initial: initialState,
    on: {
      FORCE_STOP: buildForceStopTransition(),
      FORCE_COMPLETE: buildForceCompleteTransition(),
      SET_VARIABLES: {
        actions: runbookSetup.assign({
          variables: ({ context, event }) => {
            assertEvent(event, 'SET_VARIABLES');
            return { ...context.variables, ...event.vars };
          },
        }),
      },
      DELEGATE_FRONTIER_CONSUMED: {
        actions: runbookSetup.assign({
          delegateFrontier: undefined,
        }),
      },
      INLINE_LAUNCH_CONSUMED: {
        actions: 'clearInlineLaunchIntent',
      },
      INLINE_CHILD_STARTED: {
        actions: {
          type: 'storeInlineChildStarted',
          params: ({ event }) => event,
        },
      },
    },
    context: {
      retryCount: 0,
      parentRetryCount: 0,
      iterationRetryCount: 0,
      retryMax: undefined,
      substep: undefined,
      completedSubstep: undefined,
      completedForContext: undefined,
      // Shallow copy is sufficient: variable values are immutable JSON-like
      // values or artifact records, and state transitions replace entries.
      variables: { ...(options?.initialVariables ?? {}) },
      enteredArtifacts: undefined,
      lastAction: makeDirectLastAction({ type: 'START' as const }),
      lastMessage: undefined,
      forStack: [],
      iterationResults: undefined,
      substepCompletedCount: 0,
      deferredResults: undefined,
      templateVars: options?.templateVars ?? {},
      frontmatterOutputs: options?.frontmatterOutputs ?? [],
      finalVars: {},
      lifecycle: 'running',
      substepStates: options?.substepStates,
      delegateFrontier: undefined,
      inlineLaunchIntent: undefined,
      parentLinkage: options?.parentLinkage,
    },
    states: {
      ...states,
      COMPLETE: {
        type: 'final',
        entry: [
          actionRef('storeFrontmatterOutputs', withEvaluationOptions({}, evaluationOptions)),
          runbookSetup.assign({
            lifecycle: () => 'completed' as const,
          }),
        ],
        output: ({ context }) => ({ finalVars: context.finalVars }),
      },
      STOPPED: {
        id: STOPPED_STATE_NAME,
        type: 'final',
        entry: [
          actionRef('storeFrontmatterOutputs', withEvaluationOptions({}, evaluationOptions)),
          runbookSetup.assign({
            lifecycle: () => 'stopped' as const,
          }),
        ],
        output: ({ context }) => ({ finalVars: context.finalVars }),
      },
    },
  }) satisfies RunbookMachine;
}
