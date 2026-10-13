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
  progressionDirectiveForTerminalRun,
  type RunProgressionDeps,
  type RunProgressionDirective,
  type RunProgressionOutcome,
} from '../../src/runbook/run-progression.js';
import { RunbookLifecycleCommandService } from '../../src/runbook/lifecycle-command-service.js';
import {
  MAX_INLINE_CHILD_DEPTH,
  type PrepareInlineChild,
} from '../../src/runbook/inline-progression.js';
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

const LEAF_PASS_COMMAND = '```bash\necho after\n```';

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

const LEAF_OUTPUTS = `---
name: leaf-outputs
outputs:
  - Verdict "approved"
---
# Leaf outputs

## 1. Work
- PASS COMPLETE
- FAIL STOP

\`\`\`bash
echo leaf
\`\`\`
`;

const DELEGATING = `# Delegating

## 1. Fan out
- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

- leaf-pass.runbook.md
`;

const SELF = `# Self

## 1. Again
- PASS ALL COMPLETE
- FAIL ANY STOP

- self.runbook.md
`;

// Each command on the deepest Grow child launches one more Grow child, so a
// chain built one level per activation is bounded only by its root.
const GROW = `# Grow

## 1. Wait
- PASS CONTINUE
- FAIL STOP

Check by hand.

## 2. Again
- PASS ALL COMPLETE
- FAIL ANY STOP

- grow.runbook.md
`;

const BAD_GOTO = `# Bad goto

## 1. Work
- PASS GOTO 9
- FAIL STOP

Check by hand.
`;

const LEAF_LOOP = `# Leaf loop

## 1. Loop
- FOR i IN 1 TO 2
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Body
- PASS CONTINUE
- FAIL STOP

Check {{i}} by hand.
`;

const SOURCES: Readonly<Partial<Record<string, string>>> = {
  'leaf-loop.runbook.md': LEAF_LOOP,
  'bad-goto.runbook.md': BAD_GOTO,
  'grow.runbook.md': GROW,
  'leaf-pass.runbook.md': LEAF_PASS,
  'leaf-manual.runbook.md': LEAF_MANUAL,
  'leaf-outputs.runbook.md': LEAF_OUTPUTS,
  'middle.runbook.md': MIDDLE,
  'delegating.runbook.md': DELEGATING,
  'self.runbook.md': SELF,
};

/** The preparer the next activation uses; `undefined` stands for a frontend with none. */
let preparer: PrepareInlineChild | undefined;

