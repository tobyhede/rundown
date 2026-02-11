import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCli, type TestWorkspace } from '../helpers/test-utils.js';
import { writeFile } from 'fs/promises';
import { join } from 'path';

describe('Per-step variable expansion ({{Step}}, {{Index}}, FOR loop variables)', () => {
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

  it('expands {{Step}} to step number for a simple step', async () => {
    await writeFile(
      join(workspace.cwd, 'step-var-simple.runbook.md'),
      `---
name: Step Var Simple
---
# Step Var

## 1. Running step {{Step}}
\`\`\`bash
rd echo step={{Step}}
\`\`\`

## 2. Running step {{Step}}
\`\`\`bash
rd echo step={{Step}}
\`\`\`
`
    );

    const result = runCli('run --json step-var-simple.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line));

    const stepEnteredEvents = events.filter(
      (e: Record<string, unknown>) => e.type === 'step_entered'
    );
    const commandStartedEvents = events.filter(
      (e: Record<string, unknown>) => e.type === 'command_started'
    );

    expect(stepEnteredEvents.length).toBeGreaterThanOrEqual(2);
    expect(commandStartedEvents.length).toBeGreaterThanOrEqual(2);

    // Step 1 should expand {{Step}} to "1"
    expect(stepEnteredEvents[0].description).toContain('Running step 1');
    expect(commandStartedEvents[0].command).toContain('step=1');

    // Step 2 should expand {{Step}} to "2"
    expect(stepEnteredEvents[1].description).toContain('Running step 2');
    expect(commandStartedEvents[1].command).toContain('step=2');

    // No raw {{Step}} in any event
    const allEventText = JSON.stringify(events);
    expect(allEventText).not.toContain('{{Step}}');
  });

  it('expands {{Step}} to qualified ID for a substep', async () => {
    await writeFile(
      join(workspace.cwd, 'step-var-substep.runbook.md'),
      `---
name: Step Var Substep
---
# Step Var Substep

## 1. Parent step
- PASS ALL: CONTINUE

### 1.1 Substep {{Step}}
\`\`\`bash
rd echo step={{Step}}
\`\`\`

### 1.2 Substep {{Step}}
\`\`\`bash
rd echo step={{Step}}
\`\`\`

## 2. Done at {{Step}}
\`\`\`bash
rd echo done={{Step}}
\`\`\`
`
    );

    const result = runCli('run --json step-var-substep.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line));

    const stepEnteredEvents = events.filter(
      (e: Record<string, unknown>) => e.type === 'step_entered'
    );
    const commandStartedEvents = events.filter(
      (e: Record<string, unknown>) => e.type === 'command_started'
    );

    // Should have substep 1.1, 1.2, and step 2
    expect(stepEnteredEvents.length).toBeGreaterThanOrEqual(3);
    expect(commandStartedEvents.length).toBeGreaterThanOrEqual(3);

    // Substep 1.1 → "1.1"
    expect(stepEnteredEvents[0].description).toContain('Substep 1.1');
    expect(commandStartedEvents[0].command).toContain('step=1.1');

    // Substep 1.2 → "1.2"
    expect(stepEnteredEvents[1].description).toContain('Substep 1.2');
    expect(commandStartedEvents[1].command).toContain('step=1.2');

    // Step 2 → "2" (no substep qualifier)
    expect(stepEnteredEvents[2].description).toContain('Done at 2');
    expect(commandStartedEvents[2].command).toContain('done=2');
  });

  it('expands {{Step}} alongside {{Index}} in FOR loop steps', async () => {
    await writeFile(
      join(workspace.cwd, 'step-var-for.runbook.md'),
      `---
name: Step Var FOR
---
# Step Var FOR

## 1. Loop step
- FOR i IN 1 TO 2
- PASS ALL: CONTINUE
### 1.1 Iteration {{Index}} of step {{Step}}
\`\`\`bash
rd echo step={{Step}} index={{Index}}
\`\`\`
`
    );

    const result = runCli('run --json step-var-for.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line));

    const stepEnteredEvents = events.filter(
      (e: Record<string, unknown>) => e.type === 'step_entered'
    );
    const commandStartedEvents = events.filter(
      (e: Record<string, unknown>) => e.type === 'command_started'
    );

    expect(stepEnteredEvents).toHaveLength(2);
    expect(commandStartedEvents).toHaveLength(2);

    // Both {{Step}} and {{Index}} should expand
    expect(stepEnteredEvents[0].description).toContain('Iteration 1 of step 1.1');
    expect(commandStartedEvents[0].command).toContain('step=1.1');
    expect(commandStartedEvents[0].command).toContain('index=1');

    expect(stepEnteredEvents[1].description).toContain('Iteration 2 of step 1.1');
    expect(commandStartedEvents[1].command).toContain('step=1.1');
    expect(commandStartedEvents[1].command).toContain('index=2');
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

  it('{{Index}} preserved as literal outside FOR loop (I1)', async () => {
    await writeFile(
      join(workspace.cwd, 'index-outside-for.runbook.md'),
      `---
name: Index Outside FOR
---
# Index Outside

## 1. Step with Index reference {{Index}}
\`\`\`bash
rd echo value={{Index}}
\`\`\`
`
    );

    const result = runCli('run --json index-outside-for.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line));

    const stepEnteredEvents = events.filter(
      (e: Record<string, unknown>) => e.type === 'step_entered'
    );

    expect(stepEnteredEvents.length).toBeGreaterThanOrEqual(1);
    // {{Index}} should be preserved as literal since there's no FOR loop
    expect(stepEnteredEvents[0].description).toContain('{{Index}}');
  });

  it('{{Step}} expands to named identifier for named step (I2)', async () => {
    await writeFile(
      join(workspace.cwd, 'step-named.runbook.md'),
      `---
name: Step Named
---
# Named Step Test

## 1. Setup
- PASS: GOTO ErrorHandler
- FAIL: STOP

\`\`\`bash
rd echo setup
\`\`\`

## ErrorHandler. Handle errors at {{Step}}
\`\`\`bash
rd echo step={{Step}}
\`\`\`
`
    );

    const result = runCli('run --json step-named.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line));

    const stepEnteredEvents = events.filter(
      (e: Record<string, unknown>) => e.type === 'step_entered'
    );
    const commandStartedEvents = events.filter(
      (e: Record<string, unknown>) => e.type === 'command_started'
    );

    // Find the ErrorHandler step event (second step_entered)
    expect(stepEnteredEvents.length).toBeGreaterThanOrEqual(2);
    expect(stepEnteredEvents[1].description).toContain('Handle errors at ErrorHandler');
    expect(commandStartedEvents[1].command).toContain('step=ErrorHandler');
  });

  it('expands loop variables in prompt text (I3)', async () => {
    await writeFile(
      join(workspace.cwd, 'for-prompt.runbook.md'),
      `---
name: FOR Prompt Test
---
# FOR Prompt

## 1. Process items
- FOR item IN 1 TO 2
- PASS ALL: CONTINUE

### 1.1 Handle item {{item}}
- PASS: CONTINUE
- FAIL: STOP

Process item number {{item}} carefully.

\`\`\`bash
rd echo item={{item}}
\`\`\`
`
    );

    const result = runCli('run --json for-prompt.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line));

    const stepEnteredEvents = events.filter(
      (e: Record<string, unknown>) => e.type === 'step_entered'
    );

    expect(stepEnteredEvents.length).toBeGreaterThanOrEqual(1);
    // The prompt field in step_entered should have {{item}} expanded
    expect(stepEnteredEvents[0].prompt).toContain('Process item number 1 carefully.');
  });

  it('FOR with variable bounds resolves through Phase 1 expansion (I4)', async () => {
    await writeFile(
      join(workspace.cwd, 'for-var-bounds.runbook.md'),
      `---
name: FOR Var Bounds
vars:
  Max: 3
---
# FOR Var Bounds

## 1. Process
- FOR item IN 1 TO {{Max}}
- PASS ALL: CONTINUE

### 1.1 Iteration {{Index}}
\`\`\`bash
rd echo iter={{Index}}
\`\`\`
`
    );

    const result = runCli('run --json for-var-bounds.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line));

    const stepEnteredEvents = events.filter(
      (e: Record<string, unknown>) => e.type === 'step_entered'
    );

    // Phase 1 should expand {{Max}} to 3 before FOR clause parsing
    // So we should get 3 iterations
    expect(stepEnteredEvents).toHaveLength(3);
    expect(stepEnteredEvents[0].description).toContain('Iteration 1');
    expect(stepEnteredEvents[2].description).toContain('Iteration 3');
  });

  it('FOR with multiple substeps expands variables in each (I5)', async () => {
    await writeFile(
      join(workspace.cwd, 'for-multi-sub.runbook.md'),
      `---
name: FOR Multi Substep
---
# FOR Multi Substep

## 1. Process
- FOR item IN 1 TO 2
- PASS ALL: CONTINUE

### 1.1 Fetch item {{item}}
\`\`\`bash
rd echo fetch={{item}}
\`\`\`

### 1.2 Store item {{item}}
\`\`\`bash
rd echo store={{item}}
\`\`\`
`
    );

    const result = runCli('run --json for-multi-sub.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line));

    const stepEnteredEvents = events.filter(
      (e: Record<string, unknown>) => e.type === 'step_entered'
    );

    // 2 iterations × 2 substeps = 4 step_entered events
    expect(stepEnteredEvents).toHaveLength(4);

    // Iteration 1: substep 1 and 2
    expect(stepEnteredEvents[0].description).toContain('Fetch item 1');
    expect(stepEnteredEvents[1].description).toContain('Store item 1');

    // Iteration 2: substep 1 and 2
    expect(stepEnteredEvents[2].description).toContain('Fetch item 2');
    expect(stepEnteredEvents[3].description).toContain('Store item 2');
  });

  it('FOR with single iteration (1 TO 1) works correctly (I6)', async () => {
    await writeFile(
      join(workspace.cwd, 'for-single-iter.runbook.md'),
      `---
name: FOR Single Iter
---
# FOR Single Iteration

## 1. Single
- FOR item IN 1 TO 1
- PASS ALL: CONTINUE

### 1.1 Only iteration {{item}}
\`\`\`bash
rd echo item={{item}}
\`\`\`
`
    );

    const result = runCli('run --json for-single-iter.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line));

    const stepEnteredEvents = events.filter(
      (e: Record<string, unknown>) => e.type === 'step_entered'
    );

    // Exactly 1 iteration
    expect(stepEnteredEvents).toHaveLength(1);
    expect(stepEnteredEvents[0].description).toContain('Only iteration 1');

    // No raw {{item}} in output
    const allText = JSON.stringify(stepEnteredEvents);
    expect(allText).not.toContain('{{item}}');
  });

  it('{{item}} preserved as literal outside FOR loop', async () => {
    await writeFile(
      join(workspace.cwd, 'item-outside-for.runbook.md'),
      `---
name: Item Outside FOR
---
# Item Outside

## 1. Step with item reference {{item}}
\`\`\`bash
rd echo value={{item}}
\`\`\`
`
    );

    const result = runCli('run --json item-outside-for.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line));

    const stepEnteredEvents = events.filter(
      (e: Record<string, unknown>) => e.type === 'step_entered'
    );

    expect(stepEnteredEvents.length).toBeGreaterThanOrEqual(1);
    // {{item}} should be preserved as literal since there's no FOR loop
    expect(stepEnteredEvents[0].description).toContain('{{item}}');
  });

  it('FOR loop variable {{item}} does not leak into subsequent step', async () => {
    await writeFile(
      join(workspace.cwd, 'for-scope.runbook.md'),
      `---
name: FOR Variable Scope
---
# FOR Variable Scope

## 1. Loop step
- FOR item IN 1 TO 2
- PASS ALL: CONTINUE
### 1.1 Process item {{item}}
\`\`\`bash
rd echo item={{item}}
\`\`\`

## 2. After loop uses {{item}}
\`\`\`bash
rd echo after={{item}}
\`\`\`
`
    );

    const result = runCli('run --json for-scope.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const events = result.stdout
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line));

    const stepEnteredEvents = events.filter(
      (e: Record<string, unknown>) => e.type === 'step_entered'
    );

    // 2 FOR iterations + step 2 = 3 step_entered events
    expect(stepEnteredEvents).toHaveLength(3);
    expect(stepEnteredEvents[0].description).toContain('Process item 1');
    expect(stepEnteredEvents[1].description).toContain('Process item 2');
    // Step 2: {{item}} should be preserved as literal, NOT expanded to '2'
    expect(stepEnteredEvents[2].description).toContain('{{item}}');
  });
});
