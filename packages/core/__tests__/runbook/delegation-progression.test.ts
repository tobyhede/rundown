import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseRunbookDocument } from '@rundown-org/parser';
import { RunbookStateManager, generateRunId } from '../../src/runbook/state.js';
import { RunbookActorService } from '../../src/runbook/actor-service.js';
import { closeRunbookStore, getRunbookStore } from '../../src/runbook/storage/store-registry.js';
import { ExecutionEventEmitter } from '../../src/events/emitter.js';
import type { RunbookEventV1, StepEnteredChild } from '../../src/events/types.js';
import type { CommandExecutionServices } from '../../src/runbook/actors/command-exec-actor.js';
import type { ResolvedRunbook, ResolvedStep, RunbookState } from '../../src/runbook/types.js';
import {
  generateClaimTicket,
  generateOwnerToken,
  hashRunSecret,
  parseClaimTicket,
  type OwnerToken,
} from '../../src/runbook/run-secrets.js';
import {
  activateRunProgression,
  progressionDirectiveForStartedRun,
  type RunProgressionDeps,
  type RunProgressionDirective,
  type RunProgressionOutcome,
} from '../../src/runbook/run-progression.js';
import {
  RunbookLifecycleCommandService,
  type CommandTargetPurpose,
} from '../../src/runbook/lifecycle-command-service.js';
import { claimDelegation } from '../../src/runbook/delegation-progression.js';
import { releaseDelegation } from '../../src/runbook/delegation-recovery.js';
import type { RunId } from '../../src/runbook/run-id.js';
import type { PrepareChildRun } from '../../src/runbook/child-preparation.js';

// Delegation (#904, ADR 0005) through the public seams: Run Progression's
// activation (ticket issuance on entry), `claimDelegation`, the lifecycle
// seam's target resolution (a child's standing) and `runCollect`. Real
// SQLite, real machine; the only doubles are the command runner and the
// frontend's child preparer.

const CHILD_PASS = `---
name: child-pass
outputs:
  - Verdict "approved"
---
# Child pass

## 1. Work
- PASS COMPLETE
- FAIL STOP

\`\`\`bash
echo child
\`\`\`
`;

const CHILD_MANUAL = `# Child manual

## 1. Check
- PASS COMPLETE
- FAIL STOP

Check by hand.
`;

const FAN_OUT = `# Fan out

## 1. Review
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

- child-manual.runbook.md
- child-manual.runbook.md
- child-manual.runbook.md
- child-manual.runbook.md

## 2. Done
- PASS COMPLETE
- FAIL STOP

Finish by hand.
`;

const SINGLE = `# Single

## 1. Delegate
- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

- child-pass.runbook.md
`;

const SINGLE_MANUAL = `# Single manual

## 1. Delegate
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

- child-manual.runbook.md

## 2. Check
- PASS COMPLETE
- FAIL GOTO 1

Check by hand.
`;

const FOR_DELEGATE = `# For delegate

## 1. Each
- FOR item IN 1 TO 2
  - PASS DEFER
  - FAIL BREAK
- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

- child-manual.runbook.md
`;

const FIRST_FAIL_STOPS = `# First fail stops

## 1. Review
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 First
- DELEGATE
- FAIL STOP

- child-manual.runbook.md

### 1.2 Second
- DELEGATE

- child-manual.runbook.md

## 2. Done
- PASS COMPLETE
- FAIL STOP

Finish by hand.
`;

const FIRST_FAIL_LEAVES = `# First fail leaves

## 1. Review
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 First
- DELEGATE
- FAIL GOTO 2

- child-manual.runbook.md

### 1.2 Second
- DELEGATE

- child-manual.runbook.md

## 2. Done
- PASS COMPLETE
- FAIL STOP

Finish by hand.
`;

const INLINE_DELEGATING = `# Inline delegating

## 1. Compose
- PASS ALL COMPLETE
- FAIL ANY STOP

- single.runbook.md
`;

const SOURCES: Readonly<Partial<Record<string, string>>> = {
  'child-pass.runbook.md': CHILD_PASS,
  'child-manual.runbook.md': CHILD_MANUAL,
  'single.runbook.md': SINGLE,
};

let dir: string;
let manager: RunbookStateManager;
let actorService: RunbookActorService;
/** Every event, from every run's sink, in emission order. */
let events: RunbookEventV1[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-delegation-'));
  manager = new RunbookStateManager(dir);
  actorService = new RunbookActorService(manager, { commandServices: succeeding() });
  events = [];
});

afterEach(async () => {
  await closeRunbookStore(dir);
  await fs.rm(dir, { recursive: true, force: true });
});

function succeeding(): CommandExecutionServices {
  return { runExternalCommand: async () => ({ success: true, exitCode: 0 }) };
}

function parse(markdown: string): ResolvedRunbook {
  return parseRunbookDocument(markdown).runbook as ResolvedRunbook;
}

function builtins(runId: string, file: string): Record<string, unknown> {
  return {
    RunId: runId,
    WorkPath: '.rundown/work',
    ContextId: `ctx-${runId}`,
    RunbookRef: { source: 'project', path: file },
  };
}

/** The frontend's preparer, standing in for the CLI's file-reading service. */
const prepare: PrepareChildRun = async ({ reservation }) => {
  const source = SOURCES[reservation.runbook];
  if (source === undefined) {
    return { kind: 'refused', code: 'RUNBOOK_NOT_FOUND', message: `no ${reservation.runbook}` };
  }
  return {
    kind: 'prepared',
    runbookRef: { source: 'project', path: reservation.runbook },
    runbook: parse(source),
    runbookPath: reservation.runbook,
    runbookSrc: source,
    templateVars: builtins(reservation.runId, reservation.runbook) as never,
    initialVariables: {},
    frontmatterOutputs: parseRunbookDocument(source).frontmatter?.outputs ?? [],
  };
};

