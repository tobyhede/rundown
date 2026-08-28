import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { RunbookActorService, type AnyActorRef } from '../../src/runbook/actor-service.js';
import type { ResolvedStep } from '../../src/runbook/types.js';
import { createRunbook } from '../runbook/fixtures.js';

let dir: string;
let manager: RunbookStateManager;
let actorService: RunbookActorService;
let steps: ResolvedStep[];

const TWO_STEP_CONTINUE = `## 1. First
- PASS CONTINUE
- FAIL STOP

## 2. Second
- PASS COMPLETE
- FAIL STOP
`;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-regression-684-'));
  manager = new RunbookStateManager(dir);
  actorService = new RunbookActorService(manager);
  steps = createRunbook(TWO_STEP_CONTINUE);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('issue #684: sendAndSync must not revert a concurrently committed terminal', () => {
  it('preserves a concurrently committed terminal lifecycle across sendAndSync’s stale re-derivation', async () => {
    const state = await manager.create(
      { source: 'project', path: 'test.runbook.md' },
      { title: 'Test', description: '', steps },
      { runbookPath: 'test.runbook.md', frontmatterOutputs: [] },
    );

    // `sendAndSync` loads its own actor snapshot at the top of the call and
    // derives its persistence patch from THAT snapshot alone. Between the
    // load and the eventual `manager.update` commit, `waitForMachineEffects`
    // is the awaited gap the issue identifies as the open window. Wrap it so
    // a second writer can land a committed terminal lifecycle inside that
    // window, deterministically, without racing real processes.
    const proto = actorService as unknown as {
      waitForMachineEffects: (actor: AnyActorRef) => Promise<void>;
    };
    const original = proto.waitForMachineEffects.bind(actorService);
    jest.spyOn(proto, 'waitForMachineEffects').mockImplementation(async (actor) => {
      await original(actor);
      // A concurrent writer (e.g. a competing sendAndSync/completion path)
      // commits a terminal lifecycle first, through the same real API.
      await manager.update(state.id, { lifecycle: 'completed' });
    });

    // Step 1's PASS is a non-terminal CONTINUE: `deriveActorStatePatch`
    // derives `lifecycle: 'running'` unconditionally from the actor's own
    // (stale) snapshot, ignoring whatever the store now holds.
    await actorService.sendAndSync(state.id, steps, { type: 'PASS' });

    const loaded = await manager.load(state.id);

    // CORRECT behavior (issue #684): a stale derivation must never revert a
    // committed terminal. Today the stale 'running' patch is re-applied
    // verbatim on top of the freshly-read 'completed' row, so this fails
    // with lifecycle 'running' where 'completed' was expected.
    expect(loaded?.lifecycle).toBe('completed');
  });
});
