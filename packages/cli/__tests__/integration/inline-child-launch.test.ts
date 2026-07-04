import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  parseConcatenatedJson,
  readSession,
  readRunbookState,
  runCliInProcess,
  type TestWorkspace,
  writeSession,
  withRunTarget,
} from '../helpers/test-utils.js';

function flattenEvents(events: unknown[]): Record<string, unknown>[] {
  const flat: Record<string, unknown>[] = [];
  for (const event of events) {
    if (Array.isArray(event)) {
      flat.push(...flattenEvents(event));
      continue;
    }
    if (event && typeof event === 'object') {
      flat.push(event as Record<string, unknown>);
    }
  }
  return flat;
}

function findDelegateToken(stdout: string, substepId: string): string {
  const events = flattenEvents(parseConcatenatedJson(stdout));
  for (const event of events) {
    if (!Array.isArray(event.delegateFrontier)) continue;
    for (const entry of event.delegateFrontier) {
      if (
        entry &&
        typeof entry === 'object' &&
        (entry as { readonly id?: unknown }).id === substepId
      ) {
        const token = (entry as { readonly token?: unknown }).token;
        if (typeof token === 'string') return token;
      }
    }
  }
  throw new Error(`No delegation token found for ${substepId} in stdout:\n${stdout}`);
}

function findClaim(stdout: string): { readonly claimId: string; readonly runId: string } {
  const action = flattenEvents(parseConcatenatedJson(stdout)).find(
    (event) =>
      event.action === 'claimed' &&
      typeof event.claim_id === 'string' &&
      typeof event.run_id === 'string',
  );
  if (typeof action?.claim_id === 'string' && typeof action.run_id === 'string') {
    return { claimId: action.claim_id, runId: action.run_id };
  }
  throw new Error(`No claim action found in stdout:\n${stdout}`);
}

