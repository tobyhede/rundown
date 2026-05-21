import { classifyExpandedArtifactToken, type Runbook } from '@rundown-org/parser';

/**
 * Extract static relative file-reference tokens from a parsed runbook's
 * ARTIFACTS declarations.
 *
 * The extractor delegates token classification to the parser and returns only
 * path-like relative file references that can be staged hermetically before
 * execution. Managed artifact keys, wildcard selectors, `rd://` literals,
 * absolute paths, templated tokens, invalid tokens, and naked declarations are
 * ignored.
 *
 * @param runbook - Parsed runbook AST to inspect
 * @returns Deduplicated relative file-reference tokens in source order
 * @throws {Error} When the runbook contains an unsupported step kind
 */
export function extractFileArtifactReferences(runbook: Runbook): readonly string[] {
  const seen = new Set<string>();
  const references: string[] = [];

  for (const step of runbook.steps) {
    collectArtifactReferences(step.artifacts, seen, references);
    switch (step.kind) {
      case 'base':
      case 'command':
        break;
      case 'for':
      case 'substeps':
        for (const substep of step.substeps) {
          collectArtifactReferences(substep.artifacts, seen, references);
        }
        break;
      default: {
        const unexpected = step as { readonly kind?: unknown };
        throw new Error(
          `Unexpected runbook step kind while extracting artifact references: ${String(unexpected.kind)}`,
        );
      }
    }
  }

  return references;
}

function collectArtifactReferences(
  artifacts: Runbook['steps'][number]['artifacts'],
  seen: Set<string>,
  references: string[],
): void {
  if (!artifacts) return;

  for (const artifact of artifacts) {
    const rawToken = artifact.rawToken;
    if (rawToken === null) continue;

    const classification = classifyExpandedArtifactToken(rawToken);
    if (!classification.ok || classification.token.kind !== 'rel-path') continue;

    const reference = classification.token.path;
    if (seen.has(reference)) continue;
    seen.add(reference);
    references.push(reference);
  }
}
