import { describe, it, expect } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { SessionService } from '../../src/runbook/session-service.js';
import { resolveTransitionTarget } from '../../src/runbook/command-target-resolver.js';
import { assertClaimId } from '../../src/runbook/claim-id.js';
import { makeBaseStep } from '../helpers/step-factories.js';
import type { Step, Runbook } from '../../src/runbook/types.js';
import { linkageFor, assertClaimed } from './claim-test-helpers.js';

const KNOWN_KINDS = new Set([
  'claim',
  'default',
  'terminal_claim_confirmed',
  'terminal_claim_conflict',
  'open_delegated_children',
  'none',
  'stale_claim',
]);

const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
const mockRunbook: Runbook = { title: 'Test Runbook', description: 'A test', steps: mockSteps };

describe('resolveTransitionTarget properties', () => {
  it('always returns a well-formed variant for arbitrary command/claimId input', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('pass' as const, 'fail' as const),
        fc.boolean(),
        fc.boolean(),
        async (command, hasActive, withClaim) => {
          const testDir = await mkdtemp(join(tmpdir(), 'ttr-prop-'));
          try {
            const manager = new RunbookStateManager(testDir);
            const sessionService = new SessionService(manager);

            if (hasActive) {
              const parent = await manager.create(
                { source: 'project', path: 'parent.md' },
                mockRunbook,
                { runbookPath: 'parent.md' },
              );
              await sessionService.pushRunbook(parent.id);
            }

            const claimId = withClaim ? assertClaimId('rdclm_propunknownclaim000000') : undefined;
            const result = await resolveTransitionTarget(sessionService, {
              command,
              ...(claimId ? { claimId } : {}),
            });

            expect(KNOWN_KINDS.has(result.kind)).toBe(true);
          } finally {
            await rm(testDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('default kind iff an active runbook exists with no open delegated child claims', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (claimOpenChild) => {
        const testDir = await mkdtemp(join(tmpdir(), 'ttr-default-'));
        try {
          const manager = new RunbookStateManager(testDir);
          const sessionService = new SessionService(manager);
          const parent = await manager.create(
            { source: 'project', path: 'parent.md' },
            mockRunbook,
            { runbookPath: 'parent.md' },
          );
          await sessionService.pushRunbook(parent.id);

          if (claimOpenChild) {
            const child = await manager.create(
              { source: 'project', path: 'child.md' },
              mockRunbook,
              { runbookPath: 'child.md', parentLinkage: linkageFor(parent.id, 'a') },
            );
            assertClaimed(await sessionService.claimRunbook(child.id, linkageFor(parent.id, 'a')));
          }

          const open = await sessionService.listOpenClaimsForParent(parent.id);
          const result = await resolveTransitionTarget(sessionService, { command: 'pass' });

          expect(result.kind === 'default').toBe(open.length === 0);
        } finally {
          await rm(testDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 50 },
    );
  });
});
