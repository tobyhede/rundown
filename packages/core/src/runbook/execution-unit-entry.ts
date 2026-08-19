/**
 * Entering one execution unit: render it, observe the entry, and classify what
 * the caller must do next.
 *
 * The CLI execution loop used to own all three. It merged effective variables,
 * built the step frame, chose which expander applied to which field, packed a
 * `StepEntryMetadata`, and then read its own rendered command back out to decide
 * whether to run anything — an `undefined` rendered command was the loop's
 * control-flow signal for "nothing to run". Rendering precedence is a
 * language-level concern the spec owns, so it belongs behind the machine
 * (#799); `undefined`-as-signal is a missing type.
 *
 * Both are answered here. {@link deriveExecutionUnitEntry} renders against the
 * run's own frame and returns {@link ExecutionUnitEntry} — `awaiting`,
 * `runnable`, or `inline-launch`. The command travels only on the `runnable`
 * arm, inside a {@link RenderedUnitCommand} whose brand is mintable only in this
 * module, so there is no path from the result back to unexpanded text.
 *
 * Pure: no filesystem, no persistence, no actor. `RunbookActorService`
 * .`enterExecutionUnit` is the seam callers reach, binding this function's two
 * process-scoped dependencies (the canonicalised project directory and the
 * runtime helper registry) and running the persisted-snapshot guards first.
 *
 * @module runbook/execution-unit-entry
 */

import type { DelegateFrontierEntry, InlineLaunchIntent } from '../events/types.js';
import {
  deriveStepEnteredEffect,
  type ExecutionObservationEffect,
  type StepEntryMetadata,
} from '../events/execution-observation.js';
import { InvalidRunbookStateError } from './persisted-state-guards.js';
import { BUILTIN_VARIABLES } from './variable-preparation.js';
import { buildStepPosition, deriveOpenFrames, type FrameKey } from './targeting.js';
import { countNumberedSteps } from './step-utils.js';
import { extractDisplayCommand } from '../cli/command-utils.js';
import { findStepOrThrow, resolveCurrentExecutionUnit } from './execution-units.js';
import { mergeEffectiveVars } from './effective-vars.js';
import { buildStepVariables } from './runtime-frame.js';
import {
  expandLoopVariables,
  expandLoopVariablesForCommand,
  type TemplateRenderContext,
  type TemplateRenderOptions,
} from './template-renderer.js';
import {
  isInlineLaunchIntentWithoutParentEntry,
  type InlineLaunchIntentWithoutParentEntry,
} from './actors/inline-launch-intent-actor.js';
import { rebrandContextSnapshotArtifacts } from './delegation-context.js';
import { inferFrameEntryFromState } from './frame-entry.js';
import type { TemplateHelperRegistry } from './helper-invoke.js';
import type { ResolvedStep, RunbookState } from './types.js';
import type { RunId } from './run-id.js';
import { WORK_DIR } from '../paths.js';

/**
 * Module-private nominal brand on {@link RenderedUnitCommand}.
 *
 * Tier 1 of the two-tier doctrine at `effective-vars.ts` — a `declare const`
 * `unique symbol`, purely type-level, produced only by
 * {@link deriveExecutionUnitEntry}. Tier 1 is what this value needs: the branded
 * record is consumed by typed functions and never round-trips through JSON.
 * `EXECUTE_COMMAND` targets `__execute-command`, whose `invoke.input` reads the
 * event and builds the actor input; there is no `assign`, so a rendered command
 * never reaches persisted context and can never re-enter unbranded.
 *
 * The brand is on the RECORD, not on the command string. `string & {brand}`
 * would foreclose a later upgrade to tier 2, because a primitive cannot carry a
 * runtime symbol.
 *
 * It witnesses PROVENANCE, not cardinality: it proves the text came from the
 * blessed expander, and cannot express "expanded exactly once" — two calls to
 * this function mint two valid values. Single entry per unit is pinned by the
 * call-count assertions on the seam, not by the type.
 */
declare const renderedUnitCommandBrand: unique symbol;

/**
 * A command rendered for one execution-unit entry, announced and executed as
 * one value.
 *
 * The announced `STEP_ENTERED.commandCode` and the string handed to
 * `EXECUTE_COMMAND` are the SAME expansion, which is the property that matters:
 * helpers loaded through `--helpers` are arbitrary synchronous JavaScript, so a
 * non-deterministic one expanded twice would make the command a runbook
 * announces differ from the command it runs. Returning both from one value
 * delivers that by construction rather than by statement ordering.
 *
 * (The rationale this replaces — "artifact-producing helpers append a manifest
 * row per call, so a second expansion would duplicate the entries" — was wrong.
 * `expandLoopVariablesForCommand` is synchronous and reduces to `substituteText`,
 * which imports neither `fs` nor the manifest module, and the manifest append is
 * idempotent by identity in any case.)
 */