let dir: string;
let manager: RunbookStateManager;
let actorService: RunbookActorService;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-inline-'));
  manager = new RunbookStateManager(dir);
  actorService = new RunbookActorService(manager, { commandServices: succeeding() });
  preparer = prepare;
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
    frontmatterOutputs: parseRunbookDocument(source).frontmatter?.outputs ?? [],
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
    ...(preparer === undefined ? {} : { prepareInlineChild: preparer }),
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
      message:
        'Inline child missing.runbook.md at 1.1 could not be launched: no missing.runbook.md',
      recovery: 'permanent',
    });
    expect((await manager.listWithVersion()).filter((run) => run.linkage !== null)).toEqual([]);
  });

  it("flows the child's final variables into the parent with its result", async () => {
    const { root } = await start(PARENT_PASS.replace('leaf-pass', 'leaf-outputs'));

    const parent = await manager.load(root.id);
    expect(parent?.step).toBe('2');
    expect(parent?.variables).toMatchObject({ Verdict: 'approved' });
  });

  it('refuses the launch when the frontend prepares no inline children', async () => {
    preparer = undefined;
    const { root, outcome } = await start(PARENT_PASS);

    expect(outcome).toMatchObject({
      kind: 'refused',
      runId: root.id,
      reason: 'inline_child_launch_failed',
      code: 'INLINE_CHILD_LAUNCH_FAILED',
      message: `Run ${root.id} cannot launch the inline child at 1.1: this frontend does not launch inline children`,
      recovery: 'permanent',
    });
    expect((await manager.listWithVersion()).filter((run) => run.linkage !== null)).toEqual([]);
  });

  it('refuses an inline child whose runbook delegates, writing no child', async () => {
    const { root, outcome } = await start(PARENT_PASS.replace('leaf-pass', 'delegating'));

    expect(outcome).toMatchObject({
      kind: 'refused',
      runId: root.id,
      reason: 'inline_child_launch_failed',
      code: 'RUNBOOK_COMPOSITION_UNSUPPORTED',
      message: expect.stringMatching(
        /^Inline child delegating\.runbook\.md at 1\.1 could not be launched: .* at 1\.1\. Delegation returns in #904\.$/,
      ),
      recovery: 'permanent',
    });
    expect((await manager.listWithVersion()).filter((run) => run.linkage !== null)).toEqual([]);
    // The parent rests on the substep, announced once, for the owner to decide.
    expect((await manager.load(root.id))?.substep).toBe('1');
  });

  it('refuses a runbook that composes itself once the chain is too deep', async () => {
    const { outcome } = await start(SELF);

    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'inline_child_launch_failed',
      code: 'INLINE_CHILD_LAUNCH_FAILED',
    });
    const children = (await manager.listWithVersion()).filter((run) => run.linkage !== null);
    expect(children).toHaveLength(MAX_INLINE_CHILD_DEPTH);
  }, 60_000);

  it('never Collects a stale child: activating it does not reach the parent that re-entered', async () => {
    const { root, token } = await start(PARENT_MANUAL);
    const stale = await childOf(root);
    const first = await target(token, root);
    if (first.kind !== 'running') throw new Error('expected a running target');
    const passed = await seam().runTransition({
      command: 'pass',
      run: first.run,
      target: { stepId: 'Check' },
    });
    if (passed.kind !== 'applied') throw new Error(`refused: ${passed.kind}`);
    await activate(passed.progression, root);
    // The parent moved on to step 2; a GOTO re-enters step 1 and launches a
    // fresh child that waits.
    const atTwo = await target(token, root);
    if (atTwo.kind !== 'running') throw new Error('expected a running target');
    const navigation = await seam().resolveRunNavigation({ run: atTwo.run });
    if (navigation.kind !== 'allowed') throw new Error(`refused: ${navigation.kind}`);
    const moved = await seam().runNavigationMutation({
      navigation: navigation.navigation,
      target: { step: '1' },
    });
    if (moved.kind !== 'applied') throw new Error(`refused: ${moved.kind}`);
    await activate(moved.progression, root);
    const fresh = await childOf(root);
    expect(fresh.id).not.toBe(stale.id);

    const staleRow = await manager.loadWithVersion(stale.id);
    if (staleRow === null) throw new Error('stale child missing');
    const outcome = await activate(
      progressionDirectiveForTerminalRun(staleRow, loadSteps(staleRow.state)),
      root,
    );

    expect(outcome).toEqual({ kind: 'completed', runId: stale.id });
    expect((await manager.load(root.id))?.step).toBe('1');
    expect((await manager.load(fresh.id))?.lifecycle).toBe('running');
  });

  it('bounds the chain from its root when it grows one level per command', async () => {
    const { root, token } = await start(GROW);
    expect((await manager.load(root.id))?.step).toBe('1');

    // Each pass on the deepest run launches one more child from an activation
    // that starts at that run; the bound must still count from the root.
    let last: RunProgressionOutcome | undefined;
    for (let command = 0; command <= MAX_INLINE_CHILD_DEPTH; command++) {
      const resolved = await target(token, root);
      if (resolved.kind !== 'running')
        throw new Error(`expected a running target: ${resolved.kind}`);
      const applied = await seam().runTransition({
        command: 'pass',
        run: resolved.run,
        target: { stepId: '1' },
      });
      if (applied.kind !== 'applied') throw new Error(`refused: ${applied.kind}`);
      last = await activate(applied.progression, root);
    }

    expect(last).toMatchObject({
      kind: 'refused',
      reason: 'inline_child_launch_failed',
      code: 'INLINE_CHILD_LAUNCH_FAILED',
    });
    const children = (await manager.listWithVersion()).filter((run) => run.linkage !== null);
    expect(children).toHaveLength(MAX_INLINE_CHILD_DEPTH);
    // The owner can still command the chain: the deepest run is the target.
    const resolved = await target(token, root);
    expect(resolved.kind).toBe('running');
  }, 120_000);

  it('Collects an uncollected child without driving the parent further before the command', async () => {
    let commands = 0;
    actorService = new RunbookActorService(manager, {
      commandServices: {
        runExternalCommand: async () => {
          commands++;
          return { success: true, exitCode: 0 };
        },
      },
    });
    const { root, token } = await start(
      PARENT_MANUAL.replace('Finish by hand.', LEAF_PASS_COMMAND),
    );
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
    expect(commands).toBe(0);

    const resolved = await target(token, root);

    // The recovery commits only the Collect: step 2's command does not run
    // before the owner's command is applied at the parent's new position.
    expect(commands).toBe(0);
    expect(resolved.kind === 'running' && resolved.run.state.id).toBe(root.id);
    expect(resolved.kind === 'running' && resolved.run.state.step).toBe('2');
    expect((await manager.load(child.id))?.lifecycle).toBe('completed');

    // The owner's pass on that position must not pass step 2 without running
    // its command.
    if (resolved.kind !== 'running') throw new Error('expected a running target');
    const passed = await seam().runTransition({
      command: 'pass',
      run: resolved.run,
      target: { stepId: '2' },
    });
    expect(passed.kind).toBe('execution_pending');
    expect(commands).toBe(0);
    expect((await manager.load(root.id))?.lifecycle).toBe('running');

    // `goto` onto the step is how the owner runs the owed command.
    const again = await target(token, root);
    if (again.kind !== 'running') throw new Error('expected a running target');
    const navigation = await seam().resolveRunNavigation({ run: again.run });
    if (navigation.kind !== 'allowed') throw new Error(`refused: ${navigation.kind}`);
    const moved = await seam().runNavigationMutation({
      navigation: navigation.navigation,
      target: { step: '2' },
    });
    if (moved.kind !== 'applied') throw new Error(`refused: ${moved.kind}`);
    expect(await activate(moved.progression, root)).toEqual({
      kind: 'completed',
      runId: root.id,
    });
    expect(commands).toBe(1);
  });

  it('Collects an uncollected chain one level per pass, up to a finished root', async () => {
    const { root, token } = await start(PARENT_TWO_DEEP);
    const middle = await childOf(root);
    const leaf = await childOf(middle);
    const owned = await manager.loadWithVersion(leaf.id);
    if (owned === null) throw new Error('leaf missing');
    // The leaf reaches its terminal; the process dies before any Collect.
    const applied = await seam().runTransition({
      command: 'pass',
      run: owned,
      target: { stepId: 'Check' },
    });
    expect(applied.kind).toBe('applied');

    const resolved = await target(token, root);

    // The leaf's pass completes the middle, whose pass completes the root.
    expect(resolved).toMatchObject({ kind: 'finished', lifecycle: 'completed' });
    expect((await manager.load(middle.id))?.lifecycle).toBe('completed');
    expect((await manager.load(root.id))?.lifecycle).toBe('completed');
  });

  it('leaves no child row when the child cannot be initialised', async () => {
    // The child row and its initialised snapshot land in one write, so a child
    // whose machine cannot be built leaves nothing for the token to target.
    const { root, token, outcome } = await start(PARENT_PASS.replace('leaf-pass', 'bad-goto'));

    expect(outcome).toMatchObject({
      kind: 'refused',
      runId: root.id,
      reason: 'inline_child_launch_failed',
      code: 'INLINE_CHILD_LAUNCH_FAILED',
    });
    expect((await manager.listWithVersion()).filter((run) => run.linkage !== null)).toEqual([]);
    // The parent rests on the substep, and the owner's token still decides it.
    const resolved = await target(token, root);
    expect(resolved.kind === 'running' && resolved.run.state.id).toBe(root.id);
  });

  it('launches a child whose first step is a FOR loop already resting on its first substep', async () => {
    const { root } = await start(PARENT_MANUAL.replace('leaf-manual', 'leaf-loop'));
    const child = await childOf(root);

    expect(child).toMatchObject({ step: '1', substep: '1', lifecycle: 'running' });
    expect(child.snapshot).toBeDefined();
    expect(child.substepStates).toEqual([
      expect.objectContaining({ id: '1', frameKey: '1|1', status: 'pending' }),
    ]);
  });
});
