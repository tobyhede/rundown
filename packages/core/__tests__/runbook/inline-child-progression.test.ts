import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseRunbookDocument } from '@rundown-org/parser';
import { RunbookStateManager, generateRunId } from '../../src/runbook/state.js';
import { RunbookActorService } from '../../src/runbook/actor-service.js';
import { closeRunbookStore } from '../../src/runbook/storage/store-registry.js';
import { ExecutionEventEmitter } from '../../src/events/emitter.js';
import type { RunbookEventV1 } from '../../src/events/types.js';
import type { CommandExecutionServices } from '../../src/runbook/actors/command-exec-actor.js';
import type { ResolvedRunbook, ResolvedStep, RunbookState } from '../../src/runbook/types.js';
import {
  generateOwnerToken,
  hashRunSecret,
  type OwnerToken,
} from '../../src/runbook/run-secrets.js';
import {
  activateRunProgression,
  progressionDirectiveForStartedRun,
  type RunProgressionDeps,
  type RunProgressionDirective,
  type RunProgressionOutcome,
} from '../../src/runbook/run-progression.js';
import { RunbookLifecycleCommandService } from '../../src/runbook/lifecycle-command-service.js';
import type { PrepareInlineChild } from '../../src/runbook/inline-progression.js';
import { currentInlineReservation } from '../../src/runbook/inline-child.js';

// Inline Children on the parent's Owner Token (#903, ADR 0005), driven through
// the public seams: Run Progression's activation and the lifecycle command
// seam's target resolution and transitions. Real SQLite, real machine; the
// only doubles are the command runner and the frontend's child preparer (the
// file-reading, policy-resolving service the CLI injects).

const LEAF_PASS = `# Leaf pass

## 1. Work
- PASS COMPLETE
- FAIL STOP

\`\`\`bash
echo leaf
\`\`\`
`;

const LEAF_MANUAL = `# Leaf manual

## Check
- PASS COMPLETE
- FAIL STOP

Check by hand.
`;

const MIDDLE = `# Middle

## Nest
- PASS ALL COMPLETE
- FAIL ANY STOP

- leaf-manual.runbook.md
`;

const PARENT_PASS = `# Parent

## 1. Compose
- PASS ALL CONTINUE
- FAIL ANY STOP

- leaf-pass.runbook.md

## 2. Done
- PASS COMPLETE
- FAIL STOP

Finish by hand.
`;

const PARENT_MANUAL = `# Parent manual

## 1. Compose
- PASS ALL CONTINUE
- FAIL ANY STOP

- leaf-manual.runbook.md

## 2. Done
- PASS COMPLETE
- FAIL STOP

Finish by hand.
`;

const PARENT_TWO_DEEP = `# Parent deep

## 1. Compose
- PASS ALL COMPLETE
- FAIL ANY STOP

- middle.runbook.md
`;

const SOURCES: Readonly<Record<string, string>> = {
  'leaf-pass.runbook.md': LEAF_PASS,
  'leaf-manual.runbook.md': LEAF_MANUAL,
  'middle.runbook.md': MIDDLE,
};

let dir: string;
let manager: RunbookStateManager;
let actorService: RunbookActorService;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-inline-'));
  manager = new RunbookStateManager(dir);
  actorService = new RunbookActorService(manager, { commandServices: succeeding() });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await closeRunbookStore(dir);
  await fs.rm(dir, { recursive: true, force: true });
});

function succeeding(): CommandExecutionServices {
  return { runExternalCommand: async () => ({ success: true, exitCode: 0 }) };
}

function parse(markdown: string): ResolvedRunbook {
  return parseRunbookDocument(markdown).runbook as ResolvedRunbook;
}

/** Built-ins every runnable run renders against. */
function builtins(
  runId: string,
  file: string,
): Record<string, string | { source: 'project'; path: string }> {
  return {
    RunId: runId,
    WorkPath: '.rundown/work',
    ContextId: `ctx-${runId}`,
    RunbookRef: { source: 'project', path: file },
  };
}

/** The frontend's preparer, standing in for the CLI's file-reading service. */
const prepare: PrepareInlineChild = async ({ reservation }) => {
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
    templateVars: builtins(reservation.runId, reservation.runbook),
    initialVariables: {},
    frontmatterOutputs: [],
  };
};

