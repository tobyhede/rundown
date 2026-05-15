import type { OutputDeclaration } from '@rundown-org/parser';
import type { RunbookContext, RunbookEvent } from './compiler.js';
import type { VariableValue } from './effective-vars.js';
import type { EvaluateOutputOptions } from './output-evaluator.js';
import type { PreparedChannel } from './output-channels.js';
import type { ArtifactVarValue, LastAction } from './types.js';
import type { ForIterateOutput, ForResolutionFailureCode } from './actors/for-iterate-actor.js';

/**
 * Single source of truth for parameterized action names and their params shapes.
 *
 * Every named action declared in {@link runbookSetup} that takes a `params`
 * argument MUST have its param shape listed here. The setup implementations
 * reference `ActionDefs[K]` for their second-argument type, and the
 * {@link actionRef} factory uses this map to type-check both the action name
 * and the params shape at every call site.
 *
 * Adding a new parameterized action:
 * 1. Add `<name>: <ParamsShape>` to this map.
 * 2. Declare the impl in `runbookSetup({ actions: { ... } })` with its params
 *    argument typed as `ActionDefs['<name>']`.
 * 3. Construct refs at call sites with `actionRef('<name>', { ... })`.
 */
export interface ActionDefs {
  readonly setLastAction: { action: LastAction; msg?: string };
  readonly storeCapturedVariables: { variables: Readonly<Record<string, VariableValue>> };
  readonly setOutputCaptureFailed: { message: string };
  readonly setArtifactResolutionFailed: { message: string };
  readonly setPolicyDenied: { message: string };
  readonly setCommandExecutionFailed: { message: string };
  readonly raiseCommandResult: {
    result: 'pass' | 'fail';
    channels: readonly PreparedChannel[];
  };
  readonly storeReadyIteration: { output: ForIterateOutput };
  readonly storeExhaustedIteration: { output: ForIterateOutput };
  readonly setForResolutionFailed: {
    code: ForResolutionFailureCode;
    message: string;
  };
  readonly setDelegationIssuanceFailed: {
    reason: 'delegation_resolution_failed' | 'nested_delegation_forbidden';
    message: string;
  };
  readonly storeDelegateFrontier: {
    frontier: RunbookContext['delegateFrontier'];
    substepStates: NonNullable<RunbookContext['substepStates']>;
  };
  readonly storeResolvedArtifacts: { variables: Readonly<Record<string, ArtifactVarValue>> };
  /** Evaluates step/substep OUTPUTS declarations and merges the results into live context variables. */
  readonly storeStepOutputs: {
    /** OUTPUTS declarations authored on the exiting step or substep. */
    outputs: readonly OutputDeclaration[];
    /** Filesystem options used by artifact-producing OUTPUTS helpers, when available. */
    evaluationOptions?: EvaluateOutputOptions;
    /** Parent step name used to build the OUTPUTS execution frame. */
    stepName: string;
    /** Substep id when evaluating substep-level OUTPUTS; omitted for step-level evaluation. */
    substepId?: string;
    /**
     * Use the most recently completed substep recorded in machine context.
     * Parent-state `always` exits need this because `context.substep` has
     * already been cleared by the time the parent OUTPUTS run.
     */
    useCompletedSubstep?: boolean;
    /**
     * Use the FOR frame snapshot recorded in context.completedForContext to restore
     * loop-scoped variables (Index, loop variable, context.current.at) when forStack
     * has already been cleared by the parent self-transition cleanup.
     */
    useCompletedForContext?: boolean;
  };
  /** Evaluates frontmatter OUTPUTS declarations and persists the result into terminal finalVars. */
  readonly storeFrontmatterOutputs: {
    /** Filesystem options used by artifact-producing OUTPUTS helpers, when available. */
    evaluationOptions?: EvaluateOutputOptions;
    /** Step name for non-terminal evaluation contexts; omitted at terminal entry. */
    stepName?: string;
    /** Substep id for non-terminal evaluation contexts; omitted at terminal entry. */
    substepId?: string;
  };
}

/** Function form for computing action params from the active machine context and event. */
export type ActionParamsFactory<K extends keyof ActionDefs> = (args: {
  readonly context: RunbookContext;
  readonly event: RunbookEvent;
}) => ActionDefs[K];

/** A single parameterized action reference, discriminated on `type`. */
export type ActionRef<K extends keyof ActionDefs> = {
  readonly type: K;
  readonly params: ActionDefs[K] | ActionParamsFactory<K>;
};

/** Union of every parameterized action reference the compiler may emit. */
export type CompilerActionRef = {
  [K in keyof ActionDefs]: ActionRef<K>;
}[keyof ActionDefs];

/**
 * Build a typed action reference for use in XState transition `actions` arrays.
 *
 * Both the action name and the params shape are validated against
 * {@link ActionDefs} at the call site, so a typo on either side is a compile
 * error rather than a runtime surprise.
 *
 * @param type - Name of a parameterized action declared in {@link ActionDefs}
 * @param params - Params shape matching `ActionDefs[type]`
 * @returns `{ type, params }` literal with the narrow discriminated-union type
 */
export function actionRef<K extends keyof ActionDefs>(
  type: K,
  params: ActionDefs[K] | ActionParamsFactory<K>,
): ActionRef<K> {
  return { type, params };
}
