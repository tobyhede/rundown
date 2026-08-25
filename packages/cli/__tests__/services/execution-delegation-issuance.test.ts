// packages/cli/__tests__/services/execution-delegation-issuance.test.ts
//
// The capability hand-off `runExecutionLoop` performs when a COMMAND step's
// transition lands the cursor on a DELEGATE frontier, driven through REAL core
// services against a temp project dir.
//
// The loop passes `{ issueDelegationCredential: options.delegationRuntime?.… }`
// as the runtime argument of the fenced `prepareActorMutation` for
// EXECUTE_COMMAND. That argument is the ONLY route by which the verified issuer
// reaches `delegationIssueActor`, which the machine invokes in the very same
// mutation when the command's transition enters a DELEGATE step. Replacing the
// argument with `{}` leaves the machine with no issuer, so issuance refuses
// `reason: 'actor_context_required'` instead of minting — a silently broken
// capability hand-off that no mocked-runner test can see, because the mocked
// suite never drives a real machine across that transition.
//
// Sibling of `execution-recovery-actor.test.ts` for the same reason: a real
// issuer cannot exist in a suite that replaces `@rundown-org/core` wholesale,
// and `DelegationRuntimeCapabilities` is branded by a module-private symbol
// whose only producer lives inside core.

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateRunId,
  RunbookActorService,
  RunbookStateManager,
  SessionService,
  type CommandExecutionServices,
  type DelegationRuntimeCapabilities,
  type ExecutionEventEmitter,
  type RunbookState,
} from '@rundown-org/core';
import { parseRunbookDocument, type ResolvedStep } from '@rundown-org/parser';
import { runExecutionLoop } from '../../src/services/execution.js';

const CHILD_REF = 'child.runbook.md';

const PARENT_MARKDOWN = `# Delegating Parent

## 1. Do the work

- PASS CONTINUE
- FAIL STOP

\`\`\`sh
echo hello
\`\`\`

## 2. Fan out

- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

### 2.1 Task A

- ${CHILD_REF}

## 3. Done

- PASS COMPLETE
- FAIL STOP
`;

const CHILD_MARKDOWN = `# Child

## 1. Work

- PASS COMPLETE
- FAIL STOP
`;

/** Structural emitter double: the loop only ever calls `emit`. */
type EmittedEvent = { type: string; payload?: Record<string, unknown> };

/** A delegate frontier entry as it reaches a STEP_ENTERED payload. */
type FrontierEntry = { id: string; runbook: string; token?: string };

/** Command runner that never spawns: this suite is about the transition, not the shell. */
const passingCommandServices: CommandExecutionServices = {
  runExternalCommand: () => Promise.resolve({ success: true, exitCode: 0 }),
};

let cwd: string;
let manager: RunbookStateManager;
let actorService: RunbookActorService;
let sessionService: SessionService;
let steps: ResolvedStep[];
let emitted: EmittedEvent[];
let emitter: ExecutionEventEmitter;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'rd-exec-delegate-'));
  manager = new RunbookStateManager(cwd);
  actorService = new RunbookActorService(manager, {
    commandServices: passingCommandServices,
    // The front-end resolver contract: resolve to `null` on failure, never
    // reject. Resolving directly rather than through CLI discovery keeps the
    // test about the issuer hand-off instead of about runbook lookup.
    resolveDelegationRunbook: (runbookRef) =>
      Promise.resolve(
        runbookRef === CHILD_REF
          ? {
              path: join(cwd, CHILD_REF),
              runbookRef,
              childRunbookRef: { source: 'project', path: CHILD_REF },
            }
          : null,
      ),
  });
  sessionService = new SessionService(manager);
  const { runbook } = parseRunbookDocument(PARENT_MARKDOWN, 'parent.runbook.md');
  steps = runbook.steps as ResolvedStep[];
  emitted = [];
  emitter = {
    emit: (event: EmittedEvent) => {
      emitted.push(event);
    },
  } as unknown as ExecutionEventEmitter;
  await writeFile(join(cwd, CHILD_REF), CHILD_MARKDOWN);
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/**
 * Create the parent run, initialise its machine, and mint the run-control
 * bearer whose branded capability pair the loop is handed.
 *
 * @returns The seeded run state and its verified delegation capabilities.
 */
async function seedParent(): Promise<{
  state: RunbookState;
  delegationRuntime: DelegationRuntimeCapabilities;
}> {
  // Generated up front so `RunId` can be seeded into the run's own template
  // vars — ARTIFACTS resolution inside the command actor requires it, exactly
  // as the real run pipeline seeds it.
  const runId = generateRunId();
  const created = await manager.create(
    { source: 'project', path: 'parent.runbook.md' },
    { title: 'Delegating Parent', description: 'A test', steps: [...steps] },
    {
      runId,
      runbookPath: 'parent.runbook.md',
      templateVars: {
        RunId: runId,
        RunbookRef: { source: 'project', path: 'parent.runbook.md' },
        ContextId: 'ctx-delegate',
        WorkPath: '.rundown/work',
      },
    },
  );
  await actorService.initializeState(created.id, steps);
  // The real producer, not a branded double: the issuer that mints the
  // credential and the deriver that later discloses its bearer must come from
  // one authority, and only `issueRunControlClaim` can hand out that pair.
  const claim = await sessionService.issueRunControlClaim(created.id);
  if (claim.kind !== 'committed') throw new Error(`claim refused: ${claim.kind}`);
  const stored = await manager.load(created.id);
  if (stored === null) throw new Error('seed failed');
  return { state: stored, delegationRuntime: claim.value.delegationRuntime };
}

/**
 * Every frontier entry disclosed through a STEP_ENTERED payload.
 *
 * @returns The disclosed entries, in emission order.
 */
function disclosedFrontier(): FrontierEntry[] {
  return emitted
    .filter((event) => event.type === 'STEP_ENTERED')
    .flatMap((event) => (event.payload?.delegateFrontier ?? []) as FrontierEntry[]);
}

describe('runExecutionLoop command transition into a DELEGATE frontier', () => {
  it('issues the frontier credential under the loop-supplied verified authority', async () => {
    const { state, delegationRuntime } = await seedParent();

    const result = await runExecutionLoop(manager, state.id, steps, cwd, emitter, {
      actorService,
      commandServices: passingCommandServices,
      delegationRuntime,
    });

    // The DELEGATE substep carries no command, so the loop parks on it.
    expect(result.status).toBe('waiting');

    // Issuance happened inside the fenced EXECUTE_COMMAND mutation, under the
    // issuer the loop forwarded. With `{}` in its place the machine has no
    // issuer and `delegationIssueActor` refuses `actor_context_required`,
    // which lands as a DELEGATION_ISSUANCE_FAILED stop instead.
    const after = await manager.load(state.id);
    expect(after?.lastAction?.type).not.toBe('DELEGATION_ISSUANCE_FAILED');
    const delegated = after?.substepStates?.find((substep) => substep.delegation !== undefined);
    expect(delegated?.delegation).toEqual(
      expect.objectContaining({ childRunbookPath: join(cwd, CHILD_REF) }),
    );

    // ...and the same authority's deriver reproduced the bearer on the turn
    // that entered the frontier, so the credential is genuinely usable rather
    // than merely persisted.
    const frontier = disclosedFrontier();
    expect(frontier).toHaveLength(1);
    expect(frontier[0]).toEqual(
      expect.objectContaining({ id: '2.1', token: expect.stringMatching(/^rdtk_/) }),
    );

    expect(emitted.filter((event) => event.type === 'ERROR_OCCURRED')).toEqual([]);
  });
});
