/**
 * Preparing a Child Run's runbook (#903, #904): the frontend's service.
 *
 * Core reserves, creates, drives and Collects Child Runs; resolving the child
 * runbook reference, reading and parsing its file, and resolving its variables
 * under the frontend's policy is a Category C dependency injected into core.
 * An Inline Child and a Delegation are prepared by the same service, so the
 * two resolve a child runbook on one code path.
 *
 * @module runbook/child-preparation
 */

import type { OutputDeclaration } from '@rundown-org/parser';
import type { VariableValue } from './effective-vars.js';
import type { RunbookRef } from './runbook-ref.js';
import type {
  ChildReservation,
  ContextSnapshot,
  ResolvedRunbook,
  RunbookState,
  TemplateVarValue,
} from './types.js';

/** What the frontend is asked to prepare for one Child Run. */
export interface ChildRunPreparationRequest {
  /** The parent run, as core read it. */
  readonly parent: RunbookState;
  /** The reservation the child is created under. */
  readonly reservation: ChildReservation;
  /**
   * The context the child inherits — the parent's variables, step position and
   * FOR iteration binding. An Inline Child's is read from the parent row at
   * launch; a Delegation's was captured on its reservation.
   */
  readonly contextSnapshot: ContextSnapshot;
}

/**
 * A child runbook prepared for creation, or why it could not be.
 *
 * `prepared` carries everything the state manager needs to create the child
 * beyond the id and linkage core already holds.
 */
export type PreparedChildRun =
  | {
      readonly kind: 'prepared';
      /** Canonical identity of the resolved child runbook. */
      readonly runbookRef: RunbookRef;
      /** The parsed, variable-substituted child runbook. */
      readonly runbook: ResolvedRunbook;
      /** Repo-relative path of the child runbook file. */
      readonly runbookPath: string;
      /** The child runbook's source, frozen at creation. */
      readonly runbookSrc: string;
      /** The child's merged template variables. */
      readonly templateVars: Readonly<Record<string, TemplateVarValue>>;
      /** Runtime variables seeded into the child (artifact inputs, inherited outputs). */
      readonly initialVariables: Readonly<Record<string, VariableValue>>;
      /** The child's frontmatter `outputs:` declarations. */
      readonly frontmatterOutputs: readonly OutputDeclaration[];
    }
  | {
      readonly kind: 'refused';
      /** Stable diagnostic code (a preparation failure's own code). */
      readonly code: string;
      /** Operator-facing message. */
      readonly message: string;
    };

/**
 * The frontend service that prepares a child runbook: resolving the reference,
 * reading and parsing the file, and resolving its variables from the request's
 * `contextSnapshot`. Injected into Run Progression (Inline Children) and
 * `claimDelegation` (Delegations).
 */
export type PrepareChildRun = (request: ChildRunPreparationRequest) => Promise<PreparedChildRun>;
