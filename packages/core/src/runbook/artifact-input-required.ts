import type { ArtifactDeclaration, Step } from '@rundown-org/parser';
import { parseJsonArtifactUriArrayTransport } from './artifact-inputs.js';
import { parseArtifactUri } from './artifact-uri.js';
import { isTrustedArtifactValue } from './effective-vars.js';
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
 */
export type ArtifactInputRequiredSite =
  | {
      readonly kind: 'artifacts-assertion';
      readonly reason: ArtifactAssertionShapeFailure;
      readonly step?: string;
    }
  | { readonly kind: 'path-helper' };

/** Spec §10.1.2 failure names that mean "this value is not artifact-shaped". */
export type ArtifactAssertionShapeFailure =
  | 'not-an-artifact'
  | 'unresolvable-uri'
  | 'partial-resolve';

/**
 * Shape verdict for a value bound to a naked-asserted name.
 *
 * `assertable` means the value is one of the §10.1.2 shapes — it may still
 * fail to resolve against the manifest at step entry (`unresolvable-uri` for a
 * well-formed URI that matches no row), but no non-artifact value is
 * `assertable`.
 */
export type ArtifactAssertionShape =
  | { readonly kind: 'assertable' }
  | { readonly kind: 'not-artifact'; readonly reason: ArtifactAssertionShapeFailure };

/**
 * Refusal of a non-artifact value where the runbook requires an artifact.
 *
 * Thrown by the step-entry ARTIFACTS resolver and the `path` template helper,
 * and returned (as data) by launch preparation. Its message always names the
 * supported launch channel, `--artifacts <name>=<rd:// URI>`.
 */
export class ArtifactInputRequiredError extends Error {
  /** Machine-readable code rendered by every front end. */
  readonly code = ARTIFACT_INPUT_REQUIRED;
  /** The variable bound to the non-artifact value. */
  readonly variable: string;
  /** Where the artifact was required. */
  readonly site: ArtifactInputRequiredSite;

  /**
   * Create the refusal.
   *
   * @param variable - The variable bound to a non-artifact value
   * @param value - The offending value (described, never echoed in full)
   * @param site - Where the runbook required an artifact
   */
  constructor(variable: string, value: unknown, site: ArtifactInputRequiredSite) {
    super(formatArtifactInputRequiredMessage(variable, value, site));
    this.name = 'ArtifactInputRequiredError';
    this.variable = variable;
    this.site = site;
  }
}

const MAX_DESCRIBED_VALUE_LENGTH = 120;

function describeValue(value: unknown): string {
  let text: string;
  if (typeof value === 'string') {
    text = JSON.stringify(value);
  } else {
    try {
      text = JSON.stringify(value) ?? typeof value;
    } catch {
      text = typeof value;
    }
  }
  return text.length > MAX_DESCRIBED_VALUE_LENGTH
    ? `${text.slice(0, MAX_DESCRIBED_VALUE_LENGTH)}…`
    : text;
}

function supplyGuidance(variable: string): string {
  return (
    `Supply it with --artifacts ${variable}=<rd:// URI> (or --artifacts-json ${variable}='["<rd:// URI>", …]'); ` +
    "list existing artifacts with `rundown artifact ls` and print one's URI with `rundown artifact uri <alias>`."
  );
}

function formatArtifactInputRequiredMessage(
  variable: string,
  value: unknown,
  site: ArtifactInputRequiredSite,
): string {
  const described = describeValue(value);
  switch (site.kind) {
    case 'artifacts-assertion': {
      const where = site.step === undefined ? '' : ` at step ${site.step}`;
      const shape =
        site.reason === 'unresolvable-uri'
          ? 'is not an artifact URI (expected rd://artifacts/…)'
          : site.reason === 'partial-resolve'
            ? 'holds an entry that is not an artifact URI (expected rd://artifacts/…); URI[] resolution is all-or-nothing'
            : 'is not artifact-shaped (expected ArtifactRecord, ArtifactRecord[], URI string, URI string[], or JSON URI[] string)';
      return (
        `${site.reason}: ARTIFACTS naked declaration "${variable}"${where} requires an artifact, ` +
        `but its value ${described} ${shape}. ${supplyGuidance(variable)}`
      );
    }
    case 'path-helper':
      return (
        `{{ path ${variable} }} requires an artifact, but "${variable}" is bound to ${described}, ` +
        `which is not an artifact. ${supplyGuidance(variable)} ` +
        `To render the plain value, use {{ ${variable} }}.`
      );
    default: {
      const _exhaustive: never = site;
      return _exhaustive;
    }
  }
}

