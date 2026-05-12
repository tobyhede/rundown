import type { ArtifactDeclaration } from '@rundown-org/parser';
import { fromPromise } from 'xstate';
import {
  resolveArtifactDeclarations,
  type ArtifactScopeVars,
} from '../artifact-directive-resolver.js';
import type { RunbookRef } from '../runbook-ref.js';
import type { RunId } from '../run-id.js';
import type { ArtifactVarValue } from '../types.js';

/** Input shape for {@link artifactResolveActor}. */
export interface ArtifactResolveInput {
  /** ARTIFACTS declarations attached to the current execution unit. */
  readonly declarations: readonly ArtifactDeclaration[];
  /** Current process working directory supplied through the compile-time actor-input closure. */
  readonly cwd: string;
  /** Artifact work root, usually `.rundown/work`. */
  readonly workPath: string;
  /** Current Rundown context identifier. */
  readonly contextId: string;
  /** Current run identifier. */
  readonly runId: RunId;
  /** Resolved runbook identity for the current run. */
  readonly runbook: RunbookRef;
  /** Effective in-scope variables used by naked ARTIFACTS declarations. */
  readonly scopeVars: ArtifactScopeVars;
}

/** Output shape for {@link artifactResolveActor}. */
export interface ArtifactResolveOutput {
  /** Resolved artifact variables keyed by ARTIFACTS alias. */
  readonly variables: Record<string, ArtifactVarValue>;
}

/**
 * Machine-invoked actor that resolves one ARTIFACTS block.
 *
 * The actor owns no runbook state and performs no transition decisions. It
 * delegates resolution to `resolveArtifactDeclarations()` and lets the
 * compiler's `invoke.onDone` / `invoke.onError` branches update machine state.
 *
 * @param input - Current execution-unit declarations and runtime identity
 * @returns Resolved artifact variable map for this execution unit
 * @throws {Error} Propagates resolver failures so the machine can stop through
 *   the typed `ARTIFACT_RESOLUTION_FAILED` terminal path
 */
export const artifactResolveActor = fromPromise<ArtifactResolveOutput, ArtifactResolveInput>(
  async ({ input }) => {
    const variables = await resolveArtifactDeclarations(input.declarations, {
      cwd: input.cwd,
      workPath: input.workPath,
      contextId: input.contextId,
      runId: input.runId,
      runbook: input.runbook,
      scopeVars: input.scopeVars,
    });
    return { variables };
  },
);