function loadSteps(state: RunbookState): readonly ResolvedStep[] {
  return parse(state.runbookSrc ?? '').steps;
}

/** Every event, from every run's sink, in emission order. */
let events: RunbookEventV1[];

function sinkFor(state: RunbookState): ExecutionEventEmitter {
  const emitter = new ExecutionEventEmitter(state.id, state.runbook);
  emitter.subscribe((event) => {
    events.push(event);
  });
  return emitter;
}

function deps(root: RunbookState): RunProgressionDeps {
  return {
    manager,
    actorService,
    loadSteps,
    sink: sinkFor(root),
    sinkFor,
    prepareInlineChild: prepare,
  };
}

/** Start a root run as `rundown run` does and activate its progression. */
async function start(
  markdown: string,
): Promise<{ root: RunbookState; token: OwnerToken; outcome: RunProgressionOutcome }> {
  events = [];
  const runId = generateRunId();
  const token = generateOwnerToken();
  const runbook = parse(markdown);
  await manager.create({ source: 'project', path: 'parent.runbook.md' }, runbook, {
    runId,
    runbookPath: 'parent.runbook.md',
    ownerTokenHash: hashRunSecret(token),
    runbookSrc: markdown,
    frontmatterOutputs: [],
    templateVars: builtins(runId, 'parent.runbook.md'),
  });
  const root = await actorService.initializeState(runId, runbook.steps);
  if (root === null) throw new Error('seed failed');
  const outcome = await activate(progressionDirectiveForStartedRun(root, runbook.steps), root);
  return { root, token, outcome };
}

async function activate(
  directive: RunProgressionDirective,
  root: RunbookState,
): Promise<RunProgressionOutcome> {
  if (directive.kind !== 'activate') throw new Error('expected an activation');
  return activateRunProgression(directive.authority, deps(root), directive.entryBoundary);
}

function seam(): RunbookLifecycleCommandService {
  return new RunbookLifecycleCommandService({ manager, actorService, loadSteps });
}

/** Resolve the command target as a frontend does, settling with a real activation. */
async function target(token: OwnerToken, root: RunbookState) {
  return seam().resolveCommandTarget(token, (directive) => activate(directive, root));
}

async function childOf(parent: RunbookState): Promise<RunbookState> {
  const reloaded = await manager.load(parent.id);
  const reservation = reloaded === null ? undefined : currentInlineReservation(reloaded);
  if (reservation === undefined) throw new Error(`run ${parent.id} has no current inline child`);
  const child = await manager.load(reservation.runId);
  if (child === null) throw new Error(`inline child ${reservation.runId} was not launched`);
  return child;
}