export interface RenderedUnitCommand {
  /** Phantom brand; never present at runtime. */
  readonly [renderedUnitCommandBrand]: true;
  /** Fully expanded command text, shell-escaped at every substitution. */
  readonly code: string;
  /** Display-safe projection of {@link code} for observations. */
  readonly displayCommand: string;
  /** Rundown-injected environment for the child process (`RD_*`). */
  readonly rdInjected: Readonly<Record<string, string>>;
}

/** Fields every {@link ExecutionUnitEntry} arm carries. */
interface ExecutionUnitEntryBase {
  /**
   * Entry observations to emit, in order.
   *
   * Exactly one `STEP_ENTERED` today. Modelled as the effect list rather than a
   * single event so the arm shape does not have to change when the entry grows
   * a second observation.
   */
  readonly effects: readonly ExecutionObservationEffect[];
}

/** The unit was entered and there is nothing for this process to run. */
export interface ExecutionUnitAwaiting extends ExecutionUnitEntryBase {
  /** Discriminant. */
  readonly kind: 'awaiting';
}

/** The unit was entered and carries a command this process must execute. */
export interface ExecutionUnitRunnable extends ExecutionUnitEntryBase {
  /** Discriminant. */
  readonly kind: 'runnable';
  /** The one expansion, announced in {@link ExecutionUnitEntryBase.effects} and executed by the caller. */
  readonly command: RenderedUnitCommand;
}

/** The unit was entered and composes a child runbook inline. */
export interface ExecutionUnitInlineLaunch extends ExecutionUnitEntryBase {
  /** Discriminant. */
  readonly kind: 'inline-launch';
  /** One-shot intent the machine prepared for this frame. */
  readonly launch: InlineLaunchIntent;
}

/**
 * What entering one execution unit leaves the caller to do.
 *
 * Exhaustive by construction, which is the point: it replaces the loop's use of
 * an undefined rendered-command field as a control-flow signal. `awaiting` is
 * the arm for a prompted run, a prompted-FOR step, and a unit with no command
 * at all — three conditions the caller previously spelled out itself and can no
 * longer get wrong.
 */
export type ExecutionUnitEntry =
  | ExecutionUnitAwaiting
  | ExecutionUnitRunnable
  | ExecutionUnitInlineLaunch;

/** Inputs to {@link deriveExecutionUnitEntry}. */
export interface DeriveExecutionUnitEntryInput {
  /** Run whose cursor names the unit being entered. */
  readonly state: RunbookState;
  /** Parsed steps for that run. */
  readonly steps: readonly ResolvedStep[];
  /**
   * Reconstructed delegation bearers disclosed with this entry.
   *
   * Supplied only by the re-entry frontier seam, which verifies each token
   * against its persisted hash before handing it here. Absent on every ordinary
   * entry.
   */
  readonly delegateFrontier?: readonly DelegateFrontierEntry[];
  /** Canonicalised project directory used as the helper containment boundary. */
  readonly cwd: string;
  /** Runtime template helpers loaded for this process. */
  readonly helpers?: TemplateHelperRegistry;
}

/**
 * Build the helper render context for a run from its own effective variables.
 *
 * Moved here from the CLI (`helpers/render-context.ts`) with the rest of the
 * rendering: helper containment is a language-level concern, and a front end
 * assembling it was the same inversion #799 names.
 *
 * @param runId - Run whose frame is being rendered.
 * @param cwd - Canonicalised project directory used as the containment boundary.
 * @param vars - Effective variables for the run.
 * @returns Runnable render context for helper invocation.
 * @throws {InvalidRunbookStateError} When the run's variables carry no string
 *   `ContextId` or `WorkPath`. Both are written at run creation, so their
 *   absence is corrupt persisted state, and per the no-migration rule the
 *   recovery path is explicit user action (finish, stop, prune, restart).
 */
function buildRunnableRenderContext(
  runId: RunId,
  cwd: string,
  vars: Readonly<Record<string, unknown>>,
): TemplateRenderContext {
  const contextId = vars[BUILTIN_VARIABLES.ContextId];
  const workPath = vars[BUILTIN_VARIABLES.WorkPath];
  for (const [name, value] of [
    [BUILTIN_VARIABLES.ContextId, contextId],
    [BUILTIN_VARIABLES.WorkPath, workPath],
  ] as const) {
    if (typeof value !== 'string') {
      throw new InvalidRunbookStateError(
        `Runbook state ${runId} is missing ${name}. Delete state and re-run the runbook.`,
        { runId, reason: 'missing_render_context' },
      );
    }
  }
  return {
    kind: 'runnable',
    cwd,
    workPath: workPath as string,
    contextId: contextId as string,
    runId,
  };
}

