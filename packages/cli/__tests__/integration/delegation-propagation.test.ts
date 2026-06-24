import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  createRunbook,
  runCliInProcess,
  getActiveState,
  readRunbookState,
  readSession,
  findActionOutput,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildTransitionContext,
  executeTransition,
  createPassTransitionConfig,
} from '../../src/helpers/transitions.js';
import { OutputEmitter } from '../../src/services/output-emitter.js';

describe('Delegation propagation integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /** Helper: write a parent runbook with substeps. */
  async function writeParentRunbook(childRunbook = 'child.runbook.md'): Promise<void> {
    const content = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Review',
          pass: 'CONTINUE',
          substeps: [
            {
              title: 'Code review',
              delegate: true,
              content: 'Do code review.',
              runbooks: [childRunbook],
            },
            {
              title: 'Security review',
              delegate: true,
              content: 'Do security review.',
              runbooks: [childRunbook],
            },
          ],
        },
        { title: 'Done', pass: 'COMPLETE', content: 'Final step.' },
      ],
    });
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), content);
  }

  /** Helper: write a single-step child runbook (prompted). */
  async function writeChildRunbook(): Promise<void> {
    const content = createRunbook({
      title: 'Child',
      steps: [{ title: 'Execute', pass: 'COMPLETE', fail: 'STOP', content: 'Run the child task.' }],
    });
    await writeFile(join(workspace.cwd, 'child.runbook.md'), content);
  }

  async function getAutoIssuedToken(substepId = '1'): Promise<string> {
    const state = await getActiveState(workspace);
    const token = state?.substepStates?.find((substep) => substep.id === substepId)?.delegation
      ?.token;
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
    return token!;
  }

  /** Helper: read resolvedCompletions from a run state file. */
  async function readResolvedCompletions(runId: string): Promise<Record<string, unknown>> {
    try {
      const statePath = join(workspace.statePath(), `${runId}.json`);
      const content = await readFile(statePath, 'utf-8');
      const state = JSON.parse(content) as Record<string, unknown>;
      const completions = state.resolvedCompletions;
      if (completions && typeof completions === 'object') {
        return completions as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  describe('2-level pass propagation', () => {
    it('child pass resolves parent substep and parent advances', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent in prompted mode
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      // Get parent run ID
      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      const parentRunId = parentState!.id;

      const token = await getAutoIssuedToken('1');

      // Claim the token — launches child runbook in prompted mode.
      // Drop --text so we can extract claim_id / run_id from JSON output.
      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      const claimAction = findActionOutput(result.stdout);
      expect(claimAction).not.toBeNull();
      const childRunId = String(claimAction!.run_id);
      const claimId = String(claimAction!.claim_id);

      // Verify child state has delegation linkage via parentLinkage.
      // Under reverted Route A, getActiveState returns the parent — read child by id.
      const childState = await readRunbookState(workspace, childRunId);
      expect(childState).not.toBeNull();
      expect(childState!.parentLinkage).toBeDefined();
      expect(childState!.parentLinkage).toEqual(expect.objectContaining({ parentRunId }));

      // Pass the child step — REPORTS pass to parent substep 1.1 (report-only).
      result = await runCliInProcess(['pass', '--claim-id', claimId, '--text'], workspace);
      if (result.exitCode !== 0) {
        throw new Error(`rd pass failed: ${result.stdout}\n${result.stderr}`);
      }

      // After child completes, it should have lifecycle = 'completed'
      const finalChildState = await readRunbookState(workspace, childRunId);
      expect(finalChildState).not.toBeNull();
      expect(finalChildState!.lifecycle).toBe('completed');

      // Plan 5 (report-only): the parent does NOT advance on close — it is left
      // collection pending. Resolve the second delegated substep too, then a
      // single `rd collect` aggregates both reported outcomes.
      const token2 = await getAutoIssuedToken('2');
      result = await runCliInProcess(`claim ${token2}`, workspace);
      expect(result.exitCode).toBe(0);
      const claim2Id = String(findActionOutput(result.stdout)!.claim_id);
      result = await runCliInProcess(['pass', '--claim-id', claim2Id, '--text'], workspace);
      expect(result.exitCode).toBe(0);

      const sessionAfterChild = await readSession(workspace);
      expect(sessionAfterChild.defaultStack).toEqual([parentRunId]);

      // `rd collect` applies the reported outcomes: PASS ALL → CONTINUE → step 2.
      result = await runCliInProcess('collect', workspace);
      expect(result.exitCode).toBe(0);

      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.step).toBe('2');
      expect(updatedParent!.substep).toBeUndefined();
    });

    it('refuses bare parent pass while a claimed delegated child is open', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const token = await getAutoIssuedToken();
      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      const claimAction = findActionOutput(result.stdout);
      expect(claimAction).not.toBeNull();
      const claimId = String(claimAction!.claim_id);

      result = await runCliInProcess('pass', workspace);

      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as {
        error?: string;
        code?: string;
        command?: string;
        details?: { parentRunId?: string; claimIds?: string[]; childRunIds?: string[] };
      };
      expect(payload.code).toBe('OPEN_DELEGATED_CHILDREN');
      expect(payload.error).toContain('rd pass --claim-id');
      expect(payload.error).toContain(claimId);
      // The structured details payload is the contract MCP (Task 4) relies on.
      expect(payload.details?.claimIds).toEqual([claimId]);
      expect(payload.details?.parentRunId).toBeDefined();
      expect(payload.details?.childRunIds?.length).toBe(1);
    });

    it('refuses bare parent fail while a claimed delegated child is open', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const token = await getAutoIssuedToken();
      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      const claimAction = findActionOutput(result.stdout);
      expect(claimAction).not.toBeNull();
      const claimId = String(claimAction!.claim_id);

      result = await runCliInProcess('fail', workspace);

      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(result.stdout) as { code?: string; error?: string };
      expect(payload.code).toBe('OPEN_DELEGATED_CHILDREN');
      expect(payload.error).toContain('rd fail --claim-id');
      expect(payload.error).toContain(claimId);
    });

    it('allows bare rd collect while a claimed delegated child is open (collect is exempt)', async () => {
      // Regression guard for the buildTransitionContext routing split: `rd collect`
      // omits `command`, so it must route through the base resolveCommandTarget and
      // stay EXEMPT from the open-delegated-children refusal that bare pass/fail hit
      // above — collect exists precisely to aggregate finished children while claims
      // are still open. If collect were ever routed through resolveTransitionTarget,
      // it would short-circuit with OPEN_DELEGATED_CHILDREN instead of reaching its
      // own aggregation logic, and this assertion would flip.
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const token = await getAutoIssuedToken();
      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      result = await runCliInProcess('collect', workspace);

      const payload = JSON.parse(result.stdout) as { code?: string; error?: string };
      // Collect reached its own substep-resolution check (substep 1.2 is still
      // pending) rather than being refused by the open-children guard.
      expect(payload.code).not.toBe('OPEN_DELEGATED_CHILDREN');
      expect(payload.code).toBe('SUBSTEPS_NOT_RESOLVED');
    });

    it('allows a targeted rd pass --step on a different substep while another child is open', async () => {
      // The open-delegated-children guard is for *bare* rd pass/fail only — an
      // accidental parent advance. A targeted `--step` transition is an explicit,
      // deliberate target and must not be refused just because an unrelated
      // delegated substep's child is open. Here substep 1.1's child is claimed and
      // open; `rd pass --step 1.2` targets the *other* substep and must succeed.
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const token = await getAutoIssuedToken();
      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      result = await runCliInProcess('pass --step 1.2', workspace);

      // Not refused by the open-children guard, and the targeted transition runs.
      expect(result.stdout).not.toContain('OPEN_DELEGATED_CHILDREN');
      expect(result.exitCode).toBe(0);
    });

    it('refuses the parent advance when a claim lands after resolution but before the decisive write (executeTransition re-check)', async () => {
      // Drives the ATOMIC RE-CHECK inside executeTransition (not the resolver
      // pre-check). The pre-check runs in buildTransitionContext below while no
      // claim exists, resolving a ready ctx. A claim then lands in the
      // check-then-act window, and the guarded write must still refuse — proving
      // runGuardedParentAdvance closes the TOCTOU end-to-end through the real
      // transition path.
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);
      const parentRunId = (await getActiveState(workspace))!.id;
      const token = await getAutoIssuedToken();

      // Pre-check: no open claims yet, so the resolver yields a ready context
      // (guardOpenChildren is true because this targets the default parent).
      type CapturedEvent = { type: string; code?: string; details?: { claimIds?: string[] } };
      const events: CapturedEvent[] = [];
      const output = new OutputEmitter({
        command: 'pass',
        renderer: {
          render: (event) => {
            events.push(event);
          },
          flush: () => {},
        },
      });
      const contextResult = await buildTransitionContext(output, workspace.cwd, {
        command: 'pass',
      });
      expect(contextResult.kind).toBe('ready');
      if (contextResult.kind !== 'ready') {
        throw new Error(`expected ready context, got ${contextResult.kind}`);
      }

      // Race: a claim lands AFTER the pre-check, BEFORE the decisive write.
      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      const claimId = String(findActionOutput(result.stdout)!.claim_id);

      // The atomic re-check must now refuse the advance.
      const transitionResult = await executeTransition(
        contextResult.ctx,
        createPassTransitionConfig(),
      );
      expect(transitionResult).toBe('stopped');

      const errorEvent = events.find((event) => event.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.code).toBe('OPEN_DELEGATED_CHILDREN');
      expect(errorEvent?.details?.claimIds).toEqual([claimId]);

      // The parent must NOT have advanced: no substep was marked done.
      const parent = await readRunbookState(workspace, parentRunId);
      expect(parent!.step).toBe('1');
      expect((parent!.substepStates ?? []).every((substep) => substep.status !== 'done')).toBe(
        true,
      );
    });
  });

  describe('2-level fail propagation', () => {
    it('child fail triggers parent STOP via FAIL ANY', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent in prompted mode
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id;

      const token = await getAutoIssuedToken('1');

      // Claim — drop --text so we can capture claim_id from JSON output
      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      const claimAction = findActionOutput(result.stdout);
      expect(claimAction).not.toBeNull();
      const claimId = String(claimAction!.claim_id);

      // Fail the child step — REPORTS fail to parent substep 1.1 (report-only).
      // Exit-code narrowing (Plan 5): the child's FAIL action is STOP, so the
      // child locally STOPs and `rd fail --claim-id` exits 1 on its OWN
      // lifecycle — reporting upward no longer absorbs the stop into exit 0.
      result = await runCliInProcess(['fail', '--claim-id', claimId, '--text'], workspace);
      expect(result.exitCode).toBe(1);

      // Resolve the second delegated substep so collect can aggregate the step.
      const token2 = await getAutoIssuedToken('2');
      result = await runCliInProcess(`claim ${token2}`, workspace);
      expect(result.exitCode).toBe(0);
      const claim2Id = String(findActionOutput(result.stdout)!.claim_id);
      result = await runCliInProcess(['pass', '--claim-id', claim2Id, '--text'], workspace);
      expect(result.exitCode).toBe(0);

      // `rd collect` applies the reported outcomes: FAIL ANY (1.1 failed) → STOP.
      result = await runCliInProcess('collect --text', workspace);

      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.lifecycle).toBe('stopped');
    });
  });

  describe('2-level stop propagation', () => {
    it('rd stop on child propagates fail to parent and parent stops', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent in prompted mode
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id;

      const token = await getAutoIssuedToken('1');

      // Claim — drop --text so we can capture claim_id from JSON output
      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      const claimAction = findActionOutput(result.stdout);
      expect(claimAction).not.toBeNull();
      const claimId = String(claimAction!.claim_id);

      // Stop the child — REPORTS fail to parent substep 1.1 (report-only). A
      // user-initiated stop always exits 0.
      result = await runCliInProcess(['stop', '--claim-id', claimId, '--text'], workspace);
      expect(result.exitCode).toBe(0);

      // Resolve the second delegated substep so collect can aggregate the step.
      const token2 = await getAutoIssuedToken('2');
      result = await runCliInProcess(`claim ${token2}`, workspace);
      expect(result.exitCode).toBe(0);
      const claim2Id = String(findActionOutput(result.stdout)!.claim_id);
      result = await runCliInProcess(['pass', '--claim-id', claim2Id, '--text'], workspace);
      expect(result.exitCode).toBe(0);

      // `rd collect` applies the reported outcomes: FAIL ANY (1.1 failed) → STOP.
      result = await runCliInProcess('collect --text', workspace);

      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.lifecycle).toBe('stopped');
    });
  });

  describe('3-level chain propagation', () => {
    it('child completion cascades through parent to grandparent', async () => {
      // Grandparent with 2 substeps
      const grandparentContent = createRunbook({
        title: 'Grandparent',
        steps: [
          {
            title: 'Pipeline',
            pass: 'COMPLETE',
            substeps: [
              {
                title: 'Deploy',
                delegate: true,
                content: 'Deploy step.',
                runbooks: ['parent.runbook.md'],
              },
              { title: 'Verify', content: 'Verify step.' },
            ],
          },
        ],
      });
      await writeFile(join(workspace.cwd, 'grandparent.runbook.md'), grandparentContent);

      // Parent with 2 substeps. Substep 1.1's body composes the child runbook
      // inline via `rd run` instead of nesting another delegation — under the
      // RD-819 guard, `rd delegate` from inside an already-claimed parent is
      // refused, so the inner delegation is replaced by composition.
      const parentContent = createRunbook({
        title: 'Parent',
        steps: [
          {
            title: 'Review',
            pass: 'COMPLETE',
            substeps: [
              {
                title: 'Task',
                content: 'Compose the child runbook inline.',
                command: 'rd run child.runbook.md',
              },
              { title: 'Approve', content: 'Approve the deployment.' },
            ],
          },
        ],
      });
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), parentContent);

      await writeChildRunbook();

      // Start grandparent
      let result = await runCliInProcess('run --prompted grandparent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const grandparentState = await getActiveState(workspace);
      const grandparentRunId = grandparentState!.id;

      const token1 = grandparentState?.substepStates?.[0]?.delegation?.token;
      expect(token1).toEqual(expect.stringMatching(/^rdtk_/));
      if (typeof token1 !== 'string') throw new Error('Expected delegation token');

      // Claim — drop --text so we can capture claim_id / run_id from JSON output
      result = await runCliInProcess(`claim ${token1}`, workspace);
      expect(result.exitCode).toBe(0);
      const claimAction = findActionOutput(result.stdout);
      expect(claimAction).not.toBeNull();
      const parentRunId = String(claimAction!.run_id);
      const parentClaimId = String(claimAction!.claim_id);

      const parentState = await readRunbookState(workspace, parentRunId);
      expect(parentState).not.toBeNull();
      expect(parentState!.parentLinkage).toBeDefined();

      // Drive the claimed parent through its two substeps. Bare `pass` would
      // target the grandparent under reverted Route A — thread --claim-id so
      // each transition lands on the parent. The first pass resolves substep
      // 1.1 (whose body is `rd run child.runbook.md`); the second pass
      // resolves substep 1.2 and triggers parent COMPLETE → propagates PASS to
      // grandparent 1.1 → DEFER advances grandparent to 1.2.
      result = await runCliInProcess(['pass', '--claim-id', parentClaimId, '--text'], workspace);
      expect(result.exitCode).toBe(0);

      result = await runCliInProcess(['pass', '--claim-id', parentClaimId, '--text'], workspace);
      expect(result.exitCode).toBe(0);

      // Verify parent completed (reports PASS to grandparent 1.1, report-only).
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.lifecycle).toBe('completed');

      // Plan 5: the grandparent is NOT auto-advanced. It is collection pending
      // on substep 1.1 (one reported delegation outcome) until it collects.
      const gp = await readRunbookState(workspace, grandparentRunId);
      const gpRows = Object.values(gp!.resolvedCompletions ?? {}).filter(
        (c) => c.agentId === 'delegation',
      );
      expect(gpRows).toHaveLength(1);

      // A bare grandparent pass is refused while pending.
      const blocked = await runCliInProcess('pass', workspace);
      expect((JSON.parse(blocked.stdout) as { code?: string }).code).toBe(
        'DELEGATION_COLLECTION_PENDING',
      );

      // Explicit collect applies the reported outcome and advances the
      // grandparent to its remaining substep (1.2 Verify, non-delegated).
      const collected = await runCliInProcess('collect', workspace);
      expect(collected.exitCode).toBe(0);

      // Drive the grandparent's remaining substep to COMPLETE.
      result = await runCliInProcess('pass --text', workspace);

      // Verify grandparent completed
      const updatedGrandparent = await readRunbookState(workspace, grandparentRunId);
      expect(updatedGrandparent).not.toBeNull();
      expect(updatedGrandparent!.lifecycle).toBe('completed');
    });
  });

  describe('out-of-order completion', () => {
    it('substep 1.2 completes before 1.1 — completion stored but parent waits', async () => {
      // This test needs 2 substeps for out-of-order completion testing
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id;

      const token1 = await getAutoIssuedToken('1');
      const token2 = await getAutoIssuedToken('2');

      // Claim 1.2 first — drop --text to capture claim_id from JSON output
      result = await runCliInProcess(`claim ${token2}`, workspace);
      expect(result.exitCode).toBe(0);
      const claim2Action = findActionOutput(result.stdout);
      expect(claim2Action).not.toBeNull();
      const claimId2 = String(claim2Action!.claim_id);

      // Pass 1.2's child first — thread --claim-id so the pass lands on the child
      // rather than the parent (top of defaultStack under reverted Route A).
      result = await runCliInProcess(['pass', '--claim-id', claimId2, '--text'], workspace);
      expect(result.exitCode).toBe(0);

      // Parent cursor is at substep 1.1 (not yet resolved), so drain couldn't
      // consume the 1.2 completion. It should be stored in resolvedCompletions.
      const completions = await readResolvedCompletions(parentRunId);
      expect(Object.keys(completions).length).toBeGreaterThanOrEqual(1);

      // Parent should still be on step 1, substep 1 (waiting for 1.1)
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.step).toBe('1');
      expect(updatedParent!.substep).toBe('1');

      // Now claim and complete 1.1 — drop --text, capture claim_id, thread --claim-id
      result = await runCliInProcess(`claim ${token1}`, workspace);
      expect(result.exitCode).toBe(0);
      const claim1Action = findActionOutput(result.stdout);
      expect(claim1Action).not.toBeNull();
      const claimId1 = String(claim1Action!.claim_id);

      result = await runCliInProcess(['pass', '--claim-id', claimId1, '--text'], workspace);
      expect(result.exitCode).toBe(0);

      // Plan 5 (report-only): both outcomes are reported but uncollected, so the
      // parent is still on step 1. `rd collect` applies them and advances.
      result = await runCliInProcess('collect', workspace);
      expect(result.exitCode).toBe(0);

      // After collect, parent should advance past step 1
      // (PASS ALL: CONTINUE means it should advance to step 2)
      const finalParent = await readRunbookState(workspace, parentRunId);
      expect(finalParent).not.toBeNull();
      const step = finalParent!.step;
      const lifecycle = finalParent!.lifecycle;
      // Either on step 2 or completed
      expect(step === '2' || lifecycle === 'completed').toBe(true);
    });
  });

  describe('3-child concurrent out-of-order completion', () => {
    it('3 delegated substeps completed in reverse order — parent completes after all resolve', async () => {
      // Parent with 3 substeps
      const tripleParentContent = createRunbook({
        title: 'Triple Parent',
        steps: [
          {
            title: 'Pipeline',
            pass: 'COMPLETE',
            substeps: [
              {
                title: 'Task A',
                delegate: true,
                content: 'Task A.',
                runbooks: ['child.runbook.md'],
              },
              {
                title: 'Task B',
                delegate: true,
                content: 'Task B.',
                runbooks: ['child.runbook.md'],
              },
              {
                title: 'Task C',
                delegate: true,
                content: 'Task C.',
                runbooks: ['child.runbook.md'],
              },
            ],
          },
        ],
      });
      await writeFile(join(workspace.cwd, 'triple-parent.runbook.md'), tripleParentContent);
      await writeChildRunbook();

      // Start parent
      let result = await runCliInProcess(
        'run --prompted triple-parent.runbook.md --text',
        workspace,
      );
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id;

      const token1 = await getAutoIssuedToken('1');
      const token2 = await getAutoIssuedToken('2');
      const token3 = await getAutoIssuedToken('3');

      // Complete children in reverse order: 3, 2, 1.
      // Drop --text from each claim so we can capture claim_id and thread it
      // through the corresponding pass — bare pass would hit the parent under
      // reverted Route A.
      result = await runCliInProcess(`claim ${token3}`, workspace);
      expect(result.exitCode).toBe(0);
      const claim3Action = findActionOutput(result.stdout);
      expect(claim3Action).not.toBeNull();
      const claimId3 = String(claim3Action!.claim_id);
      result = await runCliInProcess(['pass', '--claim-id', claimId3, '--text'], workspace);
      expect(result.exitCode).toBe(0);

      // Parent should still be waiting (1.1 not yet resolved)
      const parentAfter3 = await readRunbookState(workspace, parentRunId);
      expect(parentAfter3).not.toBeNull();
      expect(parentAfter3!.step).toBe('1');

      result = await runCliInProcess(`claim ${token2}`, workspace);
      expect(result.exitCode).toBe(0);
      const claim2Action = findActionOutput(result.stdout);
      expect(claim2Action).not.toBeNull();
      const claimId2 = String(claim2Action!.claim_id);
      result = await runCliInProcess(['pass', '--claim-id', claimId2, '--text'], workspace);
      expect(result.exitCode).toBe(0);

      // Parent should still be waiting (1.1 not yet resolved)
      const parentAfter2 = await readRunbookState(workspace, parentRunId);
      expect(parentAfter2).not.toBeNull();
      expect(parentAfter2!.step).toBe('1');

      result = await runCliInProcess(`claim ${token1}`, workspace);
      expect(result.exitCode).toBe(0);
      const claim1Action = findActionOutput(result.stdout);
      expect(claim1Action).not.toBeNull();
      const claimId1 = String(claim1Action!.claim_id);
      result = await runCliInProcess(['pass', '--claim-id', claimId1, '--text'], workspace);
      expect(result.exitCode).toBe(0);

      // Plan 5 (report-only): all three outcomes are reported but uncollected.
      // `rd collect` applies them: PASS ALL → COMPLETE.
      result = await runCliInProcess('collect', workspace);
      expect(result.exitCode).toBe(0);

      const finalParent = await readRunbookState(workspace, parentRunId);
      expect(finalParent).not.toBeNull();
      expect(finalParent!.lifecycle).toBe('completed');
    });
  });

  describe('child outputs propagate into parent context', () => {
    it('child frontmatter outputs flow to parent via ResolvedCompletion.finalVars (not SET_VARIABLES)', async () => {
      // Parent: 2-substep step 1 then step 2 whose prompt references {{resultKey}}.
      // The child's resultKey value must reach parent.context.variables
      // via APPLY_CURRENT_RESOLVED_COMPLETION's finalVars merge, NOT via
      // a SET_VARIABLES event.
      const parentContent = [
        '---',
        'name: chain-outputs-parent',
        'inputs:',
        '  - resultKey',
        '---',
        '# Parent',
        '',
        '## 1. Review',
        '- PASS CONTINUE',
        '',
        '### 1.1 Delegated child',
        '- DELEGATE',
        '',
        'Child does the work.',
        '',
        '- child.runbook.md',
        '',
        '### 1.2 Verify',
        'After child: result is {{resultKey}}.',
        '',
        '## 2. Done',
        '- PASS COMPLETE',
        '',
        'Observed child result: {{resultKey}}.',
        '',
      ].join('\n');
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), parentContent);

      // Child has outputs: [resultKey], inputs: [resultKey] — when child
      // completes, state.finalVars carries { resultKey: <published value> }.
      const childContent = [
        '---',
        'name: chain-outputs-child',
        'inputs:',
        '  - resultKey',
        'outputs:',
        '  - resultKey',
        '---',
        '# Child',
        '',
        '## 1. Publish',
        '- PASS COMPLETE',
        '- FAIL STOP',
        '',
        'Publishing resultKey={{resultKey}}.',
        '',
      ].join('\n');
      await writeFile(join(workspace.cwd, 'child.runbook.md'), childContent);

      // Start parent in prompted mode (parent.inputs.resultKey has no value;
      // not required, so omitted at startup).
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      const parentRunId = parentState!.id;

      const token = await getAutoIssuedToken();

      // Claim with resultKey value — child captures this as finalVars on
      // completion via its frontmatter outputs declaration.
      result = await runCliInProcess(
        ['claim', token, '--input', 'resultKey=published-value'],
        workspace,
      );
      expect(result.exitCode).toBe(0);
      const claimAction = findActionOutput(result.stdout);
      expect(claimAction).not.toBeNull();
      const childRunId = String(claimAction!.run_id);
      const claimId = String(claimAction!.claim_id);

      // Pass child — REPORTS its outcome (with finalVars) onto the parent's
      // resolved completion (report-only). The parent does NOT yet advance or
      // merge the vars — that happens at collect.
      result = await runCliInProcess(['pass', '--claim-id', claimId, '--text'], workspace);
      if (result.exitCode !== 0) {
        throw new Error(`rd pass failed: ${result.stdout}\n${result.stderr}`);
      }

      // Child completed with finalVars set
      const finalChildState = await readRunbookState(workspace, childRunId);
      expect(finalChildState).not.toBeNull();
      expect(finalChildState!.lifecycle).toBe('completed');
      expect(finalChildState!.finalVars).toEqual({ resultKey: 'published-value' });

      // Plan 5: `rd collect` applies the reported outcome — it drains via
      // APPLY_CURRENT_RESOLVED_COMPLETION, merging finalVars into parent context
      // and advancing 1.1 PASS CONTINUE → substep 1.2.
      result = await runCliInProcess('collect', workspace);
      expect(result.exitCode).toBe(0);

      // Parent now sits at substep 1.2 (1.1 PASS CONTINUE), and {{resultKey}}
      // must already be visible in parent context because it was merged during
      // collect. The variable lives in parent state.variables (StoredOutputs).
      const parentAfter11 = await readRunbookState(workspace, parentRunId);
      expect(parentAfter11).not.toBeNull();
      expect(parentAfter11!.step).toBe('1');
      expect(parentAfter11!.substep).toBe('2');
      expect(parentAfter11!.variables).toEqual(
        expect.objectContaining({ resultKey: 'published-value' }),
      );

      // Drive substep 1.2 → parent step 2.
      result = await runCliInProcess('pass --text', workspace);
      expect(result.exitCode).toBe(0);

      // Step 2's prompt should be templated with the propagated value.
      // Look at step_entered events emitted during that pass.
      expect(result.stdout).toContain('published-value');

      const parentAfter12 = await readRunbookState(workspace, parentRunId);
      expect(parentAfter12).not.toBeNull();
      expect(parentAfter12!.step).toBe('2');
      // Variable persisted in parent state across the substep advance.
      expect(parentAfter12!.variables).toEqual(
        expect.objectContaining({ resultKey: 'published-value' }),
      );
    });
  });

  describe('edge cases', () => {
    it('handles completion when parent has no substep states', async () => {
      // Create a parent runbook without substeps
      const simpleParentContent = createRunbook({
        title: 'Simple Parent',
        steps: [{ title: 'Task', pass: 'COMPLETE', fail: 'STOP', content: 'Do the task.' }],
      });
      await writeFile(join(workspace.cwd, 'simple-parent.runbook.md'), simpleParentContent);

      // This scenario shouldn't normally happen with delegation, but test defensive handling
      // Start a simple parent that completes immediately
      const result = await runCliInProcess('run simple-parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('handles propagation when parent is already completed', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();

      const token = await getAutoIssuedToken();

      // Manually complete the parent before claiming
      result = await runCliInProcess('pass --text', workspace);
      expect(result.exitCode).toBe(0);
      result = await runCliInProcess('pass --text', workspace);
      expect(result.exitCode).toBe(0);

      // Now claim and complete child - parent already done.
      // Drop --text so we can capture claim_id, then thread it through pass.
      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      const claimAction = findActionOutput(result.stdout);
      expect(claimAction).not.toBeNull();
      const claimId = String(claimAction!.claim_id);

      result = await runCliInProcess(['pass', '--claim-id', claimId, '--text'], workspace);
      // Should succeed even though parent is already done
      expect(result.exitCode).toBe(0);
    });

    it('handles concurrent delegation completions gracefully', async () => {
      // This test needs 2 substeps for concurrent delegation
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const token1 = await getAutoIssuedToken('1');
      const token2 = await getAutoIssuedToken('2');

      // Claim both — drop --text so we can capture each claim_id from JSON
      result = await runCliInProcess(`claim ${token1}`, workspace);
      expect(result.exitCode).toBe(0);
      const claim1Action = findActionOutput(result.stdout);
      expect(claim1Action).not.toBeNull();
      const claimId1 = String(claim1Action!.claim_id);

      result = await runCliInProcess(`claim ${token2}`, workspace);
      expect(result.exitCode).toBe(0);
      const claim2Action = findActionOutput(result.stdout);
      expect(claim2Action).not.toBeNull();
      const claimId2 = String(claim2Action!.claim_id);

      // Complete both in quick succession — thread --claim-id so each pass
      // hits the right child rather than the parent (top of defaultStack).
      result = await runCliInProcess(['pass', '--claim-id', claimId1, '--text'], workspace);
      expect(result.exitCode).toBe(0);

      result = await runCliInProcess(['pass', '--claim-id', claimId2, '--text'], workspace);
      expect(result.exitCode).toBe(0);

      // Both should complete successfully
    });

    it('handles pass command without delegation linkage', async () => {
      await writeChildRunbook();

      // Start a standalone child runbook (no parent)
      let result = await runCliInProcess('run --prompted child.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const childState = await getActiveState(workspace);
      expect(childState).not.toBeNull();
      const childRunId = childState!.id;

      // Pass should work normally without propagation
      result = await runCliInProcess('pass --text', workspace);
      expect(result.exitCode).toBe(0);

      // Runbook completed and was deactivated — read state by ID
      const finalState = await readRunbookState(workspace, childRunId);
      expect(finalState).not.toBeNull();
      expect(finalState!.lifecycle).toBe('completed');
    });

    it('handles fail command without delegation linkage', async () => {
      await writeChildRunbook();

      // Start a standalone child runbook (no parent)
      let result = await runCliInProcess('run --prompted child.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const childState = await getActiveState(workspace);
      expect(childState).not.toBeNull();
      const childRunId = childState!.id;

      // Fail triggers STOP transition → exit code 1
      result = await runCliInProcess('fail --text', workspace);
      expect(result.exitCode).toBe(1);

      // Runbook stopped and was deactivated — read state by ID
      const finalState = await readRunbookState(workspace, childRunId);
      expect(finalState).not.toBeNull();
      expect(finalState!.lifecycle).toBe('stopped');
    });

    it('handles stop command without delegation linkage', async () => {
      await writeChildRunbook();

      // Start a standalone child runbook (no parent)
      let result = await runCliInProcess('run --prompted child.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      // Stop should work normally without propagation. Bare stop is a failure
      // terminal and exits non-zero.
      result = await runCliInProcess(['stop', 'User cancelled', '--text'], workspace);
      expect(result.exitCode).toBe(1);

      // State should be deleted
      const state = await getActiveState(workspace);
      expect(state).toBeNull();
    });
  });
});
