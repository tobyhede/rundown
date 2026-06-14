import type { ResolvedStep, RunbookFrontmatter, Step } from '@rundown-org/parser';
import { isResolvedForClause, isSourced } from '@rundown-org/parser';

/** Facts about a single data-sourced FOR step. */
export interface SourcedForFact {
  /** Owning step name (e.g. "2"). */
  readonly stepName: string;
  /** FOR data-source variable name (e.g. "Tasks"). */
  readonly source: string;
  /** Number of delegated runbook references in the step (per iteration). */
  readonly delegatedRefCount: number;
}

/** Static FOR-source analysis shared by launch validation and `rd check`. */
export interface ForSourceFacts {
  /** Variable names produced by any step/substep OUTPUTS or name-binding ARTIFACTS. */
  readonly producedNames: ReadonlySet<string>;
  /** Names declared in frontmatter `inputs`. */
  readonly declaredInputs: ReadonlySet<string>;
  /** One entry per data-sourced FOR step. */
  readonly sourcedFors: readonly SourcedForFact[];
}

/**
 * Collect every variable name a runbook binds via step/substep OUTPUTS or
 * name-binding ARTIFACTS. Naked ARTIFACTS assertions (`rawToken === null`)
 * re-assert an existing binding and publish no new name, so they are excluded
 * (matching `artifact-reference-extractor.ts`). This is the deferral set for
 * FOR-source launch validation and the suppression set for the `rd check`
 * FOR-source warning — both MUST use this function so they cannot disagree
 * (language spec §8.2).
 *
 * Accepts the parser-tier `Step` (from `rd check`, which holds an unresolved
 * AST) or `ResolvedStep` (from launch validation). Both expose OUTPUTS/ARTIFACTS
 * via the shared `ContextDirectiveFields`, and substeps are reached through the
 * `kind` discriminant — no casts. Neither union is a subtype of the other
 * (`ResolvedStep` has a `prompted-for` variant; `Step`'s FOR clause is the wider
 * `ParsedForClause`), so the parameter is their union.
 *
 * @param steps - Parsed or resolved runbook steps
 * @returns Set of produced variable names
 */
export function collectProducedNames(steps: readonly (Step | ResolvedStep)[]): Set<string> {
  const names = new Set<string>();
  for (const step of steps) {
    for (const o of step.outputs ?? []) names.add(o.name);
    for (const a of step.artifacts ?? []) if (a.rawToken !== null) names.add(a.name);
    if (step.kind === 'substeps' || step.kind === 'for' || step.kind === 'prompted-for') {
      for (const sub of step.substeps) {
        for (const o of sub.outputs ?? []) names.add(o.name);
        for (const a of sub.artifacts ?? []) if (a.rawToken !== null) names.add(a.name);
      }
    }
  }
  return names;
}

/**
 * Analyze a runbook's FOR data sources for launch validation and static checks.
 *
 * Only data-sourced FOR steps (`FOR x IN {{source}}`) contribute facts; a pure
 * numeric-range FOR has no `source` (the `ForClause` union is discriminated on
 * it) and is intentionally excluded, so the shared-binding warning can never
 * fire for one — matching the spec's "numeric-range FOR is unaffected" rule
 * (language spec §10.4).
 *
 * @param steps - Parsed or resolved runbook steps
 * @param frontmatter - Parsed frontmatter for declared `inputs`; `null`/`undefined` tolerated
 *   (the `rd check` call site supplies `RunbookFrontmatter | null`)
 * @returns Static FOR-source facts
 */
export function analyzeForSources(
  steps: readonly (Step | ResolvedStep)[],
  frontmatter: RunbookFrontmatter | null | undefined,
): ForSourceFacts {
  const sourcedFors: SourcedForFact[] = [];
  for (const step of steps) {
    if (step.kind !== 'for') continue;
    // isResolvedForClause narrows ParsedForClause → ForClause (a no-op on the
    // already-resolved tier); isSourced then narrows to a data source.
    if (!isResolvedForClause(step.forClause) || !isSourced(step.forClause)) continue;
    let delegatedRefCount = 0;
    for (const sub of step.substeps) {
      if (sub.delegate === true) delegatedRefCount += sub.runbooks?.length ?? 0;
    }
    sourcedFors.push({ stepName: step.name, source: step.forClause.source, delegatedRefCount });
  }
  return {
    producedNames: collectProducedNames(steps),
    declaredInputs: new Set(frontmatter?.inputs ?? []),
    sourcedFors,
  };
}

/**
 * Derive non-fatal diagnostics from FOR-source facts: an unsatisfiable-source
 * warning and a shared-binding warning for multi-ref data-source FOR steps
 * (language spec §8.2, §10.4). These are SHOULD-level (`rd check`), never errors.
 *
 * @param facts - FOR-source facts from {@link analyzeForSources}
 * @returns Warning messages (empty when nothing to report)
 */
export function forSourceWarnings(facts: ForSourceFacts): string[] {
  const out: string[] = [];
  for (const f of facts.sourcedFors) {
    if (!facts.declaredInputs.has(f.source) && !facts.producedNames.has(f.source)) {
      out.push(
        `Step ${f.stepName}: FOR source "${f.source}" is neither a declared input nor produced by a step — ensure it is provided at runtime.`,
      );
    }
    if (f.delegatedRefCount > 1) {
      out.push(
        `Step ${f.stepName}: FOR "${f.source}" delegates ${String(f.delegatedRefCount)} references per iteration; the loop item is shared across all of them (not paired). Use a single delegated reference for per-item-per-worker.`,
      );
    }
  }
  return out;
}
