import type { ArtifactDeclaration, ResolvedStep, Step } from '@rundown-org/parser';
import { isArtifactRecord } from './artifact-schema.js';
import { type ArtifactRef, parseArtifactUri } from './artifact-uri.js';
import { isTrustedArtifactValue, type TrustedArtifactValue } from './effective-vars.js';
import { collectProducedNames } from './for-source-analysis.js';

/**
 * Symbolic code for a non-artifact value bound to a name the runbook requires
 * to be an artifact: a naked `ARTIFACTS` assertion (language spec §10.1.2) or
 * a `{{ path Name }}` variable-reference render (§9.3).
 */
export const ARTIFACT_INPUT_REQUIRED = 'ARTIFACT_INPUT_REQUIRED';

/**
 * Where a runbook demanded an artifact and found a non-artifact value.
 *
 * - `artifacts-assertion` — a naked `ARTIFACTS` declaration. `reason` is the
 *   spec §10.1.2 failure name the value maps to; `step` is the asserting unit
 *   when it is known (launch analysis knows it; the step-entry resolver
 *   reports on the entered unit's own events).
 * - `path-helper` — `{{ path Name }}` over a value that is not an artifact.
 *   `reference` is the template path as written (`plan.file`); the refusal's
 *   `variable` is the name that binds the value (`plan`).
 */
export type ArtifactInputRequiredSite =
  | {
      readonly kind: 'artifacts-assertion';
      readonly reason: ArtifactAssertionShapeFailure;
      readonly step?: string;
    }
  | { readonly kind: 'path-helper'; readonly reference: string };

/**
 * Which preparation is judging launch values: a root launch (`rundown run`,
 * `rundown resolve`) or the preparation of a Child Run (an Inline Child's
 * launch or a Delegation's `rundown claim`), whose values come from its parent.
 */
export type ArtifactInputRefusalOrigin =
  | { readonly kind: 'launch' }
  | { readonly kind: 'child-preparation' };

/**
 * Whether a step of the run's own runbook binds the refused name — an
 * `OUTPUTS` name, a name-binding `ARTIFACTS` alias, or a `FOR` loop variable.
 *
 * - `runbook-step` — a step sets it, so the recovery is that step: bind the
 *   name to an artifact there.
 * - `no-runbook-step` — no step does, so the value is the one the run was
 *   given (or one a composed child's `outputs:` forwarded); the recovery is a
 *   new run supplied through the artifact channel, `--artifacts`.
 */
export type StepEntryBinder = 'runbook-step' | 'no-runbook-step';

/**
 * What a step-entry refusal does to the run, which is fixed by the path the
 * refusal takes rather than by what the runbook asked for.
 *
 * - `run-stops` — the refusal happened while the unit's `ARTIFACTS` resolved
 *   (a naked assertion, or a `{{ path … }}` inside a declaration's token), and
 *   the resolver's failure path stops the run.
 * - `run-keeps-position` — the refusal happened while rendering the unit's
 *   description, prompt or command; the run keeps its position for the owner's
 *   `rundown goto` or `rundown stop`.
 */
export type StepEntryRefusalOutcome = 'run-stops' | 'run-keeps-position';

/**
 * When the refusal happened, which decides the recovery its message names.
 *
 * - `launch` — before any run exists; the caller can relaunch with
 *   `--artifacts`.
 * - `child-preparation` — the value came from the parent, where it must be an
 *   artifact URI; no flag on the child's command can supply it.
 * - `step-entry` — a run exists and its owner recovers it. `outcome` says
 *   whether the refusal stopped the run or left it at its position, and
 *   `binder` whether a step of the runbook binds the name; together they
 *   decide what the owner must change.
 */
export type ArtifactInputRefusalContext =
  | ArtifactInputRefusalOrigin
  | {
      readonly kind: 'step-entry';
      readonly binder: StepEntryBinder;
      readonly outcome: StepEntryRefusalOutcome;
    };

