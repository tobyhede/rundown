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
      pendingSteps: [],
      agentBindings: {},
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
          { id: '1', status: 'pending', delegation },
          { id: '2', status: 'pending' },
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
        substepStates: [{ id: '1', status: 'pending', delegation: makeDelegation(otherToken) }],
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
  });
});