function loadSteps(state: RunbookState): readonly ResolvedStep[] {
  return parse(state.runbookSrc ?? '').steps;
}

function sinkFor(state: RunbookState): ExecutionEventEmitter {
  const emitter = new ExecutionEventEmitter(state.id, state.runbook);
  emitter.subscribe((event) => {
    events.push(event);
  });
  return emitter;
}

function deps(state: RunbookState): RunProgressionDeps {
  return {
    manager,
    actorService,
    loadSteps,
    sink: sinkFor(state),
    sinkFor,
    prepareChildRun: prepare,
  };
}

async function activate(
  directive: RunProgressionDirective,
  state: RunbookState,
): Promise<RunProgressionOutcome> {
  if (directive.kind !== 'activate') throw new Error('expected an activation');
  return activateRunProgression(directive.authority, deps(state), directive.entryBoundary);
}

/** Start a root run as `rundown run` does and activate its progression. */
async function start(markdown: string): Promise<{ root: RunbookState; token: OwnerToken }> {
  const runId = generateRunId();
  const token = generateOwnerToken();
  const runbook = parse(markdown);
  await manager.create({ source: 'project', path: 'parent.runbook.md' }, runbook, {
    runId,
    runbookPath: 'parent.runbook.md',
    ownerTokenHash: hashRunSecret(token),
    runbookSrc: markdown,
    frontmatterOutputs: [],
    templateVars: builtins(runId, 'parent.runbook.md') as never,
  });
  const root = await actorService.initializeState(runId, runbook.steps);
  if (root === null) throw new Error('seed failed');
  await activate(progressionDirectiveForStartedRun(root, runbook.steps), root);
  return { root, token };
}

/**
 * A state manager that runs `interleave` once — right after its first
 * committed save, or right before its first save — standing in for another
 * writer landing between a command's read and its save, or between two saves.
 */
class InterleavingManager extends RunbookStateManager {
  #interleave: (() => Promise<void>) | undefined;
  readonly #when: 'before' | 'after';

  constructor(cwd: string, interleave: () => Promise<void>, when: 'before' | 'after' = 'after') {
    super(cwd);
    this.#interleave = interleave;
    this.#when = when;
  }

  override async save(
    ...args: Parameters<RunbookStateManager['save']>
  ): ReturnType<RunbookStateManager['save']> {
    const interleave = this.#interleave;
    if (this.#when === 'before' && interleave !== undefined) {
      this.#interleave = undefined;
      await interleave();
      return super.save(...args);
    }
    const saved = await super.save(...args);
    if (saved.kind === 'committed' && interleave !== undefined) {
      this.#interleave = undefined;
      await interleave();
    }
    return saved;
  }
}

function seam(): RunbookLifecycleCommandService {
  return new RunbookLifecycleCommandService({ manager, actorService, loadSteps });
}

/** The children listed by the most recent `step_entered` of `runId`. */
function enteredChildren(runId: string): readonly StepEnteredChild[] {
  const entered = events.filter(
    (event): event is RunbookEventV1 & { type: 'STEP_ENTERED' } =>
      event.type === 'STEP_ENTERED' && event.runbookId === runId,
  );
  return entered.at(-1)?.payload.children ?? [];
}

/** Every ticket issued so far for `runId`, in issue order. */
function ticketsOf(runId: string) {
  return events
    .filter(
      (event): event is RunbookEventV1 & { type: 'STEP_ENTERED' } =>
        event.type === 'STEP_ENTERED' && event.runbookId === runId,
    )
    .flatMap((event) => event.payload.children ?? [])
    .flatMap((child) => (child.ticket === undefined ? [] : [child.ticket]));
}

async function claim(ticket: string, agentId?: string) {
  const outcome = await claimDelegation(
    { manager, actorService, loadSteps, prepareChildRun: prepare },
    { ticket: parseClaimTicket(ticket), ...(agentId !== undefined ? { agentId } : {}) },
  );
  if (outcome.kind === 'claimed') {
    await activate(outcome.progression, outcome.child.state);
  }
  return outcome;
}

async function claimed(ticket: string) {
  const outcome = await claim(ticket);
  if (outcome.kind !== 'claimed') throw new Error(`claim refused: ${outcome.code}`);
  return outcome;
}

/** Claim a ticket as the named agent, failing the test on a refusal. */
async function claimedAs(ticket: string, agentId: string) {
  const outcome = await claim(ticket, agentId);
  if (outcome.kind !== 'claimed') throw new Error(`claim refused: ${outcome.code}`);
  return outcome;
}

/** Resolve a token's command target as a frontend does for `command`. */
async function target(token: OwnerToken, command: CommandTargetPurpose = 'pass') {
  return seam().resolveCommandTarget(
    token,
    async () => {
      throw new Error('no inline child to settle');
    },
    command,
  );
}

/** Drive one run's `pass --step` as its owner, activating progression after. */
async function pass(token: OwnerToken, step: string, index?: number): Promise<void> {
  const resolved = await target(token);
  if (resolved.kind !== 'running') throw new Error(`token refused: ${resolved.kind}`);
  const outcome = await seam().runTransition({
    command: 'pass',
    run: resolved.run,
    target: { stepId: step, ...(index !== undefined ? { iteration: index } : {}) },
  });
  if (outcome.kind !== 'applied') throw new Error(`pass refused: ${outcome.kind}`);
  await activate(outcome.progression, resolved.run.state);
}

