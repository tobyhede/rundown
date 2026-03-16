import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  createRunbook,
  runCli,
  parseJsonEvents,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('FOR loop fallback (prompted FOR with unresolved bounds)', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('unresolved FOR waits (returns waiting) with FOR text in prompt', async () => {
    const content = createRunbook({
      name: 'Unresolved FOR',
      title: 'Unresolved FOR Test',
      steps: [
        {
          title: 'Process items',
          for: { variable: 'item', start: 1, end: '{{N}}' },
          pass: 'CONTINUE',
          substeps: [
            {
              title: 'Handle item',
              command: 'rd echo item={{item}}',
            },
          ],
        },
      ],
    });
    await writeFile(join(workspace.cwd, 'unresolved-for.runbook.md'), content);

    // Run WITHOUT providing N — should wait (prompted FOR)
    const result = runCli('run --json unresolved-for.runbook.md', workspace);

    const events = parseJsonEvents(result.stdout) as Record<string, unknown>[];

    // Should have a step_entered event (substep rendered)
    const stepEnteredEvents = events.filter((e) => e.type === 'step_entered');
    expect(stepEnteredEvents.length).toBeGreaterThanOrEqual(1);

    // Prompted FOR step (kind: 'prompted-for') has no iteration machinery,
    // so position does not include FOR data
    const firstEntered = stepEnteredEvents[0];
    const position = firstEntered.position as Record<string, unknown>;
    expect(position.for).toBeUndefined();

    // Prompted FOR step should emit prompted: true
    expect(firstEntered.prompted).toBe(true);

    // Should NOT have any command_started events (prompted FOR prevents auto-execution)
    const commandEvents = events.filter((e) => e.type === 'command_started');
    expect(commandEvents).toHaveLength(0);
  });

  it('resolved FOR executes normally when variable is provided', async () => {
    const content = createRunbook({
      name: 'Resolved FOR',
      title: 'Resolved FOR Test',
      steps: [
        {
          title: 'Process items',
          for: { variable: 'item', start: 1, end: '{{N}}' },
          pass: 'CONTINUE',
          substeps: [
            {
              title: 'Handle item',
              command: 'rd echo item={{item}}',
            },
          ],
        },
      ],
    });
    await writeFile(join(workspace.cwd, 'resolved-for.runbook.md'), content);

    // Run WITH N=3 — should execute all 3 iterations
    const result = runCli('run --json resolved-for.runbook.md --var N=3', workspace);
    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout) as Record<string, unknown>[];

    // Should have command_started events for each iteration
    const commandEvents = events.filter((e) => e.type === 'command_started');
    expect(commandEvents).toHaveLength(3);

    // Verify commands contain expanded item values
    expect(commandEvents[0].command as string).toContain('item=1');
    expect(commandEvents[1].command as string).toContain('item=2');
    expect(commandEvents[2].command as string).toContain('item=3');
  });
});