/** Spec §10.1.2 failure names that mean "this value is not artifact-shaped". */
export type ArtifactAssertionShapeFailure =
  | 'not-an-artifact'
  | 'unresolvable-uri'
  | 'partial-resolve';

/** An `rd://` URI string together with its parsed reference. */
export interface ParsedArtifactUriString {
  /** The URI as it was bound. */
  readonly text: string;
  /** Its parsed reference. */
  readonly ref: ArtifactRef;
}

/**
 * A value a naked assertion admits, in the form step entry resolves.
 *
 * - `trusted` — an artifact value from a sanctioned producer, emitted as-is.
 * - `uri` — one URI string (§10.1.2), resolved against the manifest.
 * - `uri-array` — a non-empty URI[] or JSON URI[] string, resolved all-or-nothing.
 */
export type AdmittedArtifactValue =
  | { readonly kind: 'trusted'; readonly value: TrustedArtifactValue }
  | { readonly kind: 'uri'; readonly uri: ParsedArtifactUriString }
  | { readonly kind: 'uri-array'; readonly uris: readonly ParsedArtifactUriString[] };

/**
 * Shape verdict for a value bound to a naked-asserted name.
 *
 * `admitted` means the value is one of the §10.1.2 shapes — it may still
 * fail to resolve against the manifest at step entry (`unresolvable-uri` for a
 * well-formed URI that matches no row), but no non-artifact value is
 * `admitted`.
 */
export type ArtifactAssertionShape =
  | { readonly kind: 'admitted'; readonly value: AdmittedArtifactValue }
  | { readonly kind: 'not-artifact'; readonly reason: ArtifactAssertionShapeFailure };

/**
 * What a refused value is, named without echoing it: a value supplied through
 * `--input KEY` or `RD_INPUT_*` may be a secret, and the refusal reaches
 * events, persisted `lastAction` and CLI envelopes.
 */
export type NonArtifactValueKind =
  | 'plain-string'
  | 'unresolved-uri-string'
  | 'empty-json-array-string'
  | 'unresolved-uri-json-array-string'
  | 'json-array-string-with-non-uri-entry'
  | 'empty-array'
  | 'string-array-with-non-uri-entry'
  | 'unresolved-uri-string-array'
  | 'unverified-artifact-record'
  | 'number'
  | 'boolean'
  | 'null'
  | 'undefined'
  | 'object'
  | 'array'
  | 'other';

/**
 * Refusal of a non-artifact value where the runbook requires an artifact.
 *
 * Thrown by the step-entry ARTIFACTS resolver and the `path` template helper,
 * and returned (as data) by launch preparation. Its message names the variable
 * and the value's kind — never the value — and the recovery its
 * {@link ArtifactInputRefusalContext} allows.
 */
export class ArtifactInputRequiredError extends Error {
  /** Machine-readable code rendered by every front end. */
  readonly code = ARTIFACT_INPUT_REQUIRED;
  /** The variable bound to the non-artifact value. */
  readonly variable: string;
  /** Where the artifact was required. */
  readonly site: ArtifactInputRequiredSite;
  /** What the refused value is. The value itself is not retained. */
  readonly found: NonArtifactValueKind;
  /** When the refusal happened. */
  readonly context: ArtifactInputRefusalContext;

  /**
   * Create the refusal from what the value is.
   *
   * @param variable - The variable bound to a non-artifact value
   * @param found - What the value is (see {@link describeNonArtifactValue})
   * @param site - Where the runbook required an artifact
   * @param context - When the refusal happened, which picks the recovery named
   */
  constructor(
    variable: string,
    found: NonArtifactValueKind,
    site: ArtifactInputRequiredSite,
    context: ArtifactInputRefusalContext,
  ) {
    super(formatArtifactInputRequiredMessage(variable, found, site, context));
    this.name = 'ArtifactInputRequiredError';
    this.variable = variable;
    this.site = site;
    this.found = found;
    this.context = context;
  }