/**
 * Rundown-injected environment for a command subprocess.
 *
 * Lookup keys come from {@link BUILTIN_VARIABLES} so renaming a built-in is a
 * typecheck error here rather than a silently empty injection. The `RD_*` names
 * themselves are the published subprocess contract and are spelled literally.
 *
 * @param state - Run the command belongs to.
 * @param stepVars - Rendered frame the command was expanded against.
 * @returns Environment overlay merged into the child process.
 */
function buildRdInjectedEnv(
  state: RunbookState,
  stepVars: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  const rdInjected: Record<string, string> = {};
  const workPath = stepVars[BUILTIN_VARIABLES.WorkPath];
  const contextId = stepVars[BUILTIN_VARIABLES.ContextId];
  if (typeof workPath === 'string') rdInjected.RD_WORK_PATH = workPath;
  if (typeof contextId === 'string') rdInjected.RD_CONTEXT_ID = contextId;
  rdInjected.RD_RUN_ID = state.id;
  rdInjected.RD_RUNBOOK_REF = state.runbook.path;
  rdInjected.RD_RUNBOOK_SOURCE = state.runbook.source;
  return rdInjected;
}

/**
 * Whether a persisted one-shot inline-launch intent belongs to THIS entry.
 *
 * Moved here from `actor-service.ts` with the rest of the entry projection, so
 * the classification and the payload field it turns on are derived in one place.
 *
 * @param state - Run being entered.
 * @param entry - Entry metadata for the unit the cursor names.
 * @param intent - Persisted intent read from the run's snapshot context.
 * @returns True when the intent names this run, step, substep, and a live frame.
 */
function shouldProjectInlineLaunchIntent(
  state: RunbookState,
  entry: StepEntryMetadata,
  intent: InlineLaunchIntentWithoutParentEntry,
): boolean {
  if (state.id !== intent.parentRunId) return false;
  if (state.step !== intent.parentStep) return false;
  if (entry.stepId !== intent.parentStep) return false;
  if (state.substep !== intent.parentStepId) return false;
  if (entry.substepId !== intent.parentStepId) return false;

  // Project the one-shot intent only when its authored frame is still live (the
  // active frame or an open FOR context). Openness flows from `deriveOpenFrames`
  // (forStack) — never from the monotonic entry counter, whose keys persist after
  // a loop advances and would otherwise re-project a stale prior-iteration intent
  // onto the current frame.
  return deriveOpenFrames(state).has(intent.parentFrameKey as FrameKey);
}

/**
 * Attach the run's live inline-launch intent to an entry, when it has one.
 *
 * @param state - Run being entered.
 * @param snapshot - Snapshot the entry is observed against.
 * @param entry - Entry metadata for the unit the cursor names.
 * @returns The entry, carrying `inlineLaunch` when a live intent names it.
 */
function withInlineLaunchIntent(
  state: RunbookState,
  snapshot: Record<string, unknown>,
  entry: StepEntryMetadata,
): StepEntryMetadata {
  const persisted = (snapshot.context as { readonly inlineLaunchIntent?: unknown })
    .inlineLaunchIntent;
  if (!isInlineLaunchIntentWithoutParentEntry(persisted)) return entry;
  const intent: InlineLaunchIntentWithoutParentEntry = {
    ...persisted,
    contextSnapshot: rebrandContextSnapshotArtifacts(persisted.contextSnapshot),
  };
  if (!shouldProjectInlineLaunchIntent(state, entry, intent)) return entry;
  return {
    ...entry,
    inlineLaunch: {
      ...intent,
      parentEntry: inferFrameEntryFromState(state, intent.parentFrameKey as FrameKey),
    },
  };
}

/**
 * Overlay a run's persisted snapshot with its own committed cursor.
 *
 * `RunbookState` and `state.snapshot` are written together, but the structured
 * columns are the authority on where the run is; the snapshot is the machine's
 * opaque blob. Reading the cursor off the columns and the rest off the blob is
 * what lets an entry be observed without starting an actor.
 *
 * @param state - Run being entered.
 * @returns Snapshot shape `deriveStepEnteredEffect` reads.
 */
