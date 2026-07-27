// The wire contract between `session-service.process.test.ts` (parent) and
// `session-writer-child.ts` (spawned worker).
//
// Both halves live in separate OS processes and talk over JSON in argv and result
// files, so TypeScript cannot check one against the other. Declaring these types
// twice — which is what this file replaces — made that gap silent: adding a
// variant on one side and forgetting the other produced no compile error, only a
// child exiting non-zero with an opaque message from a `default:` arm.
//
// One definition, imported by both sides, is the only thing that makes the
// contract checkable at all.

import type { DelegationLinkage } from '../../../../src/runbook/types.js';

/** One session mutation for a child process to perform after the barrier releases. */
export type ChildOp =
  | { readonly kind: 'issueRunControlClaim'; readonly runId: string }
  | {
      readonly kind: 'claimRunbook';
      readonly childRunId: string;
      readonly linkage: DelegationLinkage;
    }
  | { readonly kind: 'pushRunbook'; readonly runId: string }
  | { readonly kind: 'recordClaimSeen'; readonly claimId: string }
  | { readonly kind: 'releaseRunbook'; readonly runId: string }
  | { readonly kind: 'popRunbook' }
  | {
      readonly kind: 'guardedParentAdvance';
      readonly parentRunId: string;
      readonly linkage: DelegationLinkage;
      readonly callbackReadyFile: string;
      readonly callbackGoFile: string;
    };

/**
 * A child's reported outcome, as written to its result file. `t0`/`t1` bracket
 * the mutation window (epoch ms) and `pid` names the writer; they carry on BOTH
 * arms so the overlap witness can read them without narrowing on `ok`.
 */
export type ChildResult =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly t0: number;
      readonly t1: number;
      readonly pid: number;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly t0: number;
      readonly t1: number;
      readonly pid: number;
    };