  /**
   * Refuse a value. Only its kind is kept: the value may be a secret.
   *
   * @param variable - The variable bound to a non-artifact value
   * @param value - The offending value
   * @param site - Where the runbook required an artifact
   * @param context - When the refusal happened
   * @returns The refusal
   */
  static forValue(
    variable: string,
    value: unknown,
    site: ArtifactInputRequiredSite,
    context: ArtifactInputRefusalContext,
  ): ArtifactInputRequiredError {
    return new ArtifactInputRequiredError(variable, describeNonArtifactValue(value), site, context);
  }
}

function parsedUri(text: string): ParsedArtifactUriString | null {
  try {
    return { text, ref: parseArtifactUri(text) };
  } catch {
    return null;
  }
}

function isArtifactUriString(value: unknown): value is string {
  return typeof value === 'string' && parsedUri(value) !== null;
}

/**
 * Whether an entry claims to be an artifact URI, whether or not it parses.
 *
 * @param entry - A decoded JSON array entry
 * @returns `true` when the entry is a string beginning `rd://`
 */
function isRdPrefixedString(entry: unknown): boolean {
  return typeof entry === 'string' && entry.startsWith('rd://');
}

/**
 * Decode a string that is a JSON array, whatever its entries.
 *
 * The one decoder for the JSON `URI[]` transport (§10.1.2): the shape rule
 * and the value description both dispatch on its entries. A string counts as
 * that transport only when the array holds at least one `rd://` entry; any
 * other JSON array string is an ordinary string.
 *
 * @param value - Candidate string
 * @returns The decoded entries, or `null` when the string is not a JSON array
 */
