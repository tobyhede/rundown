import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCli, type TestWorkspace } from '../helpers/test-utils.js';
import { writeFile } from 'fs/promises';
import { join } from 'path';

describe('FOR loop variable expansion', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('expands loop variables in JSON output for all iterations', async () => {
    await writeFile(
      join(workspace.cwd, 'for-vars.runbook.md'),
      `---
name: FOR Vars Test
---
# FOR Vars

## 1. Process items
- FOR item IN 1 TO 3
- PASS ALL: CONTINUE
### 1.1 Handle item {{item}} index {{Index}}
\`\`\`bash
rd echo item={{item}} index={{Index}}
\`\`\`
`
    );

    const result = runCli('run --json for-vars.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    // Parse JSON events from output
    const events = result.stdout
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line));

    // Find step_entered events — JSON output uses lowercase snake_case types
    // (STEP_ENTERED → step_entered via json-renderer.ts toSnakeCase)
    const stepEnteredEvents = events.filter(
      (e: Record<string, unknown>) => e.type === 'step_entered'
    );

    // Find command_started events
    const commandStartedEvents = events.filter(
      (e: Record<string, unknown>) => e.type === 'command_started'
    );

    // Guard: ensure we found the expected number of events before indexing
    expect(stepEnteredEvents).toHaveLength(3);
    expect(commandStartedEvents).toHaveLength(3);

    // Verify first iteration
    expect(stepEnteredEvents[0].description).toContain('Handle item 1 index 1');
    expect(commandStartedEvents[0].command).toContain('item=1');
    expect(commandStartedEvents[0].command).toContain('index=1');

    // Verify second iteration
    expect(stepEnteredEvents[1].description).toContain('Handle item 2 index 2');
    expect(commandStartedEvents[1].command).toContain('item=2');

    // Verify third iteration
    expect(stepEnteredEvents[2].description).toContain('Handle item 3 index 3');
    expect(commandStartedEvents[2].command).toContain('item=3');

    // Verify no raw {{item}} or {{Index}} in any event
    const allEventText = JSON.stringify(events);
    expect(allEventText).not.toContain('{{item}}');
    expect(allEventText).not.toContain('{{Index}}');
  });

  it('expands loop variables on first iteration (bootstrap from forClause)', async () => {
    await writeFile(
      join(workspace.cwd, 'for-bootstrap.runbook.md'),
      `---
name: FOR Bootstrap
---
# FOR Bootstrap

## 1. First step is FOR
- FOR i IN 1 TO 2
- PASS ALL: CONTINUE
### 1.1 Process iteration {{i}}
\`\`\`bash
rd echo iteration={{i}}
\`\`\`
`
    );

    const result = runCli('run --json for-bootstrap.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line));

    // JSON output uses lowercase snake_case types
    const stepEnteredEvents = events.filter(
      (e: Record<string, unknown>) => e.type === 'step_entered'
    );

    // Guard: ensure we found at least the first iteration
    expect(stepEnteredEvents.length).toBeGreaterThanOrEqual(1);

    // First iteration must be expanded even before actor has run
    expect(stepEnteredEvents[0].description).toContain('Process iteration 1');
    expect(stepEnteredEvents[0].description).not.toContain('{{i}}');
  });
});