/** Drive one child's `fail --step 1` as its owner. */
async function failChild(token: OwnerToken): Promise<void> {
  const resolved = await target(token);
  if (resolved.kind !== 'running') throw new Error(`token refused: ${resolved.kind}`);
  const outcome = await seam().runTransition({
    command: 'fail',
    run: resolved.run,
    target: { stepId: '1' },
  });
  if (outcome.kind !== 'applied') throw new Error(`fail refused: ${outcome.kind}`);
}

/** Drive `rundown collect --token` as the owner does. */
async function collect(token: OwnerToken) {
  const resolved = await target(token);
  if (resolved.kind !== 'running') throw new Error(`token refused: ${resolved.kind}`);
  const outcome = await seam().runCollect({ run: resolved.run });
  if (outcome.kind === 'collected' && outcome.progression.kind === 'activate') {
    await activate(outcome.progression, resolved.run.state);
  }
  return outcome;
}

describe('Delegation reservation and Claim Tickets (#904)', () => {
  it('lists one child per delegated substep, each with its ticket and runbook, on the step entry', async () => {
    const { root } = await start(FAN_OUT);

    const children = enteredChildren(root.id);
    expect(children.map((child) => [child.step, child.runbook])).toEqual([
      ['1.1', 'child-manual.runbook.md'],
      ['1.2', 'child-manual.runbook.md'],
      ['1.3', 'child-manual.runbook.md'],
      ['1.4', 'child-manual.runbook.md'],
    ]);
    expect(children.every((child) => child.ticket !== undefined)).toBe(true);
    expect(new Set(children.map((child) => child.runId)).size).toBe(4);
  });

  it("issues and prints the tickets on the owner's collect when the entry's issuance was refused", async () => {
    const runId = generateRunId();
    const token = generateOwnerToken();
    const runbook = parse(SINGLE_MANUAL);
    await manager.create({ source: 'project', path: 'parent.runbook.md' }, runbook, {
      runId,
      runbookPath: 'parent.runbook.md',
      ownerTokenHash: hashRunSecret(token),
      runbookSrc: SINGLE_MANUAL,
      frontmatterOutputs: [],
      templateVars: builtins(runId, 'parent.runbook.md') as never,
    });
    const root = await actorService.initializeState(runId, runbook.steps);
    if (root === null) throw new Error('seed failed');
    // Another of the owner's commands writes the run just before the entry's
    // ticket issuance saves, so that save is refused.
    const racing = new InterleavingManager(
      dir,
      async () => {
        const read = await manager.loadWithVersion(runId);
        if (read === null) throw new Error('root vanished');
        expect((await manager.save(read.state, read.stateVersion)).kind).toBe('committed');
      },
      'before',
    );
    const directive = progressionDirectiveForStartedRun(root, runbook.steps);
    const refused = await activateRunProgression(
      directive.authority,
      { ...deps(root), manager: racing },
      directive.entryBoundary,
    );
    expect(refused).toMatchObject({
      kind: 'refused',
      reason: 'claim_tickets_not_issued',
      code: 'CONCURRENT_MODIFICATION',
    });
    expect(refused.kind === 'refused' && refused.message).toContain('rundown collect');
    expect(ticketsOf(runId)).toEqual([]);

    const outcome = await collect(token);

    expect(outcome).toMatchObject({ kind: 'collected', children: [{ status: 'unclaimed' }] });
    const tickets = ticketsOf(runId);
    expect(tickets).toHaveLength(1);
    expect((await claim(tickets[0])).kind).toBe('claimed');
    // Printed once: a further collect lists the child without a ticket.
    await collect(token);
    expect(ticketsOf(runId)).toHaveLength(1);
  });

  it('persists only the hash of a ticket, never the ticket', async () => {
    const { root } = await start(SINGLE_MANUAL);
    const [ticket] = ticketsOf(root.id);
    const raw = JSON.stringify(await manager.load(root.id));
    expect(raw).not.toContain(ticket);
    expect(raw).toContain(hashRunSecret(parseClaimTicket(ticket)));
  });

  it('claims the reserved child under its preallocated id with an Owner Token of its own', async () => {
    const { root } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);

    const outcome = await claimed(child.ticket ?? '');

    expect(outcome.child.state.id).toBe(child.runId);
    expect(outcome.child.linkage).toEqual({
      kind: 'delegation',
      parentRunId: root.id,
      parentStep: '1.1',
      parentFrameKey: '1|',
      parentEntry: 1,
    });
    const resolved = await target(outcome.ownerToken);
    expect(resolved.kind === 'running' && resolved.run.state.id).toBe(child.runId);
  });

  it('claims by the ticket alone, never reading (or warning about) an unrelated invalid run', async () => {
    const { root } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    // Another run in the project whose persisted state no longer validates.
    const other = await manager.create({ source: 'project', path: 'other.md' }, parse(SINGLE), {
      ownerTokenHash: hashRunSecret(generateOwnerToken()),
      runbookPath: 'other.md',
    });
    const store = await getRunbookStore(dir);
    await store.transaction((txn) => {
      txn.tx
        .prepare('UPDATE runs SET state_json = :json WHERE id = :id')
        .run({ json: JSON.stringify({ ...other, artifactVars: {} }), id: other.id });
    });
    const writes: string[] = [];
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      expect((await claim(child.ticket ?? '')).kind).toBe('claimed');
    } finally {
      stderr.mockRestore();
    }

    expect(writes.filter((write) => write.includes('Warning'))).toEqual([]);
  });

  it('records the claiming agent on the child', async () => {
    const { root } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    const outcome = await claim(child.ticket ?? '', 'agent-7');
    expect(outcome.kind === 'claimed' && outcome.child.linkage?.claimedBy).toBe('agent-7');
  });

  it('refuses a second claim of the same ticket ALREADY_CLAIMED', async () => {
    const { root } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    await claimed(child.ticket ?? '');
    expect(await claim(child.ticket ?? '')).toMatchObject({
      kind: 'refused',
      code: 'ALREADY_CLAIMED',
    });
  });

  it('refuses a ticket no reservation carries UNKNOWN_TICKET', async () => {
    await start(SINGLE_MANUAL);
    expect(await claim(generateClaimTicket())).toMatchObject({
      kind: 'refused',
      code: 'UNKNOWN_TICKET',
    });
  });

  it('refuses a claim after the parent reached a terminal PARENT_RUN_FINISHED', async () => {
    const { root, token } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    const resolved = await target(token);
    if (resolved.kind !== 'running') throw new Error('expected a running root');
    await seam().runTerminal({ command: 'stop', run: resolved.run });

    expect(await claim(child.ticket ?? '')).toMatchObject({
      kind: 'refused',
      code: 'PARENT_RUN_FINISHED',
    });
    expect(await manager.load(child.runId)).toBeNull();
  });
});

