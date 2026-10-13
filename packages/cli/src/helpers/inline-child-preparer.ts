/**
 * The CLI's preparation of an Inline Child runbook for launch (#903).
 *
 * Core reserves, creates, drives and Collects an Inline Child; preparing its
 * runbook is the frontend's service (Category C): resolving the reference
 * through runbook discovery, reading and parsing the file, and resolving its
 * variables — under this process's policy — from the reservation's context
 * snapshot. This is the same preparation `rundown run` applies to a root
 * runbook, so a child resolves its inputs exactly as it would run standalone,
 * plus what it inherits from its parent.
 *
 * @module helpers/inline-child-preparer
 */

import * as path from 'node:path';
import {
  extractInheritedUserVars,
  reconstituteContextVars,
  type PrepareInlineChild,
} from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';
import { prepareRunnableRunbook } from './runbook-pipeline.js';

/**
 * Build the preparer core calls for each Inline Child launch.
 *
 * Preparation warnings (unresolved variables and the like) are rendered on the
 * command's output as they are for `rundown run`.
 *
 * @param cwd - Project directory the child runbook resolves against.
 * @param output - The command's output emitter, for preparation warnings.
 * @returns The preparer.
 */
export function createInlineChildPreparer(cwd: string, output: OutputEmitter): PrepareInlineChild {
  return async ({ reservation }) => {
    const snapshot = reservation.contextSnapshot;
    const prepared = await prepareRunnableRunbook(reservation.runbook, {}, cwd, {
      runId: reservation.runId,
      inheritedContextVars: reconstituteContextVars(snapshot),
      inheritedUserVars: extractInheritedUserVars(snapshot),
      ...(snapshot.iterationBinding !== undefined
        ? { iterationBinding: snapshot.iterationBinding }
        : {}),
    });
    if (!prepared.ok) {
      return { kind: 'refused', code: prepared.code, message: prepared.error };
    }
    for (const warning of prepared.warnings ?? []) {
      output.warning(warning);
    }
    for (const name of prepared.unresolved) {
      output.warning(`Undefined variable "{{${name}}}" preserved as literal text`);
    }
    const child = prepared.prepared;
    return {
      kind: 'prepared',
      runbookRef: child.runbookRef,
      runbook: child.runbook,
      runbookPath: path.relative(cwd, child.filePath),
      runbookSrc: child.rawContent,
      templateVars: child.mergedVariables,
      initialVariables: child.runtimeVars,
      frontmatterOutputs: child.frontmatter?.outputs ?? [],
    };
  };
}