function snapshotForEntry(state: RunbookState): Record<string, unknown> {
  if (!state.snapshot || typeof state.snapshot !== 'object') {
    return { context: { step: state.step, substep: state.substep } };
  }
  const raw = state.snapshot as Record<string, unknown>;
  const context = (raw.context ?? {}) as Record<string, unknown>;
  return {
    ...raw,
    context: {
      ...context,
      step: state.step,
      substepStates: state.substepStates ?? context.substepStates,
      substep: state.substep ?? context.substep,
    },
  };
}

/**
 * Render, observe, and classify the entry into the run's current execution unit.
 *
 * The single producer of {@link StepEntryMetadata}: every field of the
 * `STEP_ENTERED` payload is derived here from the run's own state and steps, so
 * two entry points into the same unit can no longer disagree about what it
 * carries.
 *
 * `prompted` composes the run's persisted flag with the step kind, because a
 * prompted-FOR step is prompted whatever the run was started as, and the
 * `awaiting` classification turns on the same composed term.
 *
 * @param input - Run state, steps, render dependencies, and any frontier bearers.
 * @returns The classified entry.
 * @throws {InvalidRunbookStateError} When the run carries no `ContextId` or
 *   `WorkPath` to render against.
 * @throws {Error} When the run's cursor names a step the parsed runbook does not
 *   define, or when a `--helpers` helper throws while expanding a field.
 */
export function deriveExecutionUnitEntry(input: DeriveExecutionUnitEntryInput): ExecutionUnitEntry {
  const { state, steps } = input;
  const currentStep = findStepOrThrow(steps, state.step);
  const unit = resolveCurrentExecutionUnit(currentStep, state.substep);

  const effectiveVars = mergeEffectiveVars(state);
  const stepVars = buildStepVariables({
    stepId: state.step,
    substepId: state.substep,
    forStack: state.forStack,
    forClause: currentStep.kind === 'for' ? currentStep.forClause : undefined,
    templateVars: effectiveVars,
  });
  const renderOptions: TemplateRenderOptions = {
    helpers: input.helpers,
    context: buildRunnableRenderContext(state.id, input.cwd, effectiveVars),
  };

  // A prompted-FOR substep carries no prompt of its own; the step-level prompt
  // is the reconstructed FOR text, and it is what the operator needs to see.
  const rawPrompt =
    unit.prompt ?? (currentStep.kind === 'prompted-for' ? currentStep.prompt : undefined);
  const unitCommand =
    'id' in unit ? unit.command : currentStep.kind === 'command' ? currentStep.command : undefined;
  const code =
    unitCommand === undefined
      ? undefined
      : expandLoopVariablesForCommand(unitCommand.code, stepVars, renderOptions);

  const entry: StepEntryMetadata = {
    stepId: state.step,
    substepId: state.substep,
    position: buildStepPosition(
      state.step,
      countNumberedSteps(steps),
      state.substep,
      state.forStack,
    ),
    stepName: 'id' in unit ? unit.id : unit.name,
    description: expandLoopVariables(unit.description, stepVars, renderOptions),
    prompt:
      rawPrompt === undefined ? undefined : expandLoopVariables(rawPrompt, stepVars, renderOptions),
    hasCommand: unitCommand !== undefined,
    commandCode: code,
    commandLang: unitCommand?.lang,
    isSubstep: 'id' in unit,
    // A prompted-FOR step is prompted whatever the run was started as, and the
    // `awaiting` classification below turns on this same composed term.
    prompted: (state.prompted ?? false) || currentStep.kind === 'prompted-for',
    delegateFrontier: input.delegateFrontier,
  };

  const snapshot = snapshotForEntry(state);
  const workPath =
    typeof state.templateVars.WorkPath === 'string' ? state.templateVars.WorkPath : WORK_DIR;
  const observed = withInlineLaunchIntent(state, snapshot, entry);
  const effects = [
    deriveStepEnteredEffect({
      snapshot,
      entry: observed,
      artifactPathOptions: { cwd: input.cwd, workPath },
    }),
  ];

  const launch = observed.inlineLaunch;
  if (launch !== undefined) {
    return { kind: 'inline-launch', effects, launch };
  }

  // The three conditions that leave this process nothing to run, collapsed into
  // one arm: a prompted run, a prompted-FOR step, and a unit declaring no
  // command. `hasCommand` comes off the parsed unit rather than off whether an
  // expansion produced text, so a command that renders to the empty string is
  // still runnable.
  if (observed.prompted || code === undefined) {
    return { kind: 'awaiting', effects };
  }

  return {
    kind: 'runnable',
    effects,
    command: {
      code,
      displayCommand: extractDisplayCommand(code) || code,
      rdInjected: buildRdInjectedEnv(state, stepVars),
    } as RenderedUnitCommand,
  };
}
