import type { ArtifactDeclaration } from '@rundown-org/parser';
import { fromPromise } from 'xstate';
import {
  resolveArtifactDeclarations,
  type ArtifactScopeVars,
} from '../artifact-directive-resolver.js';
import type { TrustedArtifactValue } from '../effective-vars.js';
import type { RunbookRef } from '../runbook-ref.js';
import type { RunId } from '../run-id.js';

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
  /** Additional roots searched for relative file artifact references. */
  readonly fileArtifactSearchRoots?: readonly string[];
  /** Read-policy gate for explicit absolute file artifact references. */
  readonly allowFileArtifactRead?: (filePath: string) => boolean;
}

/** Output shape for {@link artifactResolveActor}. */
export interface ArtifactResolveOutput {
  /**
   * Resolved artifact variables keyed by ARTIFACTS alias.
   *
   * Typed as {@link TrustedArtifactValue} so the brand minted by
   * `resolveArtifactDeclarations` survives the XState `onDone` event boundary
   * at the type level. The runtime brand is non-enumerable and travels by
   * reference; this type keeps that invariant visible at the actor seam.
   */
  readonly variables: Record<string, TrustedArtifactValue>;
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
      fileArtifactSearchRoots: input.fileArtifactSearchRoots,
      allowFileArtifactRead: input.allowFileArtifactRead,
    });
    return { variables };
  },
);