function decodeJsonArrayString(value: string): readonly unknown[] | null {
  if (!value.trimStart().startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isUnverifiedArtifactRecord(value: unknown): boolean {
  return (
    isArtifactRecord(value) ||
    (Array.isArray(value) && value.length > 0 && value.every(isArtifactRecord))
  );
}

/**
 * Name what a refused value is, without its content.
 *
 * @param value - A value that is not a trusted artifact
 * @returns The value's kind
 */
export function describeNonArtifactValue(value: unknown): NonArtifactValueKind {
  if (isUnverifiedArtifactRecord(value)) return 'unverified-artifact-record';
  if (typeof value === 'string') {
    const entries = decodeJsonArrayString(value);
    if (entries !== null && entries.length === 0) return 'empty-json-array-string';
    if (entries?.some(isRdPrefixedString)) {
      return entries.every(isArtifactUriString)
        ? 'unresolved-uri-json-array-string'
        : 'json-array-string-with-non-uri-entry';
    }
    return isArtifactUriString(value) ? 'unresolved-uri-string' : 'plain-string';
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return 'empty-array';
    if (value.every((entry): entry is string => typeof entry === 'string')) {
      return value.every(isArtifactUriString)
        ? 'unresolved-uri-string-array'
        : 'string-array-with-non-uri-entry';
    }
    return 'array';
  }
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
    case 'bigint':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'undefined':
      return 'undefined';
    case 'object':
      return 'object';
    default:
      return 'other';
  }
}

function nonArtifactValueText(found: NonArtifactValueKind): string {
  switch (found) {
    case 'plain-string':
      return 'a plain string that is not an rd:// URI';
    case 'unresolved-uri-string':
      return 'an rd:// URI string that has not been resolved to an artifact';
    case 'empty-json-array-string':
      return 'an empty JSON array string';
    case 'unresolved-uri-json-array-string':
      return 'a JSON array string of rd:// URIs that have not been resolved to artifacts';
    case 'json-array-string-with-non-uri-entry':
      return 'a JSON array string with an entry that is not an rd:// URI';
    case 'empty-array':
      return 'an empty array';
    case 'string-array-with-non-uri-entry':
      return 'a string array with an entry that is not an rd:// URI';
    case 'unresolved-uri-string-array':
      return 'an array of rd:// URI strings that have not been resolved to artifacts';
    case 'unverified-artifact-record':
      return 'an unverified artifact-shaped record, which did not come through the artifact channel';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'null':
      return 'null';
    case 'undefined':
      return 'no value';
    case 'object':
      return 'an object that is not an artifact record';
    case 'array':
      return 'an array of values that are not artifacts';
    case 'other':
      return 'a value that is not data';
    default: {
      const _exhaustive: never = found;
      return _exhaustive;
    }
  }
}

function recoveryGuidance(
  variable: string,
  site: ArtifactInputRequiredSite,
  context: ArtifactInputRefusalContext,
): string {
  switch (context.kind) {
    case 'launch':
      return (
        `Supply it with --artifacts ${variable}=<rd:// URI> (or --artifacts-json ${variable}='["<rd:// URI>", …]'); ` +
        "`rundown artifact ls --run <producer_run_id>` lists the producing run's artifacts, each with its `uri`."
      );
    case 'child-preparation':
      return (
        `The value came from the parent run, so it must be an artifact there: bind "${variable}" in the parent ` +
        'to an artifact (an ARTIFACTS alias or an rd:// artifact URI) before this child is launched or claimed.'
      );
    case 'step-entry':
      return stepEntryGuidance(variable, context.binder, context.outcome);
    default: {
      const _exhaustive: never = context;
      return _exhaustive;
    }
  }
}

function stepEntryGuidance(
  variable: string,
  binder: StepEntryBinder,
  outcome: StepEntryRefusalOutcome,
): string {
  const relaunch =
    `start a new run that supplies it with --artifacts ${variable}=<rd:// URI> ` +
    `(or --artifacts-json ${variable}='["<rd:// URI>", …]').`;
  const unbound =
    `No step of this runbook binds "${variable}", so its value is the one the run was given ` +
    "(or one a composed child's outputs forwarded)";
  switch (binder) {
    case 'runbook-step':
      return outcome === 'run-stops'
        ? `The run stops. Bind "${variable}" to an artifact in the step that sets it (an ARTIFACTS alias, ` +
            'or an rd:// URI written to its OUTPUTS), then start a new run.'
        : 'The run keeps its position. Recover with `rundown goto` to an earlier step that rebinds ' +
            `"${variable}" to an artifact, or end the run with \`rundown stop\`.`;
    case 'no-runbook-step':
      return outcome === 'run-stops'
        ? `The run stops. ${unbound}: ${relaunch}`
        : `The run keeps its position. ${unbound}: end it with \`rundown stop\` and ${relaunch}`;
    default: {
      const _exhaustive: never = binder;
      return _exhaustive;
    }
  }
}

function formatArtifactInputRequiredMessage(
  variable: string,
  found: NonArtifactValueKind,
  site: ArtifactInputRequiredSite,
  context: ArtifactInputRefusalContext,
): string {
  const described = nonArtifactValueText(found);
  const recovery = recoveryGuidance(variable, site, context);
  switch (site.kind) {
    case 'artifacts-assertion': {
      const where = site.step === undefined ? '' : ` at step ${site.step}`;
      const shape =
        site.reason === 'partial-resolve'
          ? ' URI[] resolution is all-or-nothing.'
          : site.reason === 'not-an-artifact'
            ? ' Expected an ArtifactRecord, ArtifactRecord[], URI string, URI string[], or JSON URI[] string.'
            : '';
      return (
        `${site.reason}: ARTIFACTS naked declaration "${variable}"${where} requires an artifact, ` +
        `but it is bound to ${described}.${shape} ${recovery}`
      );
    }
    case 'path-helper':
      return (
        `{{ path ${site.reference} }} requires an artifact, but "${variable}" is bound to ${described}. ` +
        `${recovery} To render the plain value, use {{ ${site.reference} }}.`
      );
    default: {
      const _exhaustive: never = site;
      return _exhaustive;
    }
  }
}

function classifyUriArray(entries: readonly unknown[]): ArtifactAssertionShape {
  const uris: ParsedArtifactUriString[] = [];
  for (const entry of entries) {
    const uri = typeof entry === 'string' ? parsedUri(entry) : null;
    if (uri === null) return { kind: 'not-artifact', reason: 'partial-resolve' };
    uris.push(uri);
  }
  return { kind: 'admitted', value: { kind: 'uri-array', uris } };
}

/**
 * Classify a value bound to a naked-asserted name by shape alone.
 *
 * This is the single shape rule shared by launch preparation and the
 * step-entry resolver, so the two cannot disagree about which values are
 * refused `ARTIFACT_INPUT_REQUIRED`. It mirrors the §10.1.2 dispatch:
 *
 * - a trusted (branded) artifact value is admitted;
 * - an unbranded artifact-shaped record or record array is `not-an-artifact`
 *   (it did not come through the artifact channel);
 * - a JSON array string is decoded once: an empty one is `not-an-artifact`;
 *   one holding at least one `rd://` entry is a URI[] transport, admitted
 *   when every entry parses and `partial-resolve` otherwise; any other JSON
 *   array string is an ordinary string;
 * - any other string is admitted iff it parses as an `rd://` URI
 *   (`unresolvable-uri` otherwise);
 * - a non-empty string array is admitted iff every entry parses
 *   (`partial-resolve` otherwise);
 * - everything else is `not-an-artifact`.
 *
 * @param value - The value bound to the asserted name
 * @returns `admitted` with the parsed form step entry resolves, or the
 *   §10.1.2 failure the value maps to
 */
export function classifyArtifactAssertionValue(value: unknown): ArtifactAssertionShape {
  if (isTrustedArtifactValue(value)) {
    return { kind: 'admitted', value: { kind: 'trusted', value } };
  }
  if (isUnverifiedArtifactRecord(value)) return { kind: 'not-artifact', reason: 'not-an-artifact' };
  if (typeof value === 'string') {
    const entries = decodeJsonArrayString(value);
    if (entries !== null && entries.length === 0) {
      return { kind: 'not-artifact', reason: 'not-an-artifact' };
    }
    if (entries?.some(isRdPrefixedString)) return classifyUriArray(entries);
    const uri = parsedUri(value);
    return uri === null
      ? { kind: 'not-artifact', reason: 'unresolvable-uri' }
      : { kind: 'admitted', value: { kind: 'uri', uri } };
  }
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry): entry is string => typeof entry === 'string')
  ) {
    return classifyUriArray(value);
  }
  return { kind: 'not-artifact', reason: 'not-an-artifact' };
}

