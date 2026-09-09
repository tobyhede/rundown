import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunbookActorService } from '../../src/runbook/actor-service.js';
import { commitRunProgressionEvent } from '../../src/runbook/run-progression.js';
import { mintRunProgressionAuthority } from '../../src/runbook/run-progression-authority.js';
import { SessionService } from '../../src/runbook/session-service.js';
import { RunbookStateManager, generateRunId } from '../../src/runbook/state.js';
import { closeRunbookStore } from '../../src/runbook/storage/store-registry.js';
import { unwrapSessionMutation } from '../../src/testing/session-fixtures.js';
import { createRunbook } from '../runbook/fixtures.js';

const WAITING_RUNBOOK = `## 1. Wait
- PASS COMPLETE
- FAIL STOP

Wait for input.
`;

let dir: string;
let manager: RunbookStateManager;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-regression-684-'));
  manager = new RunbookStateManager(dir);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await closeRunbookStore(dir);
  await fs.rm(dir, { recursive: true, force: true });
});

describe('issue #684: stale machine projections cannot overwrite terminal commits', () => {
  it('re-captures and re-derives a pure Run Progression event after a competing terminal commit', async () => {
    const steps = createRunbook(WAITING_RUNBOOK);
    const actorService = new RunbookActorService(manager);
    const runId = generateRunId();
    const created = await manager.create(
      { source: 'project', path: 'parent.runbook.md' },
      { title: 'Parent', description: '', steps },
      { runId, runbookPath: 'parent.runbook.md', frontmatterOutputs: [] },
    );
    await actorService.initializeState(created.id, steps);
    const session = new SessionService(manager);
    unwrapSessionMutation(await session.pushRunbookWithRunControlClaim(created.id));

    const realPrepare = actorService.prepareActorMutation.bind(actorService);
    let preparations = 0;
    let staleProjectionLifecycle: string | undefined;
    jest.spyOn(actorService, 'prepareActorMutation').mockImplementation(async (...args) => {
      const prepared = await realPrepare(...args);
      preparations += 1;
      if (preparations === 1) {
        staleProjectionLifecycle = prepared.nextState.lifecycle;
        // Land the competing terminal write after the first projection was
        // derived but before its fenced commit. The first save must lose its
        // CAS; the public seam must then re-read and re-derive.
        const competingAuthority = await manager.captureRunAuthorityState(created.id);
        if (competingAuthority.kind !== 'captured') {
          throw new Error(`competing authority refused: ${competingAuthority.kind}`);
        }
        const competingActor = new RunbookActorService(manager);
        const terminal = await competingActor.prepareActorMutation(
          created.id,
          competingAuthority.state,
          steps,
          { type: 'FAIL' },
        );
        const terminalCommit = await manager.saveState(
          competingAuthority.authority,
          terminal.nextState,
        );
        if (terminalCommit.kind !== 'committed') {
          throw new Error(`competing terminal commit refused: ${terminalCommit.kind}`);
        }
      }
      return prepared;
    });

    const result = await commitRunProgressionEvent(
      mintRunProgressionAuthority({ runId: created.id }),
      manager,
      actorService,
      steps,
      { type: 'INLINE_LAUNCH_CONSUMED' },
    );

    expect(result.kind).toBe('committed');
    expect(preparations).toBe(2);
    expect(staleProjectionLifecycle).toBe('running');
    expect((await manager.load(created.id))?.lifecycle).toBe('stopped');
  });

  it('does not expose the unsafe load-derive-write API', () => {
    const actorService = new RunbookActorService(manager);

    // @ts-expect-error #684: the stale-snapshot mutation API must remain absent.
    expect(actorService.sendAndSync).toBeUndefined();
    expect(actorService).not.toHaveProperty('sendAndSync');
  });
});
