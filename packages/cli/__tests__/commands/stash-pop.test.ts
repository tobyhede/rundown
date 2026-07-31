import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  createRunbook,
  runCliInProcess,
  findActionOutput,
  parseConcatenatedJson,
  readSession,
  readRunbookState,
  getActiveState,
  seedExecutionOwnership,
  writeSession,
  requireFrontierToken,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import {
  issueRunControlClaimFor,
  patchPersistedRunState,
  seedRawRunState,
} from '@rundown-org/core/testing/session-fixtures';
import { makeDelegatedSubstepState } from '@rundown-org/core/testing/delegation-fixtures';
import { Command } from 'commander';
// Stryker static-import linkage (mutation testing): links this test file into
// Jest's static inverse-module graph so `--findRelatedTests` credits the
// behavioural tests below for BOTH command modules exercised here (which reach
// the commands only via the dynamic `import('../cli.js')` seam in
// runCliInProcess). This file is the per-command home for stash AND pop, so it
// statically imports both register functions. See collect.test.ts.
import { registerStashCommand } from '../../src/commands/stash.js';
import { registerPopCommand } from '../../src/commands/pop.js';
import {
  assertClaimId,
  assertDelegationTokenHash,
  assertRunId,
  buildFrameKey,
  claimKeyFromBearer,
  createDelegatedChildGrants,
  hashClaimSecret,
  parseClaimBearer,
  SessionService,
} from '@rundown-org/core';

const VALID_OTHER_CLAIM_ID = assertClaimId(
  'rdclm_00000000000000000000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
);
const MANUAL_CLAIM_ID = assertClaimId(
  'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
);

describe('stash/pop command wiring', () => {
  it('registers the stash command with its documented flags and descriptions', () => {
    const program = new Command();
    registerStashCommand(program);

    const stash = program.commands.find((c) => c.name() === 'stash');
    expect(stash).toBeDefined();
    expect(stash?.description()).toBe('Pause runbook enforcement, preserve state');

    const byLong = new Map(stash!.options.map((o) => [o.long, o]));
    expect([...byLong.keys()]).toEqual(expect.arrayContaining(['--claim-id', '--text']));
    expect(byLong.get('--claim-id')?.description).toBe('Target a claimed delegated child runbook');
    expect(byLong.get('--text')?.description).toBe('Output as human-readable text');
  });

  it('registers the pop command with its documented flags and descriptions', () => {
    const program = new Command();
    registerPopCommand(program);

    const pop = program.commands.find((c) => c.name() === 'pop');
    expect(pop).toBeDefined();
    expect(pop?.description()).toBe('Resume enforcement from stashed runbook');

    const byLong = new Map(pop!.options.map((o) => [o.long, o]));
    expect([...byLong.keys()]).toEqual(expect.arrayContaining(['--claim-id', '--text']));
    expect(byLong.get('--claim-id')?.description).toBe('Target a claimed delegated child runbook');
    expect(byLong.get('--text')?.description).toBe('Output as human-readable text');
  });
});