describe('Collect (#904)', () => {
  it('applies a passing child, flowing its outputs, and continues the parent', async () => {
    const { root, token } = await start(SINGLE);
    const [child] = enteredChildren(root.id);
    await claimed(child.ticket ?? '');

    const outcome = await collect(token);

    expect(outcome).toMatchObject({
      kind: 'collected',
      children: [{ step: '1.1', runId: child.runId, status: 'collected', result: 'pass' }],
    });
    const parent = await manager.load(root.id);
    expect(parent?.lifecycle).toBe('completed');
    expect(parent?.variables).toMatchObject({ Verdict: 'approved' });
  });

  it('applies a failing child as the substep FAIL', async () => {
    const { root, token } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    const { ownerToken } = await claimed(child.ticket ?? '');
    const resolved = await target(ownerToken);
    if (resolved.kind !== 'running') throw new Error('expected a running child');
    const failed = await seam().runTransition({
      command: 'fail',
      run: resolved.run,
      target: { stepId: '1' },
    });
    expect(failed.kind).toBe('applied');

    expect(await collect(token)).toMatchObject({
      children: [{ status: 'collected', result: 'fail' }],
    });
    expect((await manager.load(root.id))?.lifecycle).toBe('stopped');
  });

  it('collects a fan-out of four once every child is terminal', async () => {
    const { root, token } = await start(FAN_OUT);
    for (const child of enteredChildren(root.id)) {
      const { ownerToken } = await claimed(child.ticket ?? '');
      await pass(ownerToken, '1');
    }

    const outcome = await collect(token);

    expect(outcome.kind === 'collected' && outcome.children.map((child) => child.status)).toEqual([
      'collected',
      'collected',
      'collected',
      'collected',
    ]);
    const parent = await manager.load(root.id);
    expect(parent?.step).toBe('2');
  });

  it('reports a pending child and applies nothing for it; a later collect applies it', async () => {
    const { root, token } = await start(FAN_OUT);
    const children = enteredChildren(root.id);
    const owners: OwnerToken[] = [];
    for (const child of children) owners.push((await claimed(child.ticket ?? '')).ownerToken);
    // The first child is still running; the other three have passed.
    for (const owner of owners.slice(1)) await pass(owner, '1');

    const first = await collect(token);
    expect(first.kind === 'collected' && first.children.map((child) => child.status)).toEqual([
      'pending',
      'collected',
      'collected',
      'collected',
    ]);
    expect((await manager.load(root.id))?.substep).toBe('1');

    // Parked results move no cursor, so the first collect announces nothing.
    expect(first.kind === 'collected' && first.progression.kind).toBe('none');

    await pass(owners[0], '1');
    const second = await collect(token);
    // The children keep naming the step they were reserved for, though the
    // Collect moved the parent on to step 2.
    expect(
      second.kind === 'collected' && second.children.map((child) => [child.step, child.status]),
    ).toEqual([
      ['1.1', 'collected'],
      ['1.2', 'already_collected'],
      ['1.3', 'already_collected'],
      ['1.4', 'already_collected'],
    ]);
    expect((await manager.load(root.id))?.step).toBe('2');
  });

  it('reports a later child cancelled, applying nothing, once an earlier Collect stopped the parent', async () => {
    const { root, token } = await start(FIRST_FAIL_STOPS);
    const [first, second] = enteredChildren(root.id);
    await failChild((await claimed(first.ticket ?? '')).ownerToken);
    await pass((await claimed(second.ticket ?? '')).ownerToken, '1');
    const before = await manager.loadWithVersion(root.id);

    const outcome = await collect(token);

    expect(outcome.kind === 'collected' && outcome.children).toEqual([
      expect.objectContaining({ step: '1.1', status: 'collected', result: 'fail' }),
      expect.objectContaining({ step: '1.2', status: 'cancelled', result: 'pass' }),
    ]);
    const after = await manager.loadWithVersion(root.id);
    expect(after?.state.lifecycle).toBe('stopped');
    // One Collect committed; nothing was saved for the child it could not apply.
    expect(after?.stateVersion).toBe((before?.stateVersion ?? 0) + 1);
  });

  it('reports a later child cancelled once an earlier Collect moved the parent out of the step', async () => {
    const { root, token } = await start(FIRST_FAIL_LEAVES);
    const [first, second] = enteredChildren(root.id);
    await failChild((await claimed(first.ticket ?? '')).ownerToken);
    await pass((await claimed(second.ticket ?? '')).ownerToken, '1');
    const before = await manager.loadWithVersion(root.id);

    const outcome = await collect(token);

    expect(outcome.kind === 'collected' && outcome.children).toEqual([
      expect.objectContaining({ step: '1.1', status: 'collected', result: 'fail' }),
      expect.objectContaining({ step: '1.2', status: 'cancelled', result: 'pass' }),
    ]);
    const after = await manager.loadWithVersion(root.id);
    expect(after?.state.step).toBe('2');
    expect(after?.stateVersion).toBe((before?.stateVersion ?? 0) + 1);
  });

  it('refuses CONCURRENT_MODIFICATION when another writer moves the run between two of its Collects', async () => {
    const { root, token } = await start(FAN_OUT);
    for (const child of enteredChildren(root.id)) {
      await pass((await claimed(child.ticket ?? '')).ownerToken, '1');
    }
    const resolved = await target(token);
    if (resolved.kind !== 'running') throw new Error('expected a running root');
    // Another of the owner's commands writes the run right after the first
    // Collect commits; this Collect must not build on a version it did not make.
    const interleaving = new InterleavingManager(dir, async () => {
      const read = await manager.loadWithVersion(root.id);
      if (read === null) throw new Error('root vanished');
      expect((await manager.save(read.state, read.stateVersion)).kind).toBe('committed');
    });
    const collecting = new RunbookLifecycleCommandService({
      manager: interleaving,
      actorService,
      loadSteps,
    });

    const outcome = await collecting.runCollect({ run: resolved.run });

    expect(outcome.kind).toBe('concurrent_modification');
    // The first Collect stands; the interleaved write is not overwritten.
    const parent = await manager.load(root.id);
    expect(
      (parent?.substepStates ?? []).filter(
        (substepState) =>
          substepState.child?.kind === 'delegation' && substepState.child.collected !== undefined,
      ),
    ).toHaveLength(1);
  });

  it('reports an unclaimed child and writes nothing', async () => {
    const { root, token } = await start(SINGLE_MANUAL);
    const before = await manager.loadWithVersion(root.id);
    expect(await collect(token)).toMatchObject({
      children: [{ status: 'unclaimed' }],
      progression: { kind: 'none' },
    });
    expect((await manager.loadWithVersion(root.id))?.stateVersion).toBe(before?.stateVersion);
  });

  it('refuses a run with no delegation to collect NOTHING_TO_COLLECT', async () => {
    const { root, token } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    await pass((await claimed(child.ticket ?? '')).ownerToken, '1');
    await collect(token);
    expect((await manager.load(root.id))?.step).toBe('2');
    expect(await collect(token)).toMatchObject({ kind: 'refused', code: 'NOTHING_TO_COLLECT' });
  });

  it('reserves one child per FOR iteration, each with its own ticket', async () => {
    const { root, token } = await start(FOR_DELEGATE);
    const first = enteredChildren(root.id);
    expect(first).toEqual([expect.objectContaining({ step: '1.1', index: 1 })]);
    await pass((await claimed(first[0].ticket ?? '')).ownerToken, '1');
    await collect(token);

    const second = enteredChildren(root.id);
    expect(second).toEqual([expect.objectContaining({ step: '1.1', index: 2 })]);
    expect(second[0].runId).not.toBe(first[0].runId);
    expect(second[0].ticket).toBeDefined();
    await pass((await claimed(second[0].ticket ?? '')).ownerToken, '1');
    await collect(token);
    expect((await manager.load(root.id))?.lifecycle).toBe('completed');
  });
});