/**
 * Which names launch must leave to step entry because a step can rebind them
 * before an assertion or `{{ path … }}` render reads them (spec §8.2).
 *
 * - `produced-names` — the §8.2 produced set: every step and substep `OUTPUTS`
 *   name and every name-binding `ARTIFACTS` alias.
 * - `every-name` — the runbook composes a Child Run (an inline runbook-list
 *   entry or a `DELEGATE`). A child's frontmatter `outputs:` are forwarded into
 *   this run's live variables (§10.3), and launch cannot know them without
 *   loading every child runbook, so its produced set is unbounded. Like the
 *   produced set, this is order-free: `GOTO` can reach an asserting step after
 *   the composing one whatever their source order.
 */
export type LaunchArtifactDeferral =
  | { readonly kind: 'produced-names'; readonly names: ReadonlySet<string> }
  | { readonly kind: 'every-name' };

function composesChild(steps: readonly Step[]): boolean {
  return steps.some(
    (step) =>
      (step.kind === 'substeps' || step.kind === 'for') &&
      step.substeps.some((substep) => (substep.runbooks?.length ?? 0) > 0),
  );
}

/**
 * Derive which names launch defers to step entry.
 *
 * @param steps - Parsed runbook steps
 * @returns The deferral both launch checks (naked assertions and `{{ path … }}`) apply
 */