describe('stash command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  function getAutoIssuedToken(stdout: string): string {
    return requireFrontierToken(stdout, '1.1');
  }

  it('resolves and parks the active run in one core call, never getActive + stashRunbook', async () => {
    // Structural guard on the bare path's half of #666, and the only kind of
    // test that can hold it: every behavioural test here is sequential, so
    // restoring the `getActive()` -> `stashRunbook()` pair would leave all of
    // them green while reopening the window where a concurrent push means the
    // run that gets parked is not the one the command resolved. Atomicity is
    // "the CLI asks core exactly once", so that is what is asserted.
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const stash = jest.spyOn(SessionService.prototype, 'stash');
    const stashRunbook = jest.spyOn(SessionService.prototype, 'stashRunbook');
    const getActive = jest.spyOn(SessionService.prototype, 'getActive');

    const result = await runCliInProcess('stash', workspace);

    expect(result.exitCode).toBe(0);
    // One named object so the failure diff says which call moved.
    expect({
      atomicStash: stash.mock.calls.length,
      unlockedActiveReads: getActive.mock.calls.length,
      bearerBlindStashes: stashRunbook.mock.calls.length,
    }).toEqual({ atomicStash: 1, unlockedActiveReads: 0, bearerBlindStashes: 0 });
    jest.restoreAllMocks();
  });

  it('moves active runbook to stashed', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const beforeSession = await readSession(workspace);
    const runbookId = beforeSession.active;

    await runCliInProcess('stash --text', workspace);

    const afterSession = await readSession(workspace);
    expect(afterSession.stashed).toBe(runbookId);
  });

  it('clears active runbook', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    await runCliInProcess('stash --text', workspace);

    const session = await readSession(workspace);
    expect(session.active).toBeNull();
  });

  it('outputs stash confirmation', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('stash --text', workspace);

    expect(result.stdout).toContain('STASHED');
    expect(result.stdout).toContain('Runbook:');
  });

  it('fails if no active runbook', async () => {
    const result = await runCliInProcess('stash --text', workspace);

    expect(result.stdout).toContain('No active runbook');
  });

  it('preserves runbook state', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('pass --text', workspace); // Advance to step 2
    const beforeState = await getActiveState(workspace);

    await runCliInProcess('stash --text', workspace);
    await runCliInProcess('pop --text', workspace);

    const afterState = await getActiveState(workspace);
    expect(afterState?.step).toBe(beforeState?.step);
    expect(afterState?.runbook).toEqual(beforeState?.runbook);
  });

  it('returns non-zero when another runbook is already stashed', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('stash --text', workspace);
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('stash', workspace);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        error: 'A runbook is already stashed. Pop it first.',
        code: 'ALREADY_STASHED',
        command: 'stash',
      }),
    );
  });

  it('refuses to park a run whose persisted schema version is not current', async () => {
    // The atomicity fix above replaced this path's `getActive()` pre-read — and
    // with it `RunbookStateManager.load`'s schema-version gate, which the
    // in-transaction `ctx.readState` did not have. Restoring the pre-read would
    // reopen the check-then-act race, so the gate moved into
    // `RunbookStore.readRun`; this pins the caller-visible behaviour it restores.
    // Persisted state is never migrated: an unreadable version must be reported,
    // not parsed (CLAUDE.md, State Persistence).
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const state = await getActiveState(workspace);
    expect(state).not.toBeNull();
    await patchPersistedRunState(workspace.cwd, state!.id, { schemaVersion: 2 });

    const result = await runCliInProcess('stash', workspace);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'RD-999',
        error: expect.stringContaining(
          `Invalid runbook state for "${state!.id}": invalid schemaVersion; expected schema version 1.`,
        ),
      }),
    );
    // The decisive assertion: the refusal wrote nothing. A gate that reports and
    // still parks the run would leave the slot holding unreadable state.
    expect((await readSession(workspace)).stashed).toBeNull();
  });

  it('keeps claimed delegated children out of plain pop', async () => {
    const parent = createRunbook({
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
              runbooks: ['child.runbook.md'],
            },
          ],
        },
      ],
    });
    const child = createRunbook({
      title: 'Child',
      steps: [
        {
          title: 'Execute',
          pass: 'COMPLETE',
          fail: 'STOP',
          content: 'Run child.',
        },
      ],
    });
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), parent);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), child);

    let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);
    const token = getAutoIssuedToken(result.stdout);

    result = await runCliInProcess(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    const claimOutput = findActionOutput(result.stdout);
    const childRunId = String(claimOutput?.run_id);
    const claimId = String(claimOutput?.claim_id);

    result = await runCliInProcess(['stash', '--claim-id', claimId, '--text'], workspace);
    expect(result.exitCode).toBe(0);

    result = await runCliInProcess('pop', workspace);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'NO_STASHED_RUNBOOK',
      }),
    );

    let session = await readSession(workspace);
    expect(session.active).not.toBe(childRunId);
    expect(session.stashed).toBe(childRunId);

    result = await runCliInProcess(['pop', '--claim-id', claimId, '--text'], workspace);
    expect(result.exitCode).toBe(0);
    session = await readSession(workspace);
    expect(session.stashed).toBeNull();
    expect(session.active).not.toBe(childRunId);
    expect(Object.values(session.claims)).toContainEqual(
      expect.objectContaining({ controlledRunId: childRunId }),
    );
    const ownerStatus = await runCliInProcess(['status', '--claim-id', claimId], workspace);
    expect(JSON.parse(ownerStatus.stdout).runId).toBe(childRunId);
  });

  it('refuses pop with a different claim id', async () => {
    const parent = createRunbook({
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
              runbooks: ['child.runbook.md'],
            },
          ],
        },
      ],
    });
    const child = createRunbook({
      title: 'Child',
      steps: [
        {
          title: 'Execute',
          pass: 'COMPLETE',
          fail: 'STOP',
          content: 'Run child.',
        },
      ],
    });
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), parent);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), child);

    let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);
    const token = getAutoIssuedToken(result.stdout);

    result = await runCliInProcess(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    const claimOutput = findActionOutput(result.stdout);
    const childRunId = String(claimOutput?.run_id);
    const claimId = String(claimOutput?.claim_id);
    const otherClaimId = VALID_OTHER_CLAIM_ID;

    result = await runCliInProcess(['stash', '--claim-id', claimId, '--text'], workspace);
    expect(result.exitCode).toBe(0);

    result = await runCliInProcess(['pop', '--claim-id', otherClaimId], workspace);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
      }),
    );

    const session = await readSession(workspace);
    expect(session.stashed).toBe(childRunId);

    result = await runCliInProcess(['pop', '--claim-id', claimId, '--text'], workspace);
    expect(result.exitCode).toBe(0);
    const sessionAfterOwnerPop = await readSession(workspace);
    expect(sessionAfterOwnerPop.stashed).toBeNull();
    const ownerStatus = await runCliInProcess(['status', '--claim-id', claimId], workspace);
    expect(JSON.parse(ownerStatus.stdout).runId).toBe(childRunId);
  });

  it('prevents default stash from replacing a claimed child stash', async () => {
    const parent = createRunbook({
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
              runbooks: ['child.runbook.md'],
            },
          ],
        },
      ],
    });
    const child = createRunbook({
      title: 'Child',
      steps: [
        {
          title: 'Execute',
          pass: 'COMPLETE',
          fail: 'STOP',
          content: 'Run child.',
        },
      ],
    });
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), parent);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), child);

    let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);
    const token = getAutoIssuedToken(result.stdout);

    result = await runCliInProcess(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    const claimOutput = findActionOutput(result.stdout);
    const childRunId = String(claimOutput?.run_id);
    const claimId = String(claimOutput?.claim_id);

    result = await runCliInProcess(['stash', '--claim-id', claimId, '--text'], workspace);
    expect(result.exitCode).toBe(0);

    result = await runCliInProcess('stash', workspace);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'ALREADY_STASHED',
      }),
    );

    const session = await readSession(workspace);
    expect(session.stashed).toBe(childRunId);
    expect(Object.values(session.claims)).toContainEqual(
      expect.objectContaining({ controlledRunId: childRunId }),
    );
  });

  it('refuses to pop a claimed stash when the parent is terminal', async () => {
    const parent = createRunbook({
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
              runbooks: ['child.runbook.md'],
            },
          ],
        },
      ],
    });
    const child = createRunbook({
      title: 'Child',
      steps: [
        {
          title: 'Execute',
          pass: 'COMPLETE',
          fail: 'STOP',
          content: 'Run child.',
        },
      ],
    });
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), parent);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), child);

    let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);
    const parentState = await getActiveState(workspace);
    expect(parentState).not.toBeNull();

    const token = getAutoIssuedToken(result.stdout);
    result = await runCliInProcess(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    const output = findActionOutput(result.stdout);
    expect(output?.run_id).toBeDefined();
    expect(output?.claim_id).toBeDefined();
    const childRunId = String(output?.run_id);
    const claimId = String(output?.claim_id);

    result = await runCliInProcess(['stash', '--claim-id', claimId, '--text'], workspace);
    expect(result.exitCode).toBe(0);

    const latestParent = await readRunbookState(workspace, parentState!.id);
    expect(latestParent).not.toBeNull();
    await patchPersistedRunState(workspace.cwd, parentState!.id, {
      lifecycle: 'completed',
    });

    result = await runCliInProcess(['pop', '--claim-id', claimId], workspace);
    expect(result.exitCode).toBe(1);
    // The parent ending closed this delegation, so `rd pop` refuses with the same
    // typed no-retry signal the pass/fail seam gives — not a generic unavailable
    // envelope, and never "does not exist" (the claim is a real tombstone).
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'DELEGATION_SUPERSEDED',
        error: expect.stringContaining('moved past this delegation (parent-ended)'),
      }),
    );
    // The refusal must identify the claim by its non-secret lookup key and must
    // never echo the bearer secret segment (credential leak).
    expect(result.stdout).toContain(claimKeyFromBearer(assertClaimId(claimId)));
    expect(result.stdout).not.toContain(parseClaimBearer(claimId).secret);

    const session = await readSession(workspace);
    expect(session.stashed).toBe(childRunId);
    expect(session.active).not.toBe(childRunId);
  });

  // This pins the refusal envelope and the untouched stash slot — not the
  // #666 race itself. Rotating the bearer before invoking `stash` is already
  // caught by the pre-existing resolver staleness check: the OLD CLI path
  // (`resolveCommandTarget`) read the claim in a separate step before
  // mutating, and that pre-read already sees a rotation that happened first.
  // `stashForClaimId` has no separate feeding read at all — that is the
  // whole point of this change: verification happens inside the same
  // transaction that writes the slot. The actual #666 race — rotation
  // landing inside one command's own resolve-to-commit window — cannot be
  // observed from a sequential, in-process CLI test; the regression evidence
  // for that lives at the core layer in
  // `'refuses a bearer rotated after resolution and leaves the stash slot
  // untouched'` (packages/core/__tests__/runbook/session-service.test.ts).
  it('refuses a rotated run-control bearer with the documented JSON envelope', async () => {
    const runbookPath = 'solo.runbook.md';
    await writeFile(
      join(workspace.cwd, runbookPath),
      createRunbook({ title: 'Solo', steps: [{ title: 'First step' }] }),
    );
    const started = await runCliInProcess(['run', runbookPath], workspace);
    expect(started.exitCode).toBe(0);
    const startedEvent = parseConcatenatedJson(started.stdout).find(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' &&
        value !== null &&
        (value as { type?: unknown }).type === 'runbook_started',
    );
    const oldBearer = startedEvent?.claim_id;
    if (typeof oldBearer !== 'string') {
      throw new Error('Expected runbook_started to carry a claim_id');
    }
    const runId = (await readSession(workspace)).active;
    if (runId === null) throw new Error('Expected an active run');

    // Rotate: mint a replacement run-control claim for the same run. The old
    // bearer is now dead authority.
    await issueRunControlClaimFor(workspace.cwd, assertRunId(runId));

    const result = await runCliInProcess(['stash', '--claim-id', oldBearer], workspace);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
        command: 'stash',
        // A rotated bearer must render `superseded`'s wording, never the
        // generic `missing-claim` message — both share the same code, so a
        // core regression that swapped one status for the other would still
        // pass a code-only assertion here.
        error: expect.stringContaining('was released or replaced and is no longer authority'),
      }),
    );
    // The refusal must identify the claim by its non-secret lookup key.
    expect(result.stdout).toContain(claimKeyFromBearer(assertClaimId(oldBearer)));
    // The decisive assertion: the slot did not move.
    expect((await readSession(workspace)).stashed).toBeNull();
    // The bearer secret must never reach the transcript. `split('_')` is not a
    // safe extraction — the base64url secret segment can itself contain `_`,
    // so use the same parsed-secret helper the rest of this file relies on.
    expect(result.stdout).not.toContain(parseClaimBearer(assertClaimId(oldBearer)).secret);
  });

  it('stashes with a valid run-control bearer', async () => {
    const runbookPath = 'solo.runbook.md';
    await writeFile(
      join(workspace.cwd, runbookPath),
      createRunbook({ title: 'Solo', steps: [{ title: 'First step' }] }),
    );
    const started = await runCliInProcess(['run', runbookPath], workspace);
    const startedEvent = parseConcatenatedJson(started.stdout).find(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' &&
        value !== null &&
        (value as { type?: unknown }).type === 'runbook_started',
    );
    const bearer = startedEvent?.claim_id;
    if (typeof bearer !== 'string') {
      throw new Error('Expected runbook_started to carry a claim_id');
    }
    const runId = (await readSession(workspace)).active;

    const result = await runCliInProcess(['stash', '--claim-id', bearer], workspace);

    expect(result.exitCode).toBe(0);
    const session = await readSession(workspace);
    expect(session.stashed).toBe(runId);
    expect(session.active).toBeNull();
  });

  // Pins the two-envelope split `claimStashRefusal` introduces:
  // `already-stashed` (this claim's own run is already parked) must render
  // CLAIMED_RUNBOOK_UNAVAILABLE, distinct from `slot-occupied` (a different
  // run holds the slot) below, which renders ALREADY_STASHED. Nothing else
  // in this file distinguishes the two codes at the CLI boundary — swapping
  // the two `claimStashRefusal` return bodies would leave every other test
  // green.
  it('refuses re-stashing an already-stashed claim with CLAIMED_RUNBOOK_UNAVAILABLE', async () => {
    const runbookPath = 'solo.runbook.md';
    await writeFile(
      join(workspace.cwd, runbookPath),
      createRunbook({ title: 'Solo', steps: [{ title: 'First step' }] }),
    );
    const started = await runCliInProcess(['run', runbookPath], workspace);
    expect(started.exitCode).toBe(0);
    const startedEvent = parseConcatenatedJson(started.stdout).find(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' &&
        value !== null &&
        (value as { type?: unknown }).type === 'runbook_started',
    );
    const bearer = startedEvent?.claim_id;
    if (typeof bearer !== 'string') {
      throw new Error('Expected runbook_started to carry a claim_id');
    }
    const runId = (await readSession(workspace)).active;
    if (runId === null) throw new Error('Expected an active run');

    const first = await runCliInProcess(['stash', '--claim-id', bearer], workspace);
    expect(first.exitCode).toBe(0);

    const second = await runCliInProcess(['stash', '--claim-id', bearer], workspace);

    expect(second.exitCode).toBe(1);
    const claimKey = claimKeyFromBearer(assertClaimId(bearer));
    expect(JSON.parse(second.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
        command: 'stash',
        error: `Claim id ${claimKey} is currently stashed. Run \`rundown pop\` with its claim id to resume.`,
      }),
    );
    const session = await readSession(workspace);
    expect(session.stashed).toBe(runId);
  });

  it('refuses a claimed stash when the slot already holds a different run, with ALREADY_STASHED', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const otherRunId = (await readSession(workspace)).active;
    if (otherRunId === null) throw new Error('Expected an active run');

    const bareStash = await runCliInProcess('stash --text', workspace);
    expect(bareStash.exitCode).toBe(0);
    expect((await readSession(workspace)).stashed).toBe(otherRunId);

    const childPath = 'solo.runbook.md';
    await writeFile(
      join(workspace.cwd, childPath),
      createRunbook({ title: 'Solo', steps: [{ title: 'First step' }] }),
    );
    const childStarted = await runCliInProcess(['run', childPath], workspace);
    expect(childStarted.exitCode).toBe(0);
    const childStartedEvent = parseConcatenatedJson(childStarted.stdout).find(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' &&
        value !== null &&
        (value as { type?: unknown }).type === 'runbook_started',
    );
    const childBearer = childStartedEvent?.claim_id;
    if (typeof childBearer !== 'string') {
      throw new Error('Expected runbook_started to carry a claim_id');
    }

    const result = await runCliInProcess(['stash', '--claim-id', childBearer], workspace);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'ALREADY_STASHED',
        command: 'stash',
        error: 'A runbook is already stashed. Pop it first.',
      }),
    );
    const session = await readSession(workspace);
    expect(session.stashed).toBe(otherRunId);
  });

  // Pins the `stashResult.kind !== 'committed'` guards on both the bare and
  // `--claim-id` paths: a session mutation that core refuses because the run
  // is execution-owned must be rendered as EXECUTION_IN_PROGRESS and must
  // leave the stash slot untouched. `seedExecutionOwnership` writes the same
  // `runs.exec_token` state a real in-flight `rd pass`/`rd fail` execution
  // lease would hold — no raw SQL hand-rolled here.
  it('refuses bare stash with EXECUTION_IN_PROGRESS while the active run is execution-owned', async () => {
    const runbookPath = 'solo.runbook.md';
    await writeFile(
      join(workspace.cwd, runbookPath),
      createRunbook({ title: 'Solo', steps: [{ title: 'First step' }] }),
    );
    const started = await runCliInProcess(['run', runbookPath], workspace);
    expect(started.exitCode).toBe(0);
    const runId = (await readSession(workspace)).active;
    if (runId === null) throw new Error('Expected an active run');

    seedExecutionOwnership(workspace, assertRunId(runId));

    const result = await runCliInProcess(['stash'], workspace);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'EXECUTION_IN_PROGRESS',
        command: 'stash',
        error: `Run ${runId} has an execution in progress.`,
      }),
    );
    expect((await readSession(workspace)).stashed).toBeNull();
  });

  it('refuses stash --claim-id with EXECUTION_IN_PROGRESS while the claimed run is execution-owned', async () => {
    const runbookPath = 'solo.runbook.md';
    await writeFile(
      join(workspace.cwd, runbookPath),
      createRunbook({ title: 'Solo', steps: [{ title: 'First step' }] }),
    );
    const started = await runCliInProcess(['run', runbookPath], workspace);
    expect(started.exitCode).toBe(0);
    const startedEvent = parseConcatenatedJson(started.stdout).find(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' &&
        value !== null &&
        (value as { type?: unknown }).type === 'runbook_started',
    );
    const bearer = startedEvent?.claim_id;
    if (typeof bearer !== 'string') {
      throw new Error('Expected runbook_started to carry a claim_id');
    }
    const runId = (await readSession(workspace)).active;
    if (runId === null) throw new Error('Expected an active run');

    seedExecutionOwnership(workspace, assertRunId(runId));

    const result = await runCliInProcess(['stash', '--claim-id', bearer], workspace);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'EXECUTION_IN_PROGRESS',
        command: 'stash',
        error: `Run ${runId} has an execution in progress.`,
      }),
    );
    expect((await readSession(workspace)).stashed).toBeNull();
  });

  // Pins the promise docs/reference/cli.md makes for `stash --claim-id`
  // (§"rundown stash", and the RD-825 list under Delegation semantics): once
  // the parent has moved past the delegation, `stash` reports
  // DELEGATION_SUPERSEDED *with the no-retry instruction*, not a generic
  // unavailable envelope. The rotation test above covers `claim-rotated` →
  // CLAIMED_RUNBOOK_UNAVAILABLE, which is a different arm and carries no
  // no-retry signal, so nothing else at the CLI boundary pins this one.
  it('refuses stash --claim-id with DELEGATION_SUPERSEDED once the parent has moved on', async () => {
    const parent = createRunbook({
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
              runbooks: ['child.runbook.md'],
            },
          ],
        },
      ],
    });
    const child = createRunbook({
      title: 'Child',
      steps: [{ title: 'Execute', pass: 'COMPLETE', fail: 'STOP', content: 'Run child.' }],
    });
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), parent);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), child);

    let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
    expect(result.exitCode).toBe(0);
    const parentState = await getActiveState(workspace);
    expect(parentState).not.toBeNull();

    const token = await getAutoIssuedToken();
    result = await runCliInProcess(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    const output = findActionOutput(result.stdout);
    const claimId = String(output?.claim_id);
    expect(claimId).toEqual(expect.stringMatching(/^rdclm_/));

    // The parent ends, closing the delegation. The child is never stashed, so
    // the slot is empty and any write by the refused command would be visible.
    await patchPersistedRunState(workspace.cwd, parentState!.id, { lifecycle: 'completed' });

    result = await runCliInProcess(['stash', '--claim-id', claimId], workspace);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'DELEGATION_SUPERSEDED',
        command: 'stash',
        error: expect.stringContaining(
          'moved past this delegation (parent-ended). Do not retry the token; report the superseded delegation to the orchestrator.',
        ),
      }),
    );
    expect(result.stdout).toContain(claimKeyFromBearer(assertClaimId(claimId)));
    expect(result.stdout).not.toContain(parseClaimBearer(assertClaimId(claimId)).secret);
    // The decisive assertion: the refusal wrote nothing.
    expect((await readSession(workspace)).stashed).toBeNull();
  });
});

