import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { runsDir as _runsDir } from '../../src/paths.js';
import { DelegationScanService } from '../../src/runbook/delegation-scan.js';
import {
  hashDelegationToken,
  generateDelegationToken,
} from '../../src/runbook/delegation-token.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { RunbookState, StepDelegation, DelegationLinkage } from '../../src/runbook/types.js';
import { brandStoredOutputsForTest, brandEffectiveVarsForTest } from '../helpers/effective-vars.js';

const PARENT_RUN_ID = 'wf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_RUN_ID = 'wf_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CHILD_RUN_ID = 'wf_cccccccccccccccccccccccccccccccc';
const CHILD_RUN_ID_1 = 'wf_dddddddddddddddddddddddddddddddd';
const CHILD_RUN_ID_2 = 'wf_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const TARGET_RUN_ID = 'wf_ffffffffffffffffffffffffffffffff';

describe('DelegationScanService', () => {
  let tmpDir: string;
  let manager: RunbookStateManager;
  let scanner: DelegationScanService;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-scan-'));
    manager = new RunbookStateManager(tmpDir);
    scanner = new DelegationScanService(manager);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Write a state file directly to bypass schema validation. */
  async function writeState(state: RunbookState): Promise<void> {
    const stateDir = _runsDir(tmpDir);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, `${state.id}.json`), JSON.stringify(state, null, 2), {
      mode: 0o600,
    });
  }

  function makeState(id: string, overrides: Partial<RunbookState> = {}): RunbookState {
    return {
      id,
      runbook: { source: 'project', path: 'parent.runbook.md' },
      step: '1',
      stepName: 'Main step',
      retryCount: 0,
      variables: brandStoredOutputsForTest({}),
      steps: [{ id: '1', status: 'running' }],
      startedAt: '2026-02-27T10:00:00.000Z',
      updatedAt: '2026-02-27T10:00:00.000Z',
      lifecycle: 'running',
      schemaVersion: 2,
      ...overrides,
    };
  }

  function makeDelegation(token: string): StepDelegation {
    return {
      tokenHash: hashDelegationToken(token),
      childRunbookPath: 'child.md',
      contextSnapshot: { vars: brandEffectiveVarsForTest({ env: 'staging' }), ancestors: [] },
      childRunId: null,
      createdAt: '2026-02-27T10:00:00.000Z',
      cancelledAt: null,
    };
  }

  describe('findByToken', () => {
    it('returns match when token exists in substepStates', async () => {
      const token = generateDelegationToken();
      const delegation = makeDelegation(token);

      const state = makeState(PARENT_RUN_ID, {
        substepStates: [
          { id: '1', frameKey: buildFrameKey('1'), status: 'pending', delegation },
          { id: '2', frameKey: buildFrameKey('1'), status: 'pending' },
        ],
      });
      await writeState(state);

      const result = await scanner.findByToken(token);

      expect(result).not.toBeNull();
      expect(result!.parentState.id).toBe(PARENT_RUN_ID);
      expect(result!.substepId).toBe('1');
      expect(result!.delegation.tokenHash).toBe(delegation.tokenHash);
    });

    it('returns null when token not found', async () => {
      const token = generateDelegationToken();

      // Write a state with a different token
      const otherToken = generateDelegationToken();
      const state = makeState(OTHER_RUN_ID, {
        substepStates: [
          {
            id: '1',
            frameKey: buildFrameKey('1'),
            status: 'pending',
            delegation: makeDelegation(otherToken),
          },
        ],
      });
      await writeState(state);

      const result = await scanner.findByToken(token);
      expect(result).toBeNull();
    });

    it('returns null when no states exist', async () => {
      const token = generateDelegationToken();
      const result = await scanner.findByToken(token);
      expect(result).toBeNull();
    });

    it('returns stepId from contextSnapshot, not current state.step', async () => {
      const token = generateDelegationToken();
      const delegation = {
        ...makeDelegation(token),
        contextSnapshot: { vars: brandEffectiveVarsForTest({}), ancestors: [], step: '1' },
      };

      const state = makeState(PARENT_RUN_ID, {
        step: '3',
        substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'pending', delegation }],
      });
      await writeState(state);

      const result = await scanner.findByToken(token);

      expect(result).not.toBeNull();
      expect(result!.stepId).toBe('1');
    });

    it('falls back to state.step when contextSnapshot.step is undefined', async () => {
      const token = generateDelegationToken();
      const delegation = {
        ...makeDelegation(token),
        contextSnapshot: { vars: brandEffectiveVarsForTest({}), ancestors: [] },
      };

      const state = makeState(PARENT_RUN_ID, {
        step: '3',
        substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'pending', delegation }],
      });
      await writeState(state);

      const result = await scanner.findByToken(token);

      expect(result).not.toBeNull();
      expect(result!.stepId).toBe('3');
    });
  });

  describe('findOrphanedChild', () => {
    it('returns orphaned child run with matching tokenHash', async () => {
      const token = generateDelegationToken();
      const tokenHash = hashDelegationToken(token);

      const linkage: DelegationLinkage = {
        kind: 'delegation' as const,
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1',
        tokenHash,
      };

      const childState = makeState(CHILD_RUN_ID, {
        parentLinkage: linkage,
      });
      await writeState(childState);

      const result = await scanner.findOrphanedChild(tokenHash);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(CHILD_RUN_ID);
    });

    it('returns null when no orphaned child exists', async () => {
      const token = generateDelegationToken();
      const tokenHash = hashDelegationToken(token);

      // Write an unrelated state
      const state = makeState(OTHER_RUN_ID);
      await writeState(state);

      const result = await scanner.findOrphanedChild(tokenHash);
      expect(result).toBeNull();
    });

    it('returns first orphan when multiple children have same tokenHash (should not happen)', async () => {
      const token = generateDelegationToken();
      const tokenHash = hashDelegationToken(token);

      const linkage1: DelegationLinkage = {
        kind: 'delegation' as const,
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1',
        tokenHash,
      };

      const linkage2: DelegationLinkage = {
        kind: 'delegation' as const,
        parentRunId: PARENT_RUN_ID,
        parentStepId: '2',
        tokenHash,
      };

      const child1 = makeState(CHILD_RUN_ID_1, { parentLinkage: linkage1 });
      const child2 = makeState(CHILD_RUN_ID_2, { parentLinkage: linkage2 });

      await writeState(child1);
      await writeState(child2);

      const result = await scanner.findOrphanedChild(tokenHash);
      expect(result).not.toBeNull();
      // Should return one of them (first match)
      expect([CHILD_RUN_ID_1, CHILD_RUN_ID_2]).toContain(result!.id);
    });
  });

  describe('edge cases', () => {
    it('findByToken handles state with no substepStates', async () => {
      const token = generateDelegationToken();
      const state = makeState(PARENT_RUN_ID, {
        substepStates: undefined,
      });
      await writeState(state);

      const result = await scanner.findByToken(token);
      expect(result).toBeNull();
    });

    it('findByToken handles state with empty substepStates array', async () => {
      const token = generateDelegationToken();
      const state = makeState(PARENT_RUN_ID, {
        substepStates: [],
      });
      await writeState(state);

      const result = await scanner.findByToken(token);
      expect(result).toBeNull();
    });

    it('findByToken handles substep without delegation field', async () => {
      const token = generateDelegationToken();
      const state = makeState(PARENT_RUN_ID, {
        substepStates: [
          { id: '1', frameKey: buildFrameKey('1'), status: 'pending' },
          { id: '2', frameKey: buildFrameKey('1'), status: 'pending' },
        ],
      });
      await writeState(state);

      const result = await scanner.findByToken(token);
      expect(result).toBeNull();
    });

    it('findByToken handles multiple states, returns match from correct state', async () => {
      const token1 = generateDelegationToken();
      const token2 = generateDelegationToken();

      const state1 = makeState(PARENT_RUN_ID, {
        substepStates: [
          {
            id: '1',
            frameKey: buildFrameKey('1'),
            status: 'pending',
            delegation: makeDelegation(token1),
          },
        ],
      });

      const state2 = makeState(OTHER_RUN_ID, {
        substepStates: [
          {
            id: '1',
            frameKey: buildFrameKey('1'),
            status: 'pending',
            delegation: makeDelegation(token2),
          },
        ],
      });

      await writeState(state1);
      await writeState(state2);

      const result1 = await scanner.findByToken(token1);
      expect(result1).not.toBeNull();
      expect(result1!.parentState.id).toBe(PARENT_RUN_ID);

      const result2 = await scanner.findByToken(token2);
      expect(result2).not.toBeNull();
      expect(result2!.parentState.id).toBe(OTHER_RUN_ID);
    });

    it('findByToken scans large number of states efficiently', async () => {
      const targetToken = generateDelegationToken();

      // Write 50 states without the target token
      for (let i = 0; i < 50; i++) {
        const otherToken = generateDelegationToken();
        const state = makeState(`wf_${String(i).padStart(32, '0')}`, {
          substepStates: [
            {
              id: '1',
              frameKey: buildFrameKey('1'),
              status: 'pending',
              delegation: makeDelegation(otherToken),
            },
          ],
        });
        await writeState(state);
      }

      // Write one state with the target token
      const targetState = makeState(TARGET_RUN_ID, {
        substepStates: [
          {
            id: '1',
            frameKey: buildFrameKey('1'),
            status: 'pending',
            delegation: makeDelegation(targetToken),
          },
        ],
      });
      await writeState(targetState);

      const result = await scanner.findByToken(targetToken);
      expect(result).not.toBeNull();
      expect(result!.parentState.id).toBe(TARGET_RUN_ID);
    });

    it('findOrphanedChild handles state with no delegation field', async () => {
      const tokenHash = hashDelegationToken(generateDelegationToken());
      const state = makeState(PARENT_RUN_ID);
      await writeState(state);

      const result = await scanner.findOrphanedChild(tokenHash);
      expect(result).toBeNull();
    });

    it('findByToken returns substepId from delegation, not from substep array position', async () => {
      const token = generateDelegationToken();
      const delegation = {
        ...makeDelegation(token),
        contextSnapshot: { vars: brandEffectiveVarsForTest({}), ancestors: [], step: '3' },
      };

      const state = makeState(PARENT_RUN_ID, {
        step: '5',
        substepStates: [
          { id: 'a', frameKey: buildFrameKey('5'), status: 'pending' },
          { id: 'b', frameKey: buildFrameKey('5'), status: 'pending', delegation },
          { id: 'c', frameKey: buildFrameKey('5'), status: 'pending' },
        ],
      });
      await writeState(state);

      const result = await scanner.findByToken(token);

      expect(result).not.toBeNull();
      expect(result!.stepId).toBe('3'); // From contextSnapshot, not current state.step
      expect(result!.substepId).toBe('b'); // From substep array
    });

    it('handles state files with large substepStates arrays', async () => {
      const token = generateDelegationToken();
      const substeps: Array<{
        id: string;
        frameKey: ReturnType<typeof buildFrameKey>;
        status: 'pending' | 'running' | 'done';
        delegation?: ReturnType<typeof makeDelegation>;
      }> = Array.from({ length: 100 }, (_, i) => ({
        id: String(i + 1),
        frameKey: buildFrameKey('1'),
        status: 'pending' as const,
      }));
      // Add delegation to the 50th substep
      substeps[49] = { ...substeps[49], delegation: makeDelegation(token) };

      const state = makeState(PARENT_RUN_ID, {
        substepStates: substeps,
      });
      await writeState(state);

      const result = await scanner.findByToken(token);
      expect(result).not.toBeNull();
      expect(result!.substepId).toBe('50');
    });
  });
});
