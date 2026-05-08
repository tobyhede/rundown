import type { ArtifactDeclaration } from '@rundown-org/parser';
import type { RunbookStateManager } from './state.js';
import type { RunbookActorService } from './actor-service.js';
import {
  resolveArtifactDeclarations,
  type ArtifactRunEligibility,
} from './artifact-directive-resolver.js';
import { assertRunId, type RunId } from './run-id.js';
import { resolveCurrentExecutionUnit } from './execution-units.js';
import type { ArtifactVarValue, ResolvedStep, RunbookState } from './types.js';

/**
 * Successful resolution result for the current execution unit.
 */
export interface ArtifactRuntimeResolved {
  readonly status: 'resolved';
  readonly state: RunbookState;
  readonly snapshot: unknown;
  readonly artifacts: Readonly<Record<string, ArtifactVarValue>>;
}

/**
 * Result returned when the runbook id has no persisted state, e.g. after
 * deletion or pruning.
 */
export interface ArtifactRuntimeMissingRun {
  readonly status: 'missing-run';
}

export type ArtifactRuntimeResult = ArtifactRuntimeResolved | ArtifactRuntimeMissingRun;

/**
 * Core-owned runtime orchestration for ARTIFACTS directives.
 *
 * Resolves declarations for the active execution unit and dispatches the
 * resulting working set through the XState machine via
 * {@link RunbookActorService.sendAndSync}. The CLI must use this service
 * instead of mutating artifact fields directly.
 */
export class ArtifactRuntimeService {
  /**
   * Create a new artifact runtime service.
   *
   * @param manager - Runbook persistence manager
   * @param actorService - Actor service used to dispatch typed machine events
   */
  constructor(
    private readonly manager: RunbookStateManager,
    private readonly actorService: RunbookActorService,
  ) {}

  /**
   * Resolve ARTIFACTS declarations for the currently active execution unit.
   *
   * Loads the persisted state, locates the active step or substep, resolves
   * ARTIFACTS declarations against the manifest, then dispatches the result
   * through the machine so current-unit and accumulated artifact state stay in
   * sync.
   *
   * Skips dispatch when the active unit has no declarations and persisted
   * `state.artifacts` is already `{}`. When a previous unit's working set is
   * still persisted, dispatches `{}` to clear current-unit artifacts while
   * preserving accumulated `artifactVars`.
   *
   * @param id - Active run id
   * @param steps - Resolved runbook steps used to locate the active unit
   * @returns Resolution result with updated state and current-unit artifacts
   * @throws {Error} When built-in variables required for artifact resolution
   *   are missing or when the active step cannot be located
   */
  async resolveCurrentUnitArtifacts(
    id: string,
    steps: readonly ResolvedStep[],
  ): Promise<ArtifactRuntimeResult> {
    const state = await this.manager.load(id);
    if (!state) return { status: 'missing-run' };

    const currentStep = steps.find((step) => step.name === state.step);
    if (!currentStep) {
      throw new Error(`Step '${state.step}' not found - possible state corruption`);
    }
    const unit = resolveCurrentExecutionUnit(currentStep, state.substep);
    const declarations = unit.artifacts ?? [];
    if (
      declarations.length === 0 &&
      state.artifacts !== undefined &&
      Object.keys(state.artifacts).length === 0
    ) {
      return { status: 'resolved', state, snapshot: undefined, artifacts: {} };
    }
    const artifacts = await this.resolveForState(state, declarations);
    const synced = await this.actorService.sendAndSync(id, [...steps], {
      type: 'ARTIFACTS_RESOLVED',
      artifacts,
    });
    if (!synced) return { status: 'missing-run' };

    return {
      status: 'resolved',
      state: synced.state,
      snapshot: synced.snapshot,
      artifacts,
    };
  }

  private async resolveForState(
    state: RunbookState,
    declarations: readonly ArtifactDeclaration[],
  ): Promise<Readonly<Record<string, ArtifactVarValue>>> {
    if (declarations.length === 0) {
      return {};
    }

    const workPath = state.templateVars?.WorkPath;
    const contextId = state.templateVars?.ContextId;
    if (typeof workPath !== 'string') {
      throw new Error(`Runbook ${state.id} cannot resolve ARTIFACTS without string WorkPath`);
    }
    if (typeof contextId !== 'string') {
      throw new Error(`Runbook ${state.id} cannot resolve ARTIFACTS without string ContextId`);
    }

    const runId: RunId = assertRunId(state.id);
    return resolveArtifactDeclarations(declarations, {
      cwd: this.manager.cwd,
      workPath,
      contextId,
      runId,
      runbook: state.runbook,
      loadRunEligibility: async (otherRunId: RunId): Promise<ArtifactRunEligibility | null> => {
        const other = await this.manager.load(otherRunId);
        if (!other) return null;
        if (other.id === state.id) return null;
        if (other.lifecycle === 'completed' && other.updatedAt) {
          return { runId: otherRunId, terminalAt: other.updatedAt };
        }
        return null;
      },
    });
  }
}