describe('pop command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('restores stashed runbook to active', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const beforeSession = await readSession(workspace);
    const runbookId = beforeSession.active;

    await runCliInProcess('stash --text', workspace);
    await runCliInProcess('pop --text', workspace);

    const afterSession = await readSession(workspace);
    expect(afterSession.active).toBe(runbookId);
  });

  it('restores an anonymous stash without claim id', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const beforeSession = await readSession(workspace);
    const runbookId = beforeSession.active;
    if (!runbookId) throw new Error('Expected active runbook before stash');
    await runCliInProcess('stash --text', workspace);

    const result = await runCliInProcess('pop --text', workspace);

    expect(result.exitCode).toBe(0);
    const afterSession = await readSession(workspace);
    expect(afterSession.stashed).toBeNull();
    expect(afterSession.active).toBe(runbookId);
  });

  it('refuses to restore a run whose persisted schema version is not current', async () => {
    // The sibling of the stash case above. `pop` never had the gate — it has
    // always read through `ctx.readState` — so this is a pre-existing hole the
    // same `RunbookStore.readRun` check closes, not a regression on this branch.
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const state = await getActiveState(workspace);
    expect(state).not.toBeNull();
    await runCliInProcess('stash', workspace);
    await patchPersistedRunState(workspace.cwd, state!.id, { schemaVersion: 2 });

    const result = await runCliInProcess('pop', workspace);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'RD-999',
        error: expect.stringContaining(
          `Invalid runbook state for "${state!.id}": invalid schemaVersion; expected schema version 1.`,
        ),
      }),
    );
    // The run stays parked. Recovery is explicit — prune or restart — never an
    // unstash that makes unreadable state active again.
    expect((await readSession(workspace)).stashed).toBe(state!.id);
  });

  it('emits INVALID_CLAIM_ID for invalid claim id', async () => {
    const result = await runCliInProcess('pop --claim-id not-a-claim', workspace);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'INVALID_CLAIM_ID',
      }),
    );
  });

  it('anonymous caller can still restore an anonymous stash', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const beforeSession = await readSession(workspace);
    const runbookId = beforeSession.active;
    await runCliInProcess('stash --text', workspace);

    const result = await runCliInProcess('pop --text', workspace);

    expect(result.exitCode).toBe(0);
    const afterSession = await readSession(workspace);
    expect(afterSession.active).toBe(runbookId);
    expect(afterSession.stashed).toBeNull();
  });

  it('clears stashed state', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('stash --text', workspace);

    await runCliInProcess('pop --text', workspace);

    const session = await readSession(workspace);
    expect(session.stashed).toBeNull();
  });

  it('outputs restored runbook info', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('stash --text', workspace);

    const result = await runCliInProcess('pop --text', workspace);

    expect(result.stdout).toContain('First step');
    expect(result.stdout).toContain('## 1');
  });

  it('fails if nothing stashed', async () => {
    const result = await runCliInProcess('pop --text', workspace);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No stashed runbook');
  });

  it('shows resuming step info', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('pass --text', workspace); // Advance to step 2
    await runCliInProcess('stash --text', workspace);

    const result = await runCliInProcess('pop --text', workspace);

    expect(result.stdout).toContain('Second step');
  });

  it('outputs error when step not found in runbook', async () => {
    // Create a state file with a step that doesn't exist in the runbook
    // runbookSrc must be present for pop to read from stored content
    const runbookId = `rd_${'3'.repeat(32)}`;
    const runbookSrc = `# Test Runbook

## 1. First step
- PASS COMPLETE

\`\`\`bash
rd echo "hello"
\`\`\`
`;
    const state = {
      id: runbookId,
      runbook: { source: 'project', path: 'runbooks/simple.runbook.md' },
      runbookPath: join(workspace.cwd, 'runbooks', 'simple.runbook.md'),
      title: 'Test Runbook',
      step: 'NonExistentStep', // Step that doesn't exist in runbookSrc
      stepName: 'A step that does not exist',
      retryCount: 0,
      variables: {},
      templateVars: { ContextId: 'stash-pop-ctx', WorkPath: '.rundown/work' },
      steps: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runbookSrc, // Include runbookSrc so pop can read steps
      lifecycle: 'running',
      schemaVersion: 1,
    };
    await seedRawRunState(workspace.cwd, state);

    // Set up session to have this runbook stashed (with empty defaultStack)
    await writeSession(workspace, { stashed: runbookId, defaultStack: [] });

    const result = await runCliInProcess('pop --text', workspace);

    // Text mode should NOT be silent - should show error message on stderr
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not found');
  });

  it('restores a claimed stash using captured claim provenance', async () => {
    const runbookId = `rd_${'4'.repeat(32)}`;
    const parentRunId = `rd_${'5'.repeat(32)}`;
    await seedRawRunState(workspace.cwd, {
      id: parentRunId,
      runbook: { source: 'project', path: 'parent.runbook.md' },
      runbookPath: 'parent.runbook.md',
      title: 'Parent Runbook',
      step: '1',
      stepName: 'Parent step',
      retryCount: 0,
      variables: {},
      templateVars: { ContextId: 'stash-pop-ctx', WorkPath: '.rundown/work' },
      steps: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runbookSrc: '# Parent\n\n## 1. Parent step\n- PASS CONTINUE\n',
      // The parent must carry the delegation on its substep row, because that is
      // what `rundown delegate` writes and what claim liveness is classified
      // against. A hand-seeded parent without it is indistinguishable from one
      // whose cursor advanced past the delegation, and pop correctly refuses it.
      // Built by the shared factory so the shape cannot drift from the real type.
      substepStates: [
        makeDelegatedSubstepState({
          id: '1',
          delegation: {
            tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
            childRunbookPath: 'owned.runbook.md',
            childRunbookRef: { source: 'project', path: 'owned.runbook.md' },
          },
        }),
      ],
      lifecycle: 'running',
      schemaVersion: 1,
    });
    const runbookSrc = [
      '# Test Runbook',
      '',
      '## 1. First step',
      '- PASS COMPLETE',
      '',
      'Do work.',
      '',
    ].join('\n');
    await seedRawRunState(workspace.cwd, {
      id: runbookId,
      runbook: { source: 'project', path: 'owned.runbook.md' },
      runbookPath: 'owned.runbook.md',
      title: 'Test Runbook',
      step: '1',
      stepName: 'First step',
      retryCount: 0,
      variables: {},
      templateVars: { ContextId: 'stash-pop-ctx', WorkPath: '.rundown/work' },
      steps: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runbookSrc,
      parentLinkage: {
        kind: 'delegation',
        parentRunId,
        parentStepId: '1',
        parentStep: '1',
        parentFrameKey: '1|',
        parentEntry: 1,
        tokenHash: `sha256:${'a'.repeat(64)}`,
      },
      lifecycle: 'running',
      schemaVersion: 1,
    });

    const parsedClaim = parseClaimBearer(MANUAL_CLAIM_ID);
    const linkage = {
      childRunId: assertRunId(runbookId),
      tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
      parentRunId: assertRunId(parentRunId),
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: buildFrameKey('1'),
      parentEntry: 1,
    };
    await writeSession(workspace, {
      stashed: runbookId,
      defaultStack: [],
      claims: {
        [claimKeyFromBearer(MANUAL_CLAIM_ID)]: {
          claimKey: parsedClaim.claimKey,
          secretHash: hashClaimSecret(parsedClaim.secret),
          controlledRunId: assertRunId(runbookId),
          delegation: linkage,
          grants: createDelegatedChildGrants({ linkage }),
          issuedAt: '2026-04-28T00:00:00.000Z',
          updatedAt: '2026-04-28T00:00:00.000Z',
          lastSeenAt: '2026-04-28T00:00:00.000Z',
        },
      },
    });

    const result = await runCliInProcess(`pop --claim-id ${MANUAL_CLAIM_ID}`, workspace);

    expect(result.exitCode).toBe(0);
    const session = await readSession(workspace);
    expect(session.active).not.toBe(runbookId);
    expect(session.stashed).toBeNull();
    const ownerStatus = await runCliInProcess(`status --claim-id ${MANUAL_CLAIM_ID}`, workspace);
    expect(JSON.parse(ownerStatus.stdout).runId).toBe(runbookId);
  });
});