describe("A Delegation's standing (#904)", () => {
  it('refuses a child command once the parent re-entered the step DELEGATION_CANCELLED', async () => {
    const { root, token } = await start(SINGLE_MANUAL);
    const [stale] = enteredChildren(root.id);
    const { ownerToken } = await claimed(stale.ticket ?? '');
    // The owner decides the substep by hand, then re-enters the step: the
    // claimed child belongs to the earlier entry.
    await pass(token, '1.1');
    const resolved = await target(token);
    if (resolved.kind !== 'running') throw new Error('expected a running root');
    const fail = await seam().runTransition({
      command: 'fail',
      run: resolved.run,
      target: { stepId: '2' },
    });
    expect(fail.kind).toBe('applied');
    if (fail.kind === 'applied') await activate(fail.progression, resolved.run.state);
    const [fresh] = enteredChildren(root.id);
    expect(fresh.runId).not.toBe(stale.runId);
    expect(fresh.ticket).toBeDefined();

    expect(await target(ownerToken)).toMatchObject({
      kind: 'delegation_cancelled',
      code: 'DELEGATION_CANCELLED',
    });
  });

  it('refuses a child command once the parent finished PARENT_RUN_FINISHED', async () => {
    const { root, token } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    const { ownerToken } = await claimed(child.ticket ?? '');
    const resolved = await target(token);
    if (resolved.kind !== 'running') throw new Error('expected a running root');
    await seam().runTerminal({ command: 'stop', run: resolved.run });

    expect(await target(ownerToken)).toMatchObject({
      kind: 'parent_run_finished',
      code: 'PARENT_RUN_FINISHED',
    });
  });

  it('lets a cancelled child stop itself, while its pass and complete stay refused', async () => {
    const { root, token } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    const { ownerToken } = await claimed(child.ticket ?? '');
    // The owner decides the substep by hand: the claimed child is cancelled.
    await pass(token, '1.1');

    expect(await target(ownerToken, 'pass')).toMatchObject({ code: 'DELEGATION_CANCELLED' });
    expect(await target(ownerToken, 'complete')).toMatchObject({
      code: 'DELEGATION_CANCELLED',
    });
    const stopping = await target(ownerToken, 'stop');
    if (stopping.kind !== 'running') throw new Error(`stop refused: ${stopping.kind}`);
    const stopped = await seam().runTerminal({ command: 'stop', run: stopping.run });

    expect(stopped).toMatchObject({ kind: 'applied', lifecycle: 'stopped' });
    expect((await manager.load(child.runId))?.lifecycle).toBe('stopped');
    // Its result is never collected: the parent moved on without it.
    expect((await manager.load(root.id))?.step).toBe('2');
  });

  it('lets a child whose parent finished stop itself', async () => {
    const { root, token } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    const { ownerToken } = await claimed(child.ticket ?? '');
    const resolved = await target(token);
    if (resolved.kind !== 'running') throw new Error('expected a running root');
    await seam().runTerminal({ command: 'stop', run: resolved.run });

    const stopping = await target(ownerToken, 'stop');
    if (stopping.kind !== 'running') throw new Error(`stop refused: ${stopping.kind}`);
    expect(await seam().runTerminal({ command: 'stop', run: stopping.run })).toMatchObject({
      kind: 'applied',
      lifecycle: 'stopped',
    });
  });

  it('refuses a child command once the parent was pruned PARENT_RUN_FINISHED, and lets it stop', async () => {
    const { root } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    const { ownerToken } = await claimed(child.ticket ?? '');
    await manager.delete(root.id);

    expect(await target(ownerToken, 'pass')).toMatchObject({
      kind: 'parent_run_finished',
      code: 'PARENT_RUN_FINISHED',
    });
    const stopping = await target(ownerToken, 'stop');
    if (stopping.kind !== 'running') throw new Error(`stop refused: ${stopping.kind}`);
    expect(await seam().runTerminal({ command: 'stop', run: stopping.run })).toMatchObject({
      kind: 'applied',
      lifecycle: 'stopped',
    });
  });

  it("refuses the wrong run's token with another run's step INVALID_STEP", async () => {
    const { root, token } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    await claimed(child.ticket ?? '');
    const resolved = await target(token);
    if (resolved.kind !== 'running') throw new Error('expected a running root');
    // The parent's token names the child's step: there is no such position.
    const outcome = await seam().runTransition({
      command: 'pass',
      run: resolved.run,
      target: { stepId: '1' },
    });
    expect(outcome.kind).toBe('invalid_step_target');
  });
});