function isArtifactUriString(value: string): boolean {
  try {
    parseArtifactUri(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Classify a value bound to a naked-asserted name by shape alone.
 *
 * This is the single shape rule shared by launch preparation and the
 * step-entry resolver, so the two cannot disagree about which values are
 * refused `ARTIFACT_INPUT_REQUIRED`. It mirrors the §10.1.2 dispatch:
 *
 * - a trusted (branded) artifact value is assertable;
 * - a JSON URI[] string is assertable when non-empty and every entry parses;
 *   an empty one is `not-an-artifact`, a malformed entry `partial-resolve`;
 * - any other string is assertable iff it parses as an `rd://` URI
 *   (`unresolvable-uri` otherwise);
 * - a non-empty string array is assertable iff every entry parses
 *   (`partial-resolve` otherwise);
 * - everything else is `not-an-artifact`.
 *
 * Forged, unbranded artifact-shaped records are classified `not-an-artifact`
 * here; the resolver reports those with its own provenance message first.
 *
 * @param value - The value bound to the asserted name
 * @returns `assertable`, or the §10.1.2 failure the value maps to
 */
export function classifyArtifactAssertionValue(value: unknown): ArtifactAssertionShape {
  if (isTrustedArtifactValue(value)) return { kind: 'assertable' };
  if (typeof value === 'string') {
    const transport = parseJsonArtifactUriArrayTransport(value);
    if (transport !== null) {
      if (transport.length === 0) return { kind: 'not-artifact', reason: 'not-an-artifact' };
      return transport.every(isArtifactUriString)
        ? { kind: 'assertable' }
        : { kind: 'not-artifact', reason: 'partial-resolve' };
    }
    return isArtifactUriString(value)
      ? { kind: 'assertable' }
      : { kind: 'not-artifact', reason: 'unresolvable-uri' };
  }
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry): entry is string => typeof entry === 'string')
  ) {
    return value.every(isArtifactUriString)
      ? { kind: 'assertable' }
      : { kind: 'not-artifact', reason: 'partial-resolve' };
  }
  return { kind: 'not-artifact', reason: 'not-an-artifact' };
}

function nakedNames(declarations: readonly ArtifactDeclaration[] | undefined): string[] {
  return (declarations ?? []).filter((d) => d.rawToken === null).map((d) => d.name);
}

/**
 * Map each name a naked `ARTIFACTS` assertion requires to the first unit
 * (`N` or `N.M`, in source order) that asserts it, keeping only names whose
 * value at that unit is the launch value.
 *
 * A name in the §8.2 produced set (any step or substep `OUTPUTS` name, or a
 * name-binding `ARTIFACTS` alias) can be rebound before the assertion runs,
 * so it is excluded: only step entry can judge it. An assertion inside a
 * `FOR` step's substeps on the loop variable's own name is excluded for the
 * same reason — the iteration binds it.
 *
 * @param steps - Parsed runbook steps
 * @returns Launch-decidable asserted names, each with its first asserting unit
 */
export function collectLaunchDecidableArtifactAssertions(
  steps: readonly Step[],
): ReadonlyMap<string, string> {
  const produced = collectProducedNames(steps);
  const asserted = new Map<string, string>();
  const add = (name: string, unit: string): void => {
    if (!produced.has(name) && !asserted.has(name)) asserted.set(name, unit);
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
 * @returns The refusal for the first offending name, or `null` when none
 */
export function findArtifactInputRefusal(
  steps: readonly Step[],
  launchVars: Readonly<Record<string, unknown>>,
): ArtifactInputRequiredError | null {
  for (const [name, unit] of collectLaunchDecidableArtifactAssertions(steps)) {
    if (!Object.hasOwn(launchVars, name)) continue;
    const value = launchVars[name];
    const shape = classifyArtifactAssertionValue(value);
    if (shape.kind === 'not-artifact') {
      return new ArtifactInputRequiredError(name, value, {
        kind: 'artifacts-assertion',
        reason: shape.reason,
        step: unit,
      });
    }
  }
  return null;
}
