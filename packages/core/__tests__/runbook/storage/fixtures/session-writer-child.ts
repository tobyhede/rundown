// Test-only worker: a REAL separate OS process that drives the REAL
// `SessionService` against a project's `.rundown/rundown.db`.
//
// Why a child process at all: `RunbookStateManager` resolves its store through a
// process-level, path-keyed registry (`storage/store-registry.ts`), so two
// managers on the same cwd IN THE SAME PROCESS share one driver and their writes
// serialize on that driver's in-process transaction sequencing. An "in-process
// race" therefore proves nothing about the guarantee the retired `SessionLock`
// existed to provide. Genuine multi-writer contention needs separate OS
// processes holding separate SQLite connections — which is what this fixture is.
//
// Why the real service and not hand-written SQL: the property under test is that
// `SessionService`'s `mutateSession` read-modify-write cycle is atomic. Imitating
// its SQL in the child would pin the imitation, not the production logic.
// The child is TypeScript and is launched with `node --import tsx` so it executes
// `src/runbook/session-service.ts` itself.
//
// Protocol (barrier-synchronized, no sleeps):
//   1. Construct the service and WARM the store (open the driver, ensure schema,
//      read the session) so post-barrier work is the mutation and nothing else.
//   2. Write `readyFile` — "I am warm and parked at the barrier".
//   3. Spin on `goFile` until the parent releases every child together.
//   4. Run exactly one session mutation.
//   5. Write `resultFile` as JSON: `{ ok: true, value }` or `{ ok: false, error }`.
//
// Invoked as:
//   node --import tsx session-writer-child.ts <cwd> <readyFile> <goFile> <resultFile> <opJson>

import { existsSync, writeFileSync } from 'node:fs';
import { RunbookStateManager } from '../../../../src/runbook/state.js';
import { SessionService } from '../../../../src/runbook/session-service.js';
import { closeRunbookStores } from '../../../../src/runbook/storage/store-registry.js';
import { assertClaimId } from '../../../../src/runbook/claim-id.js';
import { assertRunId } from '../../../../src/runbook/run-id.js';
import type { DelegationLinkage } from '../../../../src/runbook/types.js';
import { getErrorMessage } from '../../../../src/errors.js';

/** One session mutation for the child to perform after the barrier releases. */
type ChildOp =
  | { readonly kind: 'issueRunControlClaim'; readonly runId: string }
  | {
      readonly kind: 'claimRunbook';
      readonly childRunId: string;
      readonly linkage: DelegationLinkage;
    }
  | { readonly kind: 'pushRunbook'; readonly runId: string }
  | { readonly kind: 'recordClaimSeen'; readonly claimId: string }
  | { readonly kind: 'releaseRunbook'; readonly runId: string }
  | { readonly kind: 'popRunbook' };

const [cwd, readyFile, goFile, resultFile, opJson] = process.argv.slice(2);
const op = JSON.parse(opJson) as ChildOp;

/**
 * Perform the child's single session mutation through the real service.
 *
 * @param service - Session service bound to the project under test.
 * @returns The mutation's result, serialized into the result file by the caller.
 */
async function run(service: SessionService): Promise<unknown> {
  switch (op.kind) {
    case 'issueRunControlClaim':
      return service.issueRunControlClaim(assertRunId(op.runId));
    case 'claimRunbook':
      return service.claimRunbook(assertRunId(op.childRunId), op.linkage);
    case 'pushRunbook':
      return service.pushRunbook(assertRunId(op.runId));
    case 'recordClaimSeen':
      return service.recordClaimSeen(assertClaimId(op.claimId));
    case 'releaseRunbook':
      return service.releaseRunbook(assertRunId(op.runId));
    case 'popRunbook':
      return service.popRunbook();
  }
}

const manager = new RunbookStateManager(cwd);
const service = new SessionService(manager);

// Warm the driver: opens the connection and ensures the schema, so the only work
// left after the barrier is the mutation itself. Without this, process/driver
// startup would dominate and the children would not actually overlap.
await manager.loadSession();

writeFileSync(readyFile, String(process.pid));

// Busy-wait on the barrier. Deliberately a tight spin rather than a polled sleep:
// the whole point is that every child enters its mutation within the same few
// milliseconds, and a sleep interval would quantize (and thereby stagger) them.
while (!existsSync(goFile)) {
  // spin
}

try {
  const value = await run(service);
  writeFileSync(resultFile, JSON.stringify({ ok: true, value }));
} catch (error: unknown) {
  writeFileSync(resultFile, JSON.stringify({ ok: false, error: getErrorMessage(error) }));
}

await closeRunbookStores();