describe('An Inline Child that delegates (#903 + #904)', () => {
  it('collects through the root token and the inline child ascends into its parent', async () => {
    const { root, token } = await start(INLINE_DELEGATING);
    const inline = events.find(
      (event) => event.type === 'RUNBOOK_STARTED' && event.runbookId !== root.id,
    );
    expect(inline).toBeDefined();
    const inlineId = inline?.runbookId ?? '';
    const [child] = enteredChildren(inlineId);
    await claimed(child.ticket ?? '');

    const outcome = await collect(token);

    expect(outcome).toMatchObject({ kind: 'collected', runId: inlineId });
    expect((await manager.load(inlineId))?.lifecycle).toBe('completed');
    expect((await manager.load(root.id))?.lifecycle).toBe('completed');
  });
});

/** Drive `rundown retry --token --step [--index]` as the owner does. */
async function retry(token: OwnerToken, step: string | undefined, index?: number) {
  const resolved = await target(token, 'retry');
  if (resolved.kind !== 'running') throw new Error(`token refused: ${resolved.kind}`);
  return seam().runRetry({
    run: resolved.run,
    target:
      step === undefined
        ? undefined
        : { stepId: step, ...(index !== undefined ? { iteration: index } : {}) },
  });
}

/** Drive `rundown release <child-id> [--agent-id]` as a sub-agent does. */
function release(runId: string, agentId?: string) {
  return releaseDelegation(
    { manager, actorService, loadSteps },
    { runId: runId as RunId, ...(agentId !== undefined ? { agentId } : {}) },
  );
}

