/**
 * The CLI's preparation of a Child Run's runbook (#903, #904).
 *
 * Core reserves, creates, drives and Collects Child Runs; preparing a child's
 * runbook is the frontend's service (Category C): resolving the reference
 * through runbook discovery, reading and parsing the file, and resolving its
 * variables — under this process's policy — from the context snapshot core
 * hands over. This is the same preparation `rundown run` applies to a root
 * runbook, so a child resolves its inputs exactly as it would run standalone,
 * plus what it inherits from its parent. An Inline Child's launch and a
 * Delegation's `rundown claim` both prepare through here, so the two resolve
 * a child runbook reference on one code path.
 *
 * @module helpers/child-run-preparer
 */

import * as path from 'node:path';
import {
  extractInheritedUserVars,
  reconstituteContextVars,
  type PrepareChildRun,
} from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';
import { prepareRunnableRunbook } from './runbook-pipeline.js';

/**
 * Build the preparer core calls for each Inline Child launch and each
 * Delegation claim.
 *
 * Preparation warnings (unresolved variables and the like) are rendered on the
 * command's output as they are for `rundown run`.
 *
 * @param cwd - Project directory the child runbook resolves against.
 * @param output - The command's output emitter, for preparation warnings.
 * @returns The preparer.
 */
export function createChildRunPreparer(cwd: string, output: OutputEmitter): PrepareChildRun {
  return async ({ reservation, contextSnapshot: snapshot }) => {
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