export function deriveLaunchArtifactDeferral(steps: readonly Step[]): LaunchArtifactDeferral {
  return composesChild(steps)
    ? { kind: 'every-name' }
    : { kind: 'produced-names', names: collectProducedNames(steps) };
}

/**
 * Whether launch defers judging a name to step entry.
 *
 * @param deferral - The runbook's launch deferral
 * @param name - The variable name
 * @returns `true` when a step may rebind `name` before it is read
 */
export function defersAtLaunch(deferral: LaunchArtifactDeferral, name: string): boolean {
  switch (deferral.kind) {
    case 'every-name':
      return true;
    case 'produced-names':
      return deferral.names.has(name);
    default: {
      const _exhaustive: never = deferral;
      return _exhaustive;
    }
  }
}

/**
 * How a render treats `{{ path Name }}` over a value that is not an artifact.
 *
 * Only the render of the unit being judged refuses: a launch's whole-runbook
 * render (for a name no step can rebind first) and the render of the unit
 * being entered. A render that carries no judgement — the whole-runbook
 * reload every command performs — judges nothing: it leaves such a reference
 * unrendered, because the steps it reaches are not being entered and the
 * value they will see is decided at their entry.
 *
 * - `launch` — refuse a name `deferral` does not defer, as `origin`.
 * - `step-entry` — refuse every name; `stepBoundNames` (see
 *   {@link collectStepBoundNames}) and `outcome` (the path this render's
 *   refusal takes) decide the refusal's recovery.
 */
export type PathArtifactJudgement =
  | {
      readonly kind: 'launch';
      readonly origin: ArtifactInputRefusalOrigin;
      readonly deferral: LaunchArtifactDeferral;
    }
  | {
      readonly kind: 'step-entry';
      readonly stepBoundNames: ReadonlySet<string>;
      readonly outcome: StepEntryRefusalOutcome;
    };

/** The execution unit a step-entry judgement is made for: a step or one of its substeps. */
export interface StepEntryUnit {
  /** The step's name (`N`). */
  readonly step: string;
  /** The substep's id (`M` of `N.M`), when the unit is a substep. */
  readonly substep?: string;
}

/**
 * Names a step of the runbook binds, as seen from one execution unit: the
 * §8.2 produced set, plus the loop variable of the `FOR` step whose substep
 * the unit is. A step-entry refusal of any other name has no step to fix,
 * only a new run.
 *
 * A loop variable is bound only inside its loop's substeps. A `FOR` step's
 * own `ARTIFACTS` precede its `FOR` and resolve on entering the step, before
 * any iteration binds the variable, and every unit outside the loop runs
 * without it; for those units the value of that name is one no step binds.
 *
 * @param steps - Parsed or resolved runbook steps
 * @param unit - The unit being entered
 * @returns The names some step binds for `unit`
 */
export function collectStepBoundNames(
  steps: readonly (Step | ResolvedStep)[],
  unit: StepEntryUnit,
): ReadonlySet<string> {
  const names = collectProducedNames(steps);
  if (unit.substep === undefined) return names;
  const enclosing = steps.find((step) => step.name === unit.step);
  if (enclosing?.kind === 'for' && enclosing.forClause.variable !== undefined) {
    names.add(enclosing.forClause.variable);
  }
  return names;
}

/**
 * The step-entry refusal context for a name.
 *
 * @param stepBoundNames - Names a step of the runbook binds
 * @param variable - The refused name
 * @param outcome - What the refusal's path does to the run
 * @returns The `step-entry` context whose `binder` says whether a step binds it
 */