describe('Retry (#905)', () => {
  it('cancels the Current Child and reserves a fresh one whose new ticket is printed once', async () => {
    const { root, token } = await start(SINGLE_MANUAL);
    const [lost] = enteredChildren(root.id);
    const before = await manager.loadWithVersion(root.id);

    const outcome = await retry(token, '1.1');

    expect(outcome).toMatchObject({
      kind: 'retried',
      runId: root.id,
      cancelledRunId: lost.runId,
      child: {
        step: '1.1',
        runbook: 'child-manual.runbook.md',
        ticket: expect.stringMatching(/^rdt_/),
      },
    });
    if (outcome.kind !== 'retried') throw new Error('expected a retry');
    expect(outcome.child.runId).not.toBe(lost.runId);
    expect(outcome.child.ticket).not.toBe(lost.ticket);
    // The cancel and the new reservation are one conditional save.
    expect((await manager.loadWithVersion(root.id))?.stateVersion).toBe(
      (before?.stateVersion ?? 0) + 1,
    );
    // Only the hash is stored: the ticket is printed once, by the retry.
    expect(JSON.stringify(await manager.load(root.id))).not.toContain(outcome.child.ticket);

    expect(await claim(lost.ticket ?? '')).toMatchObject({
      kind: 'refused',
      code: 'DELEGATION_CANCELLED',
    });
    const fresh = await claimed(outcome.child.ticket);
    expect(fresh.child.state.id).toBe(outcome.child.runId);
    await pass(fresh.ownerToken, '1');
    expect(await collect(token)).toMatchObject({
      kind: 'collected',
      children: [{ runId: outcome.child.runId, status: 'collected', result: 'pass' }],
    });
    expect((await manager.load(root.id))?.step).toBe('2');
  });

  it("refuses the cancelled child's commands DELEGATION_CANCELLED, and lets it stop", async () => {
    const { root, token } = await start(SINGLE_MANUAL);
    const [lost] = enteredChildren(root.id);
    const { ownerToken } = await claimed(lost.ticket ?? '');

    expect((await retry(token, '1.1')).kind).toBe('retried');

    expect(await target(ownerToken, 'pass')).toMatchObject({
      kind: 'delegation_cancelled',
      code: 'DELEGATION_CANCELLED',
    });
    expect((await target(ownerToken, 'stop')).kind).toBe('running');
  });

  it('never collects a terminal child the retry cancelled', async () => {
    const { root, token } = await start(SINGLE_MANUAL);
    const [first] = enteredChildren(root.id);
    await pass((await claimed(first.ticket ?? '')).ownerToken, '1');

    const outcome = await retry(token, '1.1');
    if (outcome.kind !== 'retried') throw new Error(`retry refused: ${outcome.kind}`);

    expect(await collect(token)).toMatchObject({
      kind: 'collected',
      children: [{ runId: outcome.child.runId, status: 'unclaimed' }],
    });
    expect((await manager.load(root.id))?.step).toBe('1');
  });

  it('retries one child of a fan-out and leaves its siblings current', async () => {
    const { root, token } = await start(FAN_OUT);
    const children = enteredChildren(root.id);
    const sibling = await claimed(children[1].ticket ?? '');

    const outcome = await retry(token, '1.3');
    if (outcome.kind !== 'retried') throw new Error(`retry refused: ${outcome.kind}`);

    expect(outcome.cancelledRunId).toBe(children[2].runId);
    expect((await target(sibling.ownerToken)).kind).toBe('running');
    expect((await claim(children[3].ticket ?? '')).kind).toBe('claimed');
    expect(await claim(children[2].ticket ?? '')).toMatchObject({ code: 'DELEGATION_CANCELLED' });
    expect((await claim(outcome.child.ticket)).kind).toBe('claimed');
  });

  it('requires --index inside a FOR loop and reserves the retried child in that iteration', async () => {
    const { root, token } = await start(FOR_DELEGATE);
    const [lost] = enteredChildren(root.id);

    expect(await retry(token, '1.1')).toMatchObject({ kind: 'invalid_step_target' });
    expect(await retry(token, '1.1', 2)).toMatchObject({ kind: 'invalid_step_target' });

    const outcome = await retry(token, '1.1', 1);
    expect(outcome).toMatchObject({ kind: 'retried', child: { step: '1.1', index: 1 } });
    expect(outcome.kind === 'retried' && outcome.child.runId).not.toBe(lost.runId);
  });

  it('refuses a --step that is not a delegated substep of the current step, writing nothing', async () => {
    const { root, token } = await start(SINGLE_MANUAL);
    const before = await manager.loadWithVersion(root.id);

    expect(await retry(token, undefined)).toMatchObject({ kind: 'invalid_step_target' });
    expect(await retry(token, '1')).toMatchObject({ kind: 'invalid_step_target' });
    expect(await retry(token, '2')).toMatchObject({ kind: 'invalid_step_target' });
    expect(await retry(token, '1.2')).toMatchObject({ kind: 'refused', code: 'NOTHING_TO_RETRY' });

    expect((await manager.loadWithVersion(root.id))?.stateVersion).toBe(before?.stateVersion);
  });

  it('refuses a substep whose child was already collected NOTHING_TO_RETRY', async () => {
    const { root, token } = await start(FAN_OUT);
    const children = enteredChildren(root.id);
    await pass((await claimed(children[1].ticket ?? '')).ownerToken, '1');
    // Collected out of order: held for 1.2 until the cursor arrives.
    await collect(token);

    expect(await retry(token, '1.2')).toMatchObject({ kind: 'refused', code: 'NOTHING_TO_RETRY' });
  });

  it('refuses CONCURRENT_MODIFICATION when the run moved before its save, and cancels nothing', async () => {
    const { root, token } = await start(SINGLE_MANUAL);
    const [lost] = enteredChildren(root.id);
    const resolved = await target(token, 'retry');
    if (resolved.kind !== 'running') throw new Error('expected a running root');
    const racing = new InterleavingManager(
      dir,
      async () => {
        const read = await manager.loadWithVersion(root.id);
        if (read === null) throw new Error('root vanished');
        expect((await manager.save(read.state, read.stateVersion)).kind).toBe('committed');
      },
      'before',
    );
    const retrying = new RunbookLifecycleCommandService({
      manager: racing,
      actorService,
      loadSteps,
    });

    const outcome = await retrying.runRetry({ run: resolved.run, target: { stepId: '1.1' } });

    expect(outcome.kind).toBe('concurrent_modification');
    expect((await claim(lost.ticket ?? '')).kind).toBe('claimed');
  });

  it('refuses a ticket from a reservation a GOTO re-entry replaced DELEGATION_CANCELLED', async () => {
    const { root, token } = await start(SINGLE_MANUAL);
    const [stale] = enteredChildren(root.id);
    await pass(token, '1.1');
    const resolved = await target(token);
    if (resolved.kind !== 'running') throw new Error('expected a running root');
    const fail = await seam().runTransition({
      command: 'fail',
      run: resolved.run,
      target: { stepId: '2' },
    });
    if (fail.kind !== 'applied') throw new Error(`fail refused: ${fail.kind}`);
    await activate(fail.progression, resolved.run.state);

    expect(await claim(stale.ticket ?? '')).toMatchObject({
      kind: 'refused',
      code: 'DELEGATION_CANCELLED',
    });
  });
});

