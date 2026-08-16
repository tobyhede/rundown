// The wire contract between `session-service.process.test.ts` (parent) and
// `session-writer-child.ts` (spawned worker).
//
// Both halves live in separate OS processes and talk over JSON in argv and result
// files, so TypeScript cannot check one against the other. Declaring these types
// twice — which is what this file replaces — made that gap silent: adding a
// variant on one side and forgetting the other produced no compile error at all.
//
// One definition, imported by both sides, is what makes the contract checkable.
// It is necessary but not sufficient: the parent constructs ops against this union
// so TypeScript checks that side, while the child re-parses JSON off argv, where
// no static guarantee survives. The child's `default:` arm closes that half with a
// `never` assignment, so a variant added here and unhandled there is a compile
// error rather than a `run` that returns `undefined` and is recorded as success.

import type { DelegationLinkage } from '../../../../src/runbook/types.js';

/** One session mutation for a child process to perform after the barrier releases. */
export type ChildOp =
  /**
   * Open the store from COLD and read the session.
   *
   * The only op the child does not warm the store for. Every other op wants the
   * driver already open at the barrier so the measured window holds the mutation
   * and nothing else; this one's subject IS the open — creating the database file,
   * converting it to WAL, and installing the schema — so warming it would move the
   * whole subject before the barrier and leave the race asserting nothing.
   */
  | { readonly kind: 'coldStartSession' }
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
  /**
   * The conditional pop, which names the run it may remove.
   *
   * Distinct from `popRunbook` in exactly the way the race cares about: the
   * positional form pops whatever the transaction finds on top, so a contender
   * that pushed first has its own run removed instead.
   */
  | { readonly kind: 'popRunbookIfActive'; readonly runId: string }
  | {
      readonly kind: 'guardedParentAdvance';
      readonly parentRunId: string;
      readonly linkage: DelegationLinkage;
      readonly callbackReadyFile: string;
      readonly callbackGoFile: string;
    };

/**
 * A child's reported outcome, as written to its result file. `t0`/`t1` bracket
 * the actual mutation after the second-stage release, `tEntered` records when
 * the child entered that staging barrier, `tTransactionHeld` records when the
 * designated holder entered its real transaction (null for contenders), and
 * `pid` names the writer. The epoch timestamps carry on BOTH arms so the
 * concurrency witness can read them without narrowing on `ok`.
 */
export type ChildResult =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly t0: number;
      readonly tEntered: number;
      readonly tTransactionHeld: number | null;
      readonly t1: number;
      readonly pid: number;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly t0: number;
      readonly tEntered: number;
      readonly tTransactionHeld: number | null;
      readonly t1: number;
      readonly pid: number;
    };
