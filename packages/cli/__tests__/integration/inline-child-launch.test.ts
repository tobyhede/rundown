import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  parseConcatenatedJson,
  runCliInProcess,
  type TestWorkspace,
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

describe('Automatic inline child launch integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

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
  PlanPath: "{{WorkPath}}/plan.md"
---
# Child

## 1. Create
- PASS COMPLETE

Child prompt.
`;
    await writeFile(join(workspace.rootRunbooksDir(), 'child.runbook.md'), childRunbook);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childRunbook);

    const start = await runCliInProcess(
      'run runbooks/parent.runbook.md --input PlanPath=/placeholder/plan.md',
      workspace,
    );
    if (start.exitCode !== 0) {
      throw new Error(`parent start failed:\nSTDOUT:\n${start.stdout}\nSTDERR:\n${start.stderr}`);
    }
    expect(start.exitCode).toBe(0);

    const passParentStep = await runCliInProcess('pass', workspace);
    const events = flattenEvents(parseConcatenatedJson(passParentStep.stdout));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'step_entered',
          position: expect.objectContaining({ current: '2', substep: '1' }),
          inlineLaunch: expect.objectContaining({
            childRunbookPath: expect.stringContaining('child.runbook.md'),
          }),
        }),
        expect.objectContaining({ type: 'runbook_started' }),
        expect.objectContaining({
          type: 'step_entered',
          position: expect.objectContaining({ current: '1' }),
          prompt: 'Child prompt.',
        }),
      ]),
    );

    const passChild = await runCliInProcess('pass', workspace);
    expect(passChild.exitCode).toBe(0);
    expect(passChild.stdout).toContain('Reviewing');
    expect(passChild.stdout).toContain('/plan.md');
  });
});