export function stepEntryRefusalContext(
  stepBoundNames: ReadonlySet<string>,
  variable: string,
  outcome: StepEntryRefusalOutcome,
): Extract<ArtifactInputRefusalContext, { kind: 'step-entry' }> {
  return {
    kind: 'step-entry',
    binder: stepBoundNames.has(variable) ? 'runbook-step' : 'no-runbook-step',
    outcome,
  };
}

function nakedNames(declarations: readonly ArtifactDeclaration[] | undefined): string[] {
  return (declarations ?? []).filter((d) => d.rawToken === null).map((d) => d.name);
}

/**
 * Map each name a naked `ARTIFACTS` assertion requires to the first unit
 * (`N` or `N.M`, in source order) that asserts it, keeping only names whose
 * value at that unit is the launch value.
 *
 * A name {@link deriveLaunchArtifactDeferral} defers can be rebound before the
 * assertion runs, so it is excluded: only step entry can judge it. An
 * assertion inside a `FOR` step's substeps on the loop variable's own name is
 * excluded for the same reason — the iteration binds it. A FOR step's own
 * step-level assertion is not: its `ARTIFACTS` resolve on entering the step,
 * before any iteration binds the loop variable, so the value it judges is the
 * launch value. (On parsed steps a FOR whose bounds will not resolve is still
 * a `for` step; it is demoted to `prompted-for` only when its bounds are
 * resolved, so this walk covers it.)
 *
 * @param steps - Parsed runbook steps
 * @param deferral - The runbook's launch deferral ({@link deriveLaunchArtifactDeferral})
 * @returns Launch-decidable asserted names, each with its first asserting unit
 */
export function collectLaunchDecidableArtifactAssertions(
  steps: readonly Step[],
  deferral: LaunchArtifactDeferral,
): ReadonlyMap<string, string> {
  const asserted = new Map<string, string>();
  const add = (name: string, unit: string): void => {
    if (!defersAtLaunch(deferral, name) && !asserted.has(name)) asserted.set(name, unit);
  };
  for (const step of steps) {
    for (const name of nakedNames(step.artifacts)) add(name, step.name);
    if (step.kind === 'substeps' || step.kind === 'for') {
      const loopVariable = step.kind === 'for' ? step.forClause.variable : undefined;
      for (const substep of step.substeps) {
        for (const name of nakedNames(substep.artifacts)) {
          if (name !== loopVariable) add(name, `${step.name}.${substep.id}`);
        }
      }
    }
  }
  return asserted;
}

/**
 * Find the first launch value bound to a naked-asserted name that the
 * assertion can never accept (language spec §10.1.2), before any run exists.
 *
 * Only names {@link collectLaunchDecidableArtifactAssertions} returns are
 * judged; an unbound name is left to `required` and to step entry's `unbound`.
 *
 * @param steps - Parsed runbook steps
 * @param launchVars - Effective variables at launch (template and runtime vars merged)
 * @param origin - Which preparation is judging the values
 * @param deferral - The runbook's launch deferral, shared with the launch
 *   `{{ path … }}` judgement so the two checks defer the same names
 * @returns The refusal for the first offending name, or `null` when none
 */
export function findArtifactInputRefusal(
  steps: readonly Step[],
  launchVars: Readonly<Record<string, unknown>>,
  origin: ArtifactInputRefusalOrigin,
  deferral: LaunchArtifactDeferral,
): ArtifactInputRequiredError | null {
  for (const [name, unit] of collectLaunchDecidableArtifactAssertions(steps, deferral)) {
    if (!Object.hasOwn(launchVars, name)) continue;
    const value = launchVars[name];
    const shape = classifyArtifactAssertionValue(value);
    if (shape.kind === 'not-artifact') {
      return ArtifactInputRequiredError.forValue(
        name,
        value,
        { kind: 'artifacts-assertion', reason: shape.reason, step: unit },
        origin,
      );
    }
  }
  return null;
}
