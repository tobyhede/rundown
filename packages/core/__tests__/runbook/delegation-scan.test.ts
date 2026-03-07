import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { DelegationScanService } from '../../src/runbook/delegation-scan.js';
import {
  hashDelegationToken,
  generateDelegationToken,
} from '../../src/runbook/delegation-token.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { RunbookState, StepDelegation, DelegationLinkage } from '../../src/runbook/types.js';

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
    const stateDir = path.join(tmpDir, '.claude/rundown/runs');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, `${state.id}.json`), JSON.stringify(state, null, 2), {
      mode: 0o600,
    });
  }

  function makeState(id: string, overrides: Partial<RunbookState> = {}): RunbookState {
    return {
      id,
      runbook: 'parent.md',
      runbookPath: 'parent.md',
      step: '1',
      stepName: 'Main step',
      retryCount: 0,
      variables: {},
      steps: [{ id: '1', status: 'running' }],
      startedAt: '2026-02-27T10:00:00.000Z',
      updatedAt: '2026-02-27T10:00:00.000Z',
      ...overrides,
    } as RunbookState;
  }

  function makeDelegation(token: string): StepDelegation {
    return {
      tokenHash: hashDelegationToken(token),
      childRunbookPath: 'child.md',
      contextSnapshot: { vars: { env: 'staging' }, ancestors: [] },
      childRunId: null,
      createdAt: '2026-02-27T10:00:00.000Z',
      cancelledAt: null,
    };
  }

  describe('findByToken', () => {
    it('returns match when token exists in substepStates', async () => {
      const token = generateDelegationToken();
      const delegation = makeDelegation(token);

      const state = makeState('run-parent', {
        substepStates: [
          { id: '1', frameKey: buildFrameKey('1'), status: 'pending', delegation },
          { id: '2', frameKey: buildFrameKey('1'), status: 'pending' },
        ],
      });
      await writeState(state);

      const result = await scanner.findByToken(token);

      expect(result).not.toBeNull();
      expect(result!.parentState.id).toBe('run-parent');
      expect(result!.substepId).toBe('1');
      expect(result!.delegation.tokenHash).toBe(delegation.tokenHash);
    });

    it('returns null when token not found', async () => {
      const token = generateDelegationToken();

      // Write a state with a different token
      const otherToken = generateDelegationToken();
      const state = makeState('run-other', {
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
        contextSnapshot: { vars: {}, ancestors: [], step: '1' },
      };

      const state = makeState('run-parent', {
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
        contextSnapshot: { vars: {}, ancestors: [] },
      };

      const state = makeState('run-parent', {
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
        parentRunId: 'parent-run',
        parentStepId: '1',
        tokenHash,
      };

      const childState = makeState('child-run', {
        delegation: linkage,
      });
      await writeState(childState);

      const result = await scanner.findOrphanedChild(tokenHash);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('child-run');
    });

    it('returns null when no orphaned child exists', async () => {
      const token = generateDelegationToken();
      const tokenHash = hashDelegationToken(token);

      // Write an unrelated state
      const state = makeState('unrelated-run');
      await writeState(state);

      const result = await scanner.findOrphanedChild(tokenHash);
      expect(result).toBeNull();
    });

    it('returns first orphan when multiple children have same tokenHash (should not happen)', async () => {
      const token = generateDelegationToken();
      const tokenHash = hashDelegationToken(token);

      const linkage1: DelegationLinkage = {
        parentRunId: 'parent-run',
        parentStepId: '1',
        tokenHash,
      };

      const linkage2: DelegationLinkage = {
        parentRunId: 'parent-run',
        parentStepId: '2',
        tokenHash,
      };

      const child1 = makeState('child-1', { delegation: linkage1 });
      const child2 = makeState('child-2', { delegation: linkage2 });

      await writeState(child1);
      await writeState(child2);

      const result = await scanner.findOrphanedChild(tokenHash);
      expect(result).not.toBeNull();
      // Should return one of them (first match)
      expect(['child-1', 'child-2']).toContain(result!.id);
    });
  });

  describe('edge cases', () => {
    it('findByToken handles state with no substepStates', async () => {
      const token = generateDelegationToken();
      const state = makeState('run-no-substeps', {
        substepStates: undefined,
      });
      await writeState(state);

      const result = await scanner.findByToken(token);
      expect(result).toBeNull();
    });

    it('findByToken handles state with empty substepStates array', async () => {
      const token = generateDelegationToken();
      const state = makeState('run-empty-substeps', {
        substepStates: [],
      });
      await writeState(state);

      const result = await scanner.findByToken(token);
      expect(result).toBeNull();
    });

    it('findByToken handles substep without delegation field', async () => {
      const token = generateDelegationToken();
      const state = makeState('run-no-delegation', {
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

      const state1 = makeState('run-1', {
        substepStates: [
          {
            id: '1',
            frameKey: buildFrameKey('1'),
            status: 'pending',
            delegation: makeDelegation(token1),
          },
        ],
      });

      const state2 = makeState('run-2', {
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
      expect(result1!.parentState.id).toBe('run-1');

      const result2 = await scanner.findByToken(token2);
      expect(result2).not.toBeNull();
      expect(result2!.parentState.id).toBe('run-2');
    });

    it('findByToken scans large number of states efficiently', async () => {
      const targetToken = generateDelegationToken();

      // Write 50 states without the target token
      for (let i = 0; i < 50; i++) {
        const otherToken = generateDelegationToken();
        const state = makeState(`run-${String(i)}`, {
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
      const targetState = makeState('run-target', {
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
      expect(result!.parentState.id).toBe('run-target');
    });

    it('findOrphanedChild handles state with no delegation field', async () => {
      const tokenHash = hashDelegationToken(generateDelegationToken());
      const state = makeState('run-no-delegation-linkage');
      await writeState(state);

      const result = await scanner.findOrphanedChild(tokenHash);
      expect(result).toBeNull();
    });

    it('findByToken returns substepId from delegation, not from substep array position', async () => {
      const token = generateDelegationToken();
      const delegation = {
        ...makeDelegation(token),
        contextSnapshot: { vars: {}, ancestors: [], step: '3' },
      };

      const state = makeState('run-context-step', {
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

      const state = makeState('run-large-substeps', {
        substepStates: substeps,
      });
      await writeState(state);

      const result = await scanner.findByToken(token);
      expect(result).not.toBeNull();
      expect(result!.substepId).toBe('50');
    });
  });
});
