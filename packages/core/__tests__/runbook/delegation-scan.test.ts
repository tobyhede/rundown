import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { DelegationScanService } from '../../src/runbook/delegation-scan.js';
import { seedRawRunState } from '../../src/testing/state-fixtures.js';
import { hashDelegationToken } from '../../src/runbook/delegation-token.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { RunbookState, StepDelegation, DelegationLinkage } from '../../src/runbook/types.js';
import {
  brandStoredOutputsForTest,
  brandEffectiveVarsForTest,
  brandInitialTemplateVarsForTest,
} from '../../src/testing/effective-vars.js';
import {
  generateDelegationToken,
  makeDelegationCredentialDescriptor,
} from '../../src/testing/delegation-fixtures.js';

describe('DelegationScanService', () => {
  let tmpDir: string;
  let manager: RunbookStateManager;
  let scanner: DelegationScanService;

  function testRunId(index: number): RunbookState['id'] {
    return `rd_${index.toString(16).padStart(32, '0')}` as RunbookState['id'];
  }

  const RUN_PARENT_ID = testRunId(1);
  const RUN_OTHER_ID = testRunId(2);
  const CHILD_RUN_ID = testRunId(3);
  const UNRELATED_RUN_ID = testRunId(4);
  const CHILD_ONE_ID = testRunId(5);
  const CHILD_TWO_ID = testRunId(6);
  const RUN_NO_SUBSTEPS_ID = testRunId(7);
  const RUN_EMPTY_SUBSTEPS_ID = testRunId(8);
  const RUN_NO_DELEGATION_ID = testRunId(9);
  const RUN_ONE_ID = testRunId(10);
  const RUN_TWO_ID = testRunId(11);
  const RUN_TARGET_ID = testRunId(12);
  const RUN_NO_DELEGATION_LINKAGE_ID = testRunId(13);
  const RUN_CONTEXT_STEP_ID = testRunId(14);
  const RUN_LARGE_SUBSTEPS_ID = testRunId(15);
  const PARENT_LINK_ID = testRunId(16);

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-scan-'));
    manager = new RunbookStateManager(tmpDir);
    scanner = new DelegationScanService(manager);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Seed run state directly into the store to bypass schema validation. */
  async function writeState(state: RunbookState): Promise<void> {
    await seedRawRunState(tmpDir, state as unknown as Record<string, unknown>);
  }

  function makeState(id: string, overrides: Partial<RunbookState> = {}): RunbookState {
    return {
      id: id as RunbookState['id'],
      runbook: { source: 'project', path: 'parent.md' },
      runbookPath: 'parent.md',
      step: '1',
      stepName: 'Main step',
      retryCount: 0,
      variables: brandStoredOutputsForTest({}),
      templateVars: brandInitialTemplateVarsForTest({}),
      steps: [{ id: '1', status: 'running' }],
      startedAt: '2026-02-27T10:00:00.000Z',
      updatedAt: '2026-02-27T10:00:00.000Z',
      lifecycle: 'running',
      schemaVersion: 1,
      ...overrides,
    };
  }

  function makeDelegation(token: string): StepDelegation {
    return {
      credential: makeDelegationCredentialDescriptor(),
      tokenHash: hashDelegationToken(token),
      childRunbookPath: 'child.md',
      childRunbookRef: { source: 'project', path: 'child.md' },
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

      const state = makeState(RUN_PARENT_ID, {
        substepStates: [
          { id: '1', frameKey: buildFrameKey('1'), status: 'pending', delegation },
          { id: '2', frameKey: buildFrameKey('1'), status: 'pending' },
        ],
      });
      await writeState(state);

      const result = await scanner.findByToken(token);

      expect(result).not.toBeNull();
      expect(result!.parentState.id).toBe(RUN_PARENT_ID);
      expect(result!.substepId).toBe('1');
      expect(result!.delegation.tokenHash).toBe(delegation.tokenHash);
    });

    it('returns null when token not found', async () => {
      const token = generateDelegationToken();

      // Write a state with a different token
      const otherToken = generateDelegationToken();
      const state = makeState(RUN_OTHER_ID, {
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

      const state = makeState(RUN_PARENT_ID, {
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

      const state = makeState(RUN_PARENT_ID, {
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
        parentRunId: PARENT_LINK_ID,
        parentStepId: '1',
        parentStep: '1',
        parentFrameKey: buildFrameKey('1'),
        parentEntry: 1,
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
      const state = makeState(UNRELATED_RUN_ID);
      await writeState(state);

      const result = await scanner.findOrphanedChild(tokenHash);
      expect(result).toBeNull();
    });

    it('returns first orphan when multiple children have same tokenHash (should not happen)', async () => {
      const token = generateDelegationToken();
      const tokenHash = hashDelegationToken(token);

      const linkage1: DelegationLinkage = {
        kind: 'delegation' as const,
        parentRunId: PARENT_LINK_ID,
        parentStepId: '1',
        parentStep: '1',
        parentFrameKey: buildFrameKey('1'),
        parentEntry: 1,
        tokenHash,
      };

      const linkage2: DelegationLinkage = {
        kind: 'delegation' as const,
        parentRunId: PARENT_LINK_ID,
        parentStepId: '2',
        parentStep: '1',
        parentFrameKey: buildFrameKey('1'),
        parentEntry: 1,
        tokenHash,
      };

      const child1 = makeState(CHILD_ONE_ID, { parentLinkage: linkage1 });
      const child2 = makeState(CHILD_TWO_ID, { parentLinkage: linkage2 });

      await writeState(child1);
      await writeState(child2);

      const result = await scanner.findOrphanedChild(tokenHash);
      expect(result).not.toBeNull();
      // Should return one of them (first match)
      expect([CHILD_ONE_ID, CHILD_TWO_ID]).toContain(result!.id);
    });
  });

  describe('edge cases', () => {
    it('findByToken handles state with no substepStates', async () => {
      const token = generateDelegationToken();
      const state = makeState(RUN_NO_SUBSTEPS_ID, {
        substepStates: undefined,
      });
      await writeState(state);

      const result = await scanner.findByToken(token);
      expect(result).toBeNull();
    });

    it('findByToken handles state with empty substepStates array', async () => {
      const token = generateDelegationToken();
      const state = makeState(RUN_EMPTY_SUBSTEPS_ID, {
        substepStates: [],
      });
      await writeState(state);

      const result = await scanner.findByToken(token);
      expect(result).toBeNull();
    });

    it('findByToken handles substep without delegation field', async () => {
      const token = generateDelegationToken();
      const state = makeState(RUN_NO_DELEGATION_ID, {
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

      const state1 = makeState(RUN_ONE_ID, {
        substepStates: [
          {
            id: '1',
            frameKey: buildFrameKey('1'),
            status: 'pending',
            delegation: makeDelegation(token1),
          },
        ],
      });

      const state2 = makeState(RUN_TWO_ID, {
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
      expect(result1!.parentState.id).toBe(RUN_ONE_ID);

      const result2 = await scanner.findByToken(token2);
      expect(result2).not.toBeNull();
      expect(result2!.parentState.id).toBe(RUN_TWO_ID);
    });

    it('findByToken scans large number of states efficiently', async () => {
      const targetToken = generateDelegationToken();

      // Write 50 states without the target token
      for (let i = 0; i < 50; i++) {
        const otherToken = generateDelegationToken();
        const state = makeState(testRunId(100 + i), {
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
      const targetState = makeState(RUN_TARGET_ID, {
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
      expect(result!.parentState.id).toBe(RUN_TARGET_ID);
    });

    it('findOrphanedChild handles state with no delegation field', async () => {
      const tokenHash = hashDelegationToken(generateDelegationToken());
      const state = makeState(RUN_NO_DELEGATION_LINKAGE_ID);
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

      const state = makeState(RUN_CONTEXT_STEP_ID, {
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

      const state = makeState(RUN_LARGE_SUBSTEPS_ID, {
        substepStates: substeps,
      });
      await writeState(state);

      const result = await scanner.findByToken(token);
      expect(result).not.toBeNull();
      expect(result!.substepId).toBe('50');
    });
  });

  describe('scanByTokenHash', () => {
    /** A delegation whose credential records `supersededToken` as the bearer it replaced. */
    function makeReplacement(ownToken: string, supersededToken: string): StepDelegation {
      return {
        ...makeDelegation(ownToken),
        credential: makeDelegationCredentialDescriptor({
          supersedesTokenHash: hashDelegationToken(supersededToken),
        }),
      };
    }

    it('answers both token-index questions from a single state listing', async () => {
      // The retry locator needs the current row AND every superseding row. Two
      // lookups meant two `manager.list()` walks, each of which eagerly loads and
      // parses every state file; the merged scan answers both from one.
      const t1 = generateDelegationToken();
      await writeState(
        makeState(RUN_PARENT_ID, {
          substepStates: [
            {
              id: '1',
              frameKey: buildFrameKey('1'),
              status: 'pending',
              delegation: makeDelegation(t1),
            },
            {
              id: '2',
              frameKey: buildFrameKey('2'),
              status: 'pending',
              delegation: makeReplacement(generateDelegationToken(), t1),
            },
          ],
        }),
      );
      await writeState(
        makeState(RUN_OTHER_ID, {
          substepStates: [
            {
              id: '1',
              frameKey: buildFrameKey('3'),
              status: 'pending',
              delegation: makeReplacement(generateDelegationToken(), t1),
            },
          ],
        }),
      );

      const listSpy = jest.spyOn(manager, 'list');
      const scan = await scanner.scanByTokenHash(hashDelegationToken(t1));

      expect(listSpy).toHaveBeenCalledTimes(1);
      expect(scan.current?.frameKey).toBe(buildFrameKey('1'));
      expect(scan.current?.substepId).toBe('1');
      // Every superseding row, across runs — ambiguity stays visible.
      expect(scan.superseding.map((row) => row.frameKey)).toEqual([
        buildFrameKey('2'),
        buildFrameKey('3'),
      ]);
    });

    it('reports an absent current row without suppressing superseding rows', async () => {
      // The rotated-away bearer: no row still carries it as `tokenHash`, but a
      // replacement records it as superseded. Collapsing the pair into one
      // "found nothing" would return a replayed retry to `token-not-found`.
      const t1 = generateDelegationToken();
      await writeState(
        makeState(RUN_PARENT_ID, {
          substepStates: [
            {
              id: '1',
              frameKey: buildFrameKey('1'),
              status: 'pending',
              delegation: makeReplacement(generateDelegationToken(), t1),
            },
          ],
        }),
      );

      const scan = await scanner.scanByTokenHash(hashDelegationToken(t1));
      expect(scan.current).toBeUndefined();
      expect(scan.superseding).toHaveLength(1);
    });

    it('reports both empty when the hash matches nothing', async () => {
      await writeState(
        makeState(RUN_PARENT_ID, {
          substepStates: [
            {
              id: '1',
              frameKey: buildFrameKey('1'),
              status: 'pending',
              delegation: makeDelegation(generateDelegationToken()),
            },
          ],
        }),
      );

      expect(await scanner.scanByTokenHash(hashDelegationToken(generateDelegationToken()))).toEqual(
        {
          current: undefined,
          superseding: [],
        },
      );
    });

    it('reports the first current row when more than one carries the hash', async () => {
      // `findByToken` stops at the first match; the merged scan must agree with
      // it rather than reporting a different owner for the same bearer.
      const t1 = generateDelegationToken();
      await writeState(
        makeState(RUN_PARENT_ID, {
          substepStates: [
            {
              id: '1',
              frameKey: buildFrameKey('1'),
              status: 'pending',
              delegation: makeDelegation(t1),
            },
            {
              id: '2',
              frameKey: buildFrameKey('1'),
              status: 'pending',
              delegation: makeDelegation(t1),
            },
          ],
        }),
      );

      const scan = await scanner.scanByTokenHash(hashDelegationToken(t1));
      expect(scan.current?.substepId).toBe('1');
      expect(scan.current).toEqual(await scanner.findByToken(t1));
    });

    it('reports the superseding row identity, not just its presence', async () => {
      const t1 = generateDelegationToken();
      await writeState(
        makeState(RUN_PARENT_ID, {
          substepStates: [
            {
              id: '1',
              frameKey: buildFrameKey('2'),
              status: 'pending',
              delegation: makeReplacement(generateDelegationToken(), t1),
            },
          ],
        }),
      );

      const scan = await scanner.scanByTokenHash(hashDelegationToken(t1));
      expect(scan.superseding).toHaveLength(1);
      expect(scan.superseding[0].frameKey).toBe(buildFrameKey('2'));
      expect(scan.superseding[0].substepId).toBe('1');
    });

    it('reports every superseding row within one run, not the first hit', async () => {
      // Row 8 of the retry decision table (RD-828) is only expressible if the
      // scan surfaces the ambiguity rather than resolving it. The cross-run case
      // is covered above; this is the same-frame case.
      const t1 = generateDelegationToken();
      await writeState(
        makeState(RUN_PARENT_ID, {
          substepStates: [
            {
              id: '1',
              frameKey: buildFrameKey('2'),
              status: 'pending',
              delegation: makeReplacement(generateDelegationToken(), t1),
            },
            {
              id: '2',
              frameKey: buildFrameKey('2'),
              status: 'pending',
              delegation: makeReplacement(generateDelegationToken(), t1),
            },
          ],
        }),
      );

      expect((await scanner.scanByTokenHash(hashDelegationToken(t1))).superseding).toHaveLength(2);
    });

    it('does not report a current row as superseding', async () => {
      // A token that is CURRENT, not superseded, belongs to `current` alone —
      // the two predicates must stay disjoint over the same listing.
      const t1 = generateDelegationToken();
      await writeState(
        makeState(RUN_PARENT_ID, {
          substepStates: [
            {
              id: '1',
              frameKey: buildFrameKey('1'),
              status: 'pending',
              delegation: makeDelegation(t1),
            },
          ],
        }),
      );

      const scan = await scanner.scanByTokenHash(hashDelegationToken(t1));
      expect(scan.current?.substepId).toBe('1');
      expect(scan.superseding).toEqual([]);
    });

    it('reports a superseding row step from the delegation context snapshot', async () => {
      const t1 = generateDelegationToken();
      const delegation = makeReplacement(generateDelegationToken(), t1);
      await writeState(
        makeState(RUN_CONTEXT_STEP_ID, {
          step: '9',
          substepStates: [
            {
              id: '1',
              frameKey: buildFrameKey('2'),
              status: 'pending',
              delegation: {
                ...delegation,
                contextSnapshot: { ...delegation.contextSnapshot, step: '2' },
              },
            },
          ],
        }),
      );

      const scan = await scanner.scanByTokenHash(hashDelegationToken(t1));
      expect(scan.superseding[0].stepId).toBe('2');
    });

    it('falls back to the run cursor when a superseding snapshot carries no step', async () => {
      const t1 = generateDelegationToken();
      await writeState(
        makeState(RUN_NO_DELEGATION_LINKAGE_ID, {
          step: '7',
          substepStates: [
            {
              id: '1',
              frameKey: buildFrameKey('7'),
              status: 'pending',
              delegation: makeReplacement(generateDelegationToken(), t1),
            },
          ],
        }),
      );

      const scan = await scanner.scanByTokenHash(hashDelegationToken(t1));
      expect(scan.superseding[0].stepId).toBe('7');
    });

    it('skips substeps that carry no delegation at all', async () => {
      const t1 = generateDelegationToken();
      await writeState(
        makeState(RUN_NO_DELEGATION_ID, {
          substepStates: [
            { id: '1', frameKey: buildFrameKey('1'), status: 'pending' },
            {
              id: '2',
              frameKey: buildFrameKey('1'),
              status: 'pending',
              delegation: makeReplacement(generateDelegationToken(), t1),
            },
          ],
        }),
      );

      const scan = await scanner.scanByTokenHash(hashDelegationToken(t1));
      expect(scan.superseding).toHaveLength(1);
      expect(scan.superseding[0].substepId).toBe('2');
    });

    it('reports both empty when no states exist', async () => {
      expect(await scanner.scanByTokenHash(hashDelegationToken(generateDelegationToken()))).toEqual(
        {
          current: undefined,
          superseding: [],
        },
      );
    });

    it('skips a run that has no substep states at all', async () => {
      // Distinct from "no states exist": the scan must tolerate a run whose
      // `substepStates` is absent rather than empty.
      const t1 = generateDelegationToken();
      await writeState(makeState(RUN_NO_SUBSTEPS_ID));
      await writeState(
        makeState(RUN_TARGET_ID, {
          substepStates: [
            {
              id: '1',
              frameKey: buildFrameKey('1'),
              status: 'pending',
              delegation: makeReplacement(generateDelegationToken(), t1),
            },
          ],
        }),
      );

      const scan = await scanner.scanByTokenHash(hashDelegationToken(t1));
      expect(scan.superseding.map((row) => row.parentState.id)).toEqual([RUN_TARGET_ID]);
    });
  });
});