describe('Automatic inline child launch integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function writeInlineParentAndChild(): Promise<void> {
    await writeFile(
      join(workspace.rootRunbooksDir(), 'parent.runbook.md'),
      `---
name: parent
required:
  - PlanPath
inputs:
  - PlanPath
---
# Parent

## 1. Start
- PASS CONTINUE

Ready.

## 2. Write
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md

## 3. Review
- PASS COMPLETE

Reviewing {{PlanPath}}.
`,
    );
    const childRunbook = `---
name: child
outputs:
  - PlanPath "{{WorkPath}}/plan.md"
---
# Child

## 1. Create
- PASS COMPLETE

Child prompt.
`;
    await writeFile(join(workspace.rootRunbooksDir(), 'child.runbook.md'), childRunbook);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childRunbook);
  }

  it('launches an inline child from a typed STEP_ENTERED intent', async () => {
    await writeFile(
      join(workspace.rootRunbooksDir(), 'parent.runbook.md'),
      `---
name: parent
required:
  - PlanPath
inputs:
  - PlanPath
---
# Parent

## 1. Start
- PASS CONTINUE

Ready.

## 2. Write
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md

## 3. Review
- PASS COMPLETE

Reviewing {{PlanPath}}.
`,
    );
    const childRunbook = `---
name: child
outputs:
  - PlanPath "{{WorkPath}}/plan.md"
---
# Child

## 1. Create
- PASS COMPLETE

Child prompt.
`;
    await writeFile(join(workspace.rootRunbooksDir(), 'child.runbook.md'), childRunbook);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childRunbook);

    const start = await runCliInProcess(
      'run runbooks/parent.runbook.md --input PlanPath=/placeholder/input.txt',
      workspace,
    );
    if (start.exitCode !== 0) {
      throw new Error(`parent start failed:\nSTDOUT:\n${start.stdout}\nSTDERR:\n${start.stderr}`);
    }
    expect(start.exitCode).toBe(0);
    const parentRunId = (await readSession(workspace)).active;
    if (!parentRunId) throw new Error('expected active parent runbook');

    const passParentStep = await runCliInProcess(
      await withRunTarget(['pass'], workspace),
      workspace,
    );
    const events = flattenEvents(parseConcatenatedJson(passParentStep.stdout));

    const inlineStepIndex = events.findIndex(
      (event) =>
        event.type === 'step_entered' &&
        (event.position as { readonly current?: unknown; readonly substep?: unknown } | undefined)
          ?.current === '2' &&
        (event.position as { readonly current?: unknown; readonly substep?: unknown } | undefined)
          ?.substep === '1' &&
        event.inlineLaunch !== undefined,
    );
    const childStartIndex = events.findIndex(
      (event, index) => index > inlineStepIndex && event.type === 'runbook_started',
    );
    const childStepIndex = events.findIndex(
      (event, index) =>
        index > childStartIndex &&
        event.type === 'step_entered' &&
        (event.position as { readonly current?: unknown } | undefined)?.current === '1' &&
        event.prompt === 'Child prompt.',
    );
    expect(inlineStepIndex).toBeGreaterThanOrEqual(0);
    const inlineStep = events[inlineStepIndex];
    expect(inlineStep).toEqual(
      expect.objectContaining({
        description: 'Runbook: child.runbook.md',
        position: expect.objectContaining({
          current: '2',
          substep: '1',
        }),
        inlineLaunch: expect.objectContaining({
          childRunbookRef: expect.objectContaining({
            source: 'project',
            path: expect.stringMatching(/child\.runbook\.md$/),
          }),
          parentStep: '2',
          parentStepId: '1',
        }),
      }),
    );
    expect(inlineStep.delegateFrontier).toBeUndefined();

    const inlineLaunch = inlineStep.inlineLaunch as {
      readonly childRunbookPath?: unknown;
      readonly contextSnapshot?: unknown;
      readonly parentSubstepId?: unknown;
    };
    expect(typeof inlineLaunch.childRunbookPath).toBe('string');
    expect(inlineLaunch.childRunbookPath).toMatch(/child\.runbook\.md$/);
    expect(inlineLaunch.parentSubstepId).toBeUndefined();
    expect(inlineLaunch.contextSnapshot).toBeUndefined();
    expect(JSON.stringify(inlineLaunch)).not.toContain('/placeholder/input.txt');
    expect(childStartIndex).toBeGreaterThan(inlineStepIndex);
    expect(childStepIndex).toBeGreaterThan(childStartIndex);

    const parentState = await readRunbookState(workspace, parentRunId);
    expect(parentState).not.toBeNull();
    const parentContext = parentState?.snapshot as {
      readonly context?: { readonly inlineLaunchIntent?: unknown };
    };
    expect(parentContext.context?.inlineLaunchIntent).toBeUndefined();
    expect(parentState?.substepStates).toContainEqual(
      expect.objectContaining({
        id: '1',
        frameKey: expect.any(String),
        inline: expect.objectContaining({
          childRunId: expect.stringMatching(/^rd_[a-f0-9]{32}$/),
          startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }),
      }),
    );

    const passChild = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);
    expect(passChild.exitCode).toBe(0);
    expect(passChild.stdout).toContain('Reviewing');
    expect(passChild.stdout).toContain('/plan.md');
    expect(passChild.stdout).not.toContain('/placeholder/input.txt');
  });

  it('recovers an existing inline child before consuming the parent intent', async () => {
    await writeFile(
      join(workspace.rootRunbooksDir(), 'parent.runbook.md'),
      `---
name: parent
required:
  - PlanPath
inputs:
  - PlanPath
---
# Parent

## 1. Start
- PASS CONTINUE

Ready.

## 2. Write
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md

## 3. Review
- PASS COMPLETE

Reviewing {{PlanPath}}.
`,
    );
    const childRunbook = `---
name: child
outputs:
  - PlanPath "{{WorkPath}}/plan.md"
---
# Child

## 1. Create
- PASS COMPLETE

Child prompt.
`;
    await writeFile(join(workspace.rootRunbooksDir(), 'child.runbook.md'), childRunbook);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childRunbook);

    const start = await runCliInProcess(
      'run runbooks/parent.runbook.md --input PlanPath=/placeholder/input.txt',
      workspace,
    );
    expect(start.exitCode).toBe(0);
    const parentRunId = (await readSession(workspace)).active;
    if (!parentRunId) throw new Error('expected active parent runbook');

    const passParentStep = await runCliInProcess(
      await withRunTarget(['pass'], workspace),
      workspace,
    );
    expect(passParentStep.exitCode).toBe(0);

    const parentState = await readRunbookState(workspace, parentRunId);
    expect(parentState).not.toBeNull();
    if (!parentState) throw new Error('expected parent runbook state');
    const inlineState = parentState.substepStates?.find((entry) => entry.inline)?.inline;
    if (!inlineState) throw new Error('expected inline metadata');
    const childRunId = inlineState.childRunId;
    if (typeof childRunId !== 'string') throw new Error('expected inline child run id');

    await writeSession(workspace, { defaultStack: [parentRunId] });

    const snapshot = parentState.snapshot as {
      context?: Record<string, unknown>;
      [key: string]: unknown;
    };
    const restoredIntent = {
      parentRunId,
      parentStepId: '1',
      parentStep: '2',
      parentFrameKey: '2|',
      parentEntry: 1,
      childRunId,
      childRunbookPath: inlineState.childRunbookPath,
      childRunbookRef: inlineState.childRunbookRef,
      contextSnapshot: inlineState.contextSnapshot,
    };
    const mutatedParent = {
      ...parentState,
      substepStates: parentState.substepStates.map((entry) =>
        entry.inline?.childRunId === childRunId
          ? { ...entry, inline: { ...entry.inline, startedAt: null } }
          : entry,
      ),
      snapshot: {
        ...snapshot,
        context: {
          ...(snapshot.context ?? {}),
          inlineLaunchIntent: restoredIntent,
        },
      },
    };
    await writeFile(
      join(workspace.statePath(), `${parentRunId}.json`),
      JSON.stringify(mutatedParent, null, 2),
    );

    const recover = await runCliInProcess(await withRunTarget(['goto', '2'], workspace), workspace);
    expect(recover.exitCode).toBe(0);
    expect((await readSession(workspace)).active).toBe(childRunId);

    const repairedParent = await readRunbookState(workspace, parentRunId);
    const repairedInline = repairedParent?.substepStates?.find(
      (entry) => entry.inline?.childRunId === childRunId,
    )?.inline;
    expect(repairedInline?.startedAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));

    const repairedContext = repairedParent?.snapshot as {
      readonly context?: { readonly inlineLaunchIntent?: unknown };
    };
    expect(repairedContext.context?.inlineLaunchIntent).toBeUndefined();

    const passChild = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);
    expect(passChild.exitCode).toBe(0);
    expect(passChild.stdout).toContain('Reviewing');
  });

  it('does not let a run-targeted pass skip a recovered unstarted inline child substep', async () => {
    await writeInlineParentAndChild();

    const start = await runCliInProcess(
      'run runbooks/parent.runbook.md --input PlanPath=/placeholder/input.txt',
      workspace,
    );
    expect(start.exitCode).toBe(0);
    const parentRunId = (await readSession(workspace)).active;
    if (!parentRunId) throw new Error('expected active parent runbook');

    const passParentStep = await runCliInProcess(
      await withRunTarget(['pass'], workspace),
      workspace,
    );
    expect(passParentStep.exitCode).toBe(0);

    const parentState = await readRunbookState(workspace, parentRunId);
    expect(parentState).not.toBeNull();
    if (!parentState) throw new Error('expected parent runbook state');

    await writeSession(workspace, {
      active: parentRunId,
      defaultStack: [parentRunId],
    });

    const passRecoveredParent = await runCliInProcess(
      await withRunTarget(['pass'], workspace),
      workspace,
    );

    expect(passRecoveredParent.exitCode).toBe(0);
    expect(passRecoveredParent.stdout).not.toContain('Reviewing');
    expect(passRecoveredParent.stdout).not.toContain('/placeholder/input.txt');
    const session = await readSession(workspace);
    expect(session.active).not.toBe(parentRunId);
    const updatedParent = await readRunbookState(workspace, parentRunId);
    expect(updatedParent?.substepStates).toContainEqual(
      expect.objectContaining({
        id: '1',
        status: 'running',
        inline: expect.objectContaining({
          childRunId: session.active,
        }),
      }),
    );
  });

  it('does not let a run-targeted fail skip a recovered unstarted inline child substep', async () => {
    await writeInlineParentAndChild();

    const start = await runCliInProcess(
      'run runbooks/parent.runbook.md --input PlanPath=/placeholder/input.txt',
      workspace,
    );
    expect(start.exitCode).toBe(0);
    const parentRunId = (await readSession(workspace)).active;
    if (!parentRunId) throw new Error('expected active parent runbook');

    const passParentStep = await runCliInProcess(
      await withRunTarget(['pass'], workspace),
      workspace,
    );
    expect(passParentStep.exitCode).toBe(0);

    await writeSession(workspace, {
      active: parentRunId,
      defaultStack: [parentRunId],
    });

    const failRecoveredParent = await runCliInProcess(
      await withRunTarget(['fail'], workspace),
      workspace,
    );

    expect(failRecoveredParent.exitCode).toBe(0);
    expect(failRecoveredParent.stdout).not.toContain('Reviewing');
    const session = await readSession(workspace);
    expect(session.active).not.toBe(parentRunId);
    const updatedParent = await readRunbookState(workspace, parentRunId);
    expect(updatedParent?.substepStates).toContainEqual(
      expect.objectContaining({
        id: '1',
        status: 'running',
        inline: expect.objectContaining({
          childRunId: session.active,
        }),
      }),
    );
  });

  it('preserves child runbook identity for artifacts produced by automatic inline launch', async () => {
    await writeFile(
      join(workspace.rootRunbooksDir(), 'parent.runbook.md'),
      `---
name: parent
required:
  - PlanPath
inputs:
  - PlanPath
---
# Parent

## 1. Start
- PASS CONTINUE

Ready.

## 2. Write
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md

## 3. Review
- PASS COMPLETE

Reviewing {{PlanPath}}.
`,
    );
    const childRunbook = `---
name: child
outputs:
  - PlanPath
---
# Child

## 1. Create
- ARTIFACTS
  - PlanPath "plan.json"
- PASS COMPLETE

Child prompt.
`;
    await writeFile(join(workspace.rootRunbooksDir(), 'child.runbook.md'), childRunbook);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childRunbook);

    const start = await runCliInProcess(
      'run runbooks/parent.runbook.md --input PlanPath=/placeholder/input.txt',
      workspace,
    );
    expect(start.exitCode).toBe(0);
    const parentRunId = (await readSession(workspace)).active;
    if (!parentRunId) throw new Error('expected active parent runbook');

    const passParentStep = await runCliInProcess(
      await withRunTarget(['pass'], workspace),
      workspace,
    );
    expect(passParentStep.exitCode).toBe(0);
    const childRunId = (await readSession(workspace)).active;
    if (!childRunId || childRunId === parentRunId) {
      throw new Error('expected active inline child runbook');
    }

    const passChild = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);
    expect(passChild.exitCode).toBe(0);

    const parentState = await readRunbookState(workspace, parentRunId);
    const variables = parentState?.variables as Record<string, unknown> | undefined;
    const planPath = variables?.PlanPath as
      | {
          readonly kind?: unknown;
          readonly runId?: unknown;
          readonly uri?: unknown;
          readonly runbook?: { readonly path?: unknown };
        }
      | undefined;

    expect(planPath).toEqual(
      expect.objectContaining({
        kind: 'artifact-record',
        runId: childRunId,
        runbook: expect.objectContaining({
          path: expect.stringContaining('child.runbook.md'),
        }),
      }),
    );
    expect(planPath?.uri).toEqual(expect.stringContaining(`/${childRunId}/plan.json`));
    expect(passChild.stdout).toContain('Reviewing');
    expect(passChild.stdout).toContain('plan.json');
    expect(passChild.stdout).not.toContain('/placeholder/input.txt');
  });

  it('exits zero when inline child failure is handled by parent FAIL ANY CONTINUE', async () => {
    await writeFile(
      join(workspace.rootRunbooksDir(), 'parent.runbook.md'),
      `# Parent

## 1. Start
- PASS CONTINUE

Ready.

## 2. Gate
- PASS ALL CONTINUE
- FAIL ANY CONTINUE

- child.runbook.md

## 3. Done
- PASS COMPLETE

Done.
`,
    );
    await writeFile(
      join(workspace.rootRunbooksDir(), 'child.runbook.md'),
      `# Child

## 1. Check
- PASS COMPLETE
- FAIL STOP

Child prompt.
`,
    );
    await writeFile(
      join(workspace.runbooksDir(), 'child.runbook.md'),
      `# Child

## 1. Check
- PASS COMPLETE
- FAIL STOP

Child prompt.
`,
    );

    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const passStart = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);
    expect(passStart.exitCode).toBe(0);

    const session = await readSession(workspace);
    const childRunId = session.defaultStack.at(-1);
    expect(childRunId).toBeDefined();
    const childBeforeFail = await readRunbookState(workspace, childRunId!);
    expect(childBeforeFail?.parentLinkage?.kind).toBe('inline');

    const failChild = await runCliInProcess(await withRunTarget(['fail'], workspace), workspace);
    expect(failChild.exitCode).toBe(0);

    const parentRunId = childBeforeFail!.parentLinkage!.parentRunId;
    const parentAfter = await readRunbookState(workspace, parentRunId);
    expect(parentAfter?.lifecycle).toBe('running');
    expect(parentAfter?.step).toBe('3');
    expect(parentAfter?.retryCount).toBe(0);
  });

  it('rejects automatic inline launch inside a claimed child delegation scope', async () => {
    await writeFile(
      join(workspace.rootRunbooksDir(), 'parent.runbook.md'),
      `# Parent

## 1. Delegate
- DELEGATE
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Claimed child
- child.runbook.md
`,
    );

    const childRunbook = `# Child

## 1. Start
- PASS CONTINUE

Claimed child start.

## 2. Inline grandchild
- PASS ALL CONTINUE
- FAIL ANY STOP

### 2.1 Grandchild
- grandchild.runbook.md

## 3. Done
- PASS COMPLETE

Claimed child done.
`;
    await writeFile(join(workspace.rootRunbooksDir(), 'child.runbook.md'), childRunbook);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childRunbook);

    const grandchildRunbook = `# Grandchild

## 1. Work
- PASS COMPLETE

Grandchild prompt.
`;
    await writeFile(join(workspace.rootRunbooksDir(), 'grandchild.runbook.md'), grandchildRunbook);
    await writeFile(join(workspace.runbooksDir(), 'grandchild.runbook.md'), grandchildRunbook);

    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const token = findDelegateToken(start.stdout, '1.1');

    const claim = await runCliInProcess(['claim', token], workspace);
    expect(claim.exitCode).toBe(0);
    const claimedChild = findClaim(claim.stdout);

    const passClaimedChild = await runCliInProcess(
      ['pass', '--claim-id', claimedChild.claimId],
      workspace,
    );
    expect(passClaimedChild.exitCode).toBe(1);

    const events = flattenEvents(parseConcatenatedJson(passClaimedChild.stdout));
    expect(events).toContainEqual(
      expect.objectContaining({
        action: 'stop',
        code: 'INLINE_LAUNCH_FORBIDDEN',
        message: 'Automatic inline launch is not supported inside claimed child scopes.',
        stopped: true,
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ code: 'INLINE_CHILD_LAUNCH_FAILED' }),
    );
    expect(passClaimedChild.stderr).not.toMatch(/generic failure/i);

    const childState = await readRunbookState(workspace, claimedChild.runId);
    expect(childState).not.toBeNull();
    const lastAction = (
      childState?.snapshot as { readonly context?: { readonly lastAction?: unknown } } | undefined
    )?.context?.lastAction;
    expect(lastAction).toEqual(
      expect.objectContaining({
        type: 'INLINE_LAUNCH_FAILED',
        reason: 'inline_launch_forbidden',
      }),
    );
  });
});