describe('Inline Child launch and implicit Collect (#903)', () => {
  it('launches the reserved child, Collects its pass and continues the parent', async () => {
    const { root, outcome } = await start(PARENT_PASS);

    expect(outcome).toEqual({ kind: 'waiting', runId: root.id, reason: 'awaiting_input' });
    const parent = await manager.loadWithVersion(root.id);
    expect(parent?.state.step).toBe('2');
    const children = (await manager.listWithVersion()).filter((run) => run.linkage !== null);
    expect(children).toHaveLength(1);
    const [child] = children;
    expect(child.state.lifecycle).toBe('completed');
    expect(child.linkage).toEqual({
      kind: 'inline',
      parentRunId: root.id,
      parentStep: '1.1',
      parentFrameKey: '1|',
      parentEntry: 1,
    });
    // Each run reports under its own identity; the child's start carries no token.
    const childStart = events.find(
      (event) => event.type === 'RUNBOOK_STARTED' && event.runbookId === child.state.id,
    );
    expect(childStart?.payload).not.toHaveProperty('ownerToken');
    expect(
      events.some(
        (event) => event.type === 'RUNBOOK_COMPLETED' && event.runbookId === child.state.id,
      ),
    ).toBe(true);
  });

  it('targets the waiting child by the root token, and its terminal flows into the parent', async () => {
    const { root, token } = await start(PARENT_MANUAL);
    const child = await childOf(root);

    const resolved = await target(token, root);
    expect(resolved.kind === 'running' && resolved.run.state.id).toBe(child.id);
    if (resolved.kind !== 'running') throw new Error('expected a running target');

    const applied = await seam().runTransition({
      command: 'pass',
      run: resolved.run,
      target: { stepId: 'Check' },
    });
    if (applied.kind !== 'applied') throw new Error(`refused: ${applied.kind}`);
    const outcome = await activate(applied.progression, root);

    expect(outcome).toEqual({ kind: 'waiting', runId: root.id, reason: 'awaiting_input' });
    expect((await manager.load(child.id))?.lifecycle).toBe('completed');
    expect((await manager.load(root.id))?.step).toBe('2');
  });

  it("refuses --step naming the parent's step while its inline child runs", async () => {
    const { root, token } = await start(PARENT_MANUAL);
    const resolved = await target(token, root);
    if (resolved.kind !== 'running') throw new Error('expected a running target');

    const refused = await seam().runTransition({
      command: 'pass',
      run: resolved.run,
      target: { stepId: '1.1' },
    });
    expect(refused.kind).toBe('invalid_step_target');
  });

  it("Collects a terminal child its parent's crashed command never collected, before targeting", async () => {
    const { root, token } = await start(PARENT_MANUAL);
    const child = await childOf(root);
    const owned = await manager.loadWithVersion(child.id);
    if (owned === null) throw new Error('child missing');
    // The child reaches its terminal; the process dies before the implicit
    // Collect, so the parent still rests on the inline substep.
    const applied = await seam().runTransition({
      command: 'pass',
      run: owned,
      target: { stepId: 'Check' },
    });
    expect(applied.kind).toBe('applied');
    expect((await manager.load(root.id))?.step).toBe('1');

    const resolved = await target(token, root);

    expect(resolved.kind === 'running' && resolved.run.state.id).toBe(root.id);
    expect(resolved.kind === 'running' && resolved.run.state.step).toBe('2');
  });

  it('drives an inline chain two deep and Collects it level by level', async () => {
    const { root, token } = await start(PARENT_TWO_DEEP);
    const middle = await childOf(root);
    const leaf = await childOf(middle);

    const resolved = await target(token, root);
    expect(resolved.kind === 'running' && resolved.run.state.id).toBe(leaf.id);
    if (resolved.kind !== 'running') throw new Error('expected a running target');

    const applied = await seam().runTransition({
      command: 'pass',
      run: resolved.run,
      target: { stepId: 'Check' },
    });
    if (applied.kind !== 'applied') throw new Error(`refused: ${applied.kind}`);
    const outcome = await activate(applied.progression, root);

    expect(outcome).toEqual({ kind: 'completed', runId: root.id });
    expect((await manager.load(middle.id))?.lifecycle).toBe('completed');
  });

  it('reserves and launches a fresh child on a GOTO back onto the inline step', async () => {
    const { root, token } = await start(PARENT_PASS);
    const first = (await manager.listWithVersion()).find((run) => run.linkage !== null);
    const resolved = await target(token, root);
    if (resolved.kind !== 'running') throw new Error('expected a running target');

    const navigation = await seam().resolveRunNavigation({ run: resolved.run });
    if (navigation.kind !== 'allowed') throw new Error(`refused: ${navigation.kind}`);
    const moved = await seam().runNavigationMutation({
      navigation: navigation.navigation,
      target: { step: '1' },
    });
    if (moved.kind !== 'applied') throw new Error(`refused: ${moved.kind}`);
    await activate(moved.progression, root);

    const children = (await manager.listWithVersion()).filter((run) => run.linkage !== null);
    expect(children).toHaveLength(2);
    const fresh = children.find((run) => run.state.id !== first?.state.id);
    expect(fresh?.linkage?.parentEntry).toBeGreaterThan(first?.linkage?.parentEntry ?? 0);
    expect((await manager.load(root.id))?.step).toBe('2');
  });

  it('refuses the launch, writing no child, when the child runbook cannot be prepared', async () => {
    const { root, outcome } = await start(PARENT_PASS.replace('leaf-pass', 'missing'));

    expect(outcome).toMatchObject({
      kind: 'refused',
      runId: root.id,
      reason: 'inline_child_launch_failed',
      code: 'RUNBOOK_NOT_FOUND',
      recovery: 'permanent',
    });
    expect((await manager.listWithVersion()).filter((run) => run.linkage !== null)).toEqual([]);
  });
});