describe('Release (#905)', () => {
  it("writes abandoned on the child's own row when the agent matches, never touching the parent", async () => {
    const { root } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    await claimedAs(child.ticket ?? '', 'agent-1');
    const parentBefore = await manager.loadWithVersion(root.id);

    const outcome = await release(child.runId, 'agent-1');

    expect(outcome).toMatchObject({ kind: 'released', runId: child.runId });
    expect((await manager.load(child.runId))?.lifecycle).toBe('abandoned');
    expect((await manager.loadWithVersion(root.id))?.stateVersion).toBe(parentBefore?.stateVersion);
  });

  it('is Collected as a fail', async () => {
    const { root, token } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    await claimedAs(child.ticket ?? '', 'agent-1');
    expect((await release(child.runId, 'agent-1')).kind).toBe('released');

    expect(await collect(token)).toMatchObject({
      kind: 'collected',
      children: [{ runId: child.runId, status: 'collected', result: 'fail' }],
    });
    expect((await manager.load(root.id))?.lifecycle).toBe('stopped');
  });

  it('matches when neither the claim nor the release names an agent', async () => {
    const { root } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    await claimed(child.ticket ?? '');

    expect((await release(child.runId)).kind).toBe('released');
  });

  it('refuses a different agent, or a missing one, AGENT_MISMATCH and writes nothing', async () => {
    const { root } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    await claimedAs(child.ticket ?? '', 'agent-1');
    const before = await manager.loadWithVersion(child.runId);

    expect(await release(child.runId, 'agent-2')).toMatchObject({
      kind: 'refused',
      code: 'AGENT_MISMATCH',
    });
    expect(await release(child.runId)).toMatchObject({ kind: 'refused', code: 'AGENT_MISMATCH' });

    const after = await manager.loadWithVersion(child.runId);
    expect(after?.state.lifecycle).toBe('running');
    expect(after?.stateVersion).toBe(before?.stateVersion);
  });

  it('refuses an agent when the claim recorded none AGENT_MISMATCH', async () => {
    const { root } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    await claimed(child.ticket ?? '');

    expect(await release(child.runId, 'agent-1')).toMatchObject({ code: 'AGENT_MISMATCH' });
  });

  it('refuses a run that is not a Delegation NOT_A_DELEGATION, and an unknown run RUN_TARGET_UNAVAILABLE', async () => {
    const { root } = await start(SINGLE_MANUAL);

    expect(await release(root.id)).toMatchObject({ kind: 'refused', code: 'NOT_A_DELEGATION' });
    expect(await release(generateRunId())).toMatchObject({
      kind: 'refused',
      code: 'RUN_TARGET_UNAVAILABLE',
    });
    expect((await manager.load(root.id))?.lifecycle).toBe('running');
  });

  it('refuses a child that already finished run_finished', async () => {
    const { root } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    await claimed(child.ticket ?? '');
    expect((await release(child.runId)).kind).toBe('released');

    expect(await release(child.runId)).toMatchObject({
      kind: 'run_finished',
      lifecycle: 'abandoned',
    });
  });

  it("refuses the abandoned child's own token as a finished run", async () => {
    const { root } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    const { ownerToken } = await claimed(child.ticket ?? '');
    await release(child.runId);

    expect(await target(ownerToken, 'pass')).toMatchObject({
      kind: 'finished',
      lifecycle: 'abandoned',
    });
  });

  it('refuses CONCURRENT_MODIFICATION when the child moved before its save', async () => {
    const { root } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    await claimed(child.ticket ?? '');
    const racing = new InterleavingManager(
      dir,
      async () => {
        const read = await manager.loadWithVersion(child.runId);
        if (read === null) throw new Error('child vanished');
        expect((await manager.save(read.state, read.stateVersion)).kind).toBe('committed');
      },
      'before',
    );

    const outcome = await releaseDelegation(
      { manager: racing, actorService, loadSteps },
      { runId: child.runId as RunId },
    );

    expect(outcome.kind).toBe('concurrent_modification');
    expect((await manager.load(child.runId))?.lifecycle).toBe('running');
  });

  it('releases a Delegation whose parent was pruned', async () => {
    const { root } = await start(SINGLE_MANUAL);
    const [child] = enteredChildren(root.id);
    await claimed(child.ticket ?? '');
    await manager.delete(root.id);

    expect((await release(child.runId)).kind).toBe('released');
  });
});

describe('No re-claim and no re-reveal (#905)', () => {
  it('prints each ticket on the one event that issued it, and on nothing after', async () => {
    const { root, token } = await start(FAN_OUT);
    const issued = ticketsOf(root.id);
    expect(issued).toHaveLength(4);
    const after = events.length;

    await collect(token);
    await claimed(issued[0]);
    await collect(token);
    const retried = await retry(token, '1.2');
    if (retried.kind !== 'retried') throw new Error(`retry refused: ${retried.kind}`);
    await collect(token);

    const later = JSON.stringify(events.slice(after));
    for (const ticket of issued) expect(later).not.toContain(ticket);
    expect(ticketsOf(root.id)).toEqual(issued);
    expect(JSON.stringify(await manager.load(root.id))).not.toContain(retried.child.ticket);
  });

  it('claims each child once: a finished, a released or a retried child cannot be claimed again', async () => {
    const { root, token } = await start(FAN_OUT);
    const [first, second, third] = enteredChildren(root.id);
    await pass((await claimed(first.ticket ?? '')).ownerToken, '1');
    await claimed(second.ticket ?? '');
    await release(second.runId);
    const retried = await retry(token, '1.3');
    if (retried.kind !== 'retried') throw new Error(`retry refused: ${retried.kind}`);
    await claimed(retried.child.ticket);

    expect(await claim(first.ticket ?? '')).toMatchObject({ code: 'ALREADY_CLAIMED' });
    expect(await claim(second.ticket ?? '')).toMatchObject({ code: 'ALREADY_CLAIMED' });
    expect(await claim(third.ticket ?? '')).toMatchObject({ code: 'DELEGATION_CANCELLED' });
    expect(await claim(retried.child.ticket)).toMatchObject({ code: 'ALREADY_CLAIMED' });
  });
});
