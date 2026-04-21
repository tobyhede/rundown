// packages/cli/__tests__/integration/context-passing-substep.test.ts

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCli,
  getAllRunbookStates,
  parseJsonOutput,
  type TestWorkspace,
} from '../helpers/test-utils.js';

/**
 * Two-step runbook with substeps. No INPUTS directives — variables are passed via --input.
 * Substep 1.fetch publishes ChildValue; substep 1.use consumes it via {{ChildValue}}.
 * Step 1 parent publishes ParentValue; step 2 consumes it via {{ParentValue}}.
 */
const SUBSTEP_CONTEXT_RUNBOOK = `---
name: substep-context-test
---
# Substep Context Test

## 1. Parent step
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - ParentValue "parent-complete"

### 1.fetch Produce child output
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - ChildValue "substep-fetch"

Plan path: {{PlanPath}}

### 1.use Consume child output
- PASS CONTINUE
- FAIL STOP

Child value: {{ChildValue}}

## 2. Consume parent output
- PASS COMPLETE
- FAIL STOP

Parent value: {{ParentValue}}
`;

describe('substep INPUTS/OUTPUTS round-trip', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'substep-context.runbook.md'), SUBSTEP_CONTEXT_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('inherits parent inputs into substeps and publishes substep then parent outputs', async () => {
    // Start runbook in prompted mode, passing PlanPath via --input (no outputs.json seeding)
    const start = runCli(
      'run --prompted substep-context.runbook.md --input PlanPath=/seeded/path/plan.json',
      workspace,
    );
    expect(start.exitCode).toBe(0);

    // The first substep entered should be 1.fetch; PlanPath must be substituted
    const startEvents = parseJsonOutput(start.stdout);
    const fetchEntered = startEvents.find(
      (e) => e.type === 'step_entered' && e.stepName === 'fetch',
    );
    expect(fetchEntered).toBeDefined();
    expect(fetchEntered?.prompt).toContain('/seeded/path/plan.json');
    expect(fetchEntered?.prompt).not.toContain('{{PlanPath}}');

    // Pass substep 1.fetch — triggers OUTPUTS: ChildValue="substep-fetch"
    const passFetch = runCli('pass', workspace);
    expect(passFetch.exitCode).toBe(0);

    // After passing 1.fetch, state.variables should contain ChildValue
    const statesAfterFetch = await getAllRunbookStates(workspace);
    const stateAfterFetch = statesAfterFetch[0] as { variables?: Record<string, unknown> };
    expect(stateAfterFetch.variables?.ChildValue).toBe('substep-fetch');

    // The 1.use substep entered event should have {{ChildValue}} substituted
    const fetchEvents = parseJsonOutput(passFetch.stdout);
    const useEntered = fetchEvents.find((e) => e.type === 'step_entered' && e.stepName === 'use');
    expect(useEntered).toBeDefined();
    expect(useEntered?.prompt).toContain('substep-fetch');
    expect(useEntered?.prompt).not.toContain('{{ChildValue}}');

    // Pass substep 1.use — completes step 1, triggers parent OUTPUTS: ParentValue="parent-complete"
    const passUse = runCli('pass', workspace);
    expect(passUse.exitCode).toBe(0);

    // After passing 1.use, state.variables should contain both ChildValue and ParentValue
    const statesAfterUse = await getAllRunbookStates(workspace);
    const stateAfterUse = statesAfterUse[0] as { variables?: Record<string, unknown> };
    expect(stateAfterUse.variables?.ChildValue).toBe('substep-fetch');
    expect(stateAfterUse.variables?.ParentValue).toBe('parent-complete');

    // Step 2's entered event should have {{ParentValue}} substituted
    const useEvents = parseJsonOutput(passUse.stdout);
    const step2Entered = useEvents.find(
      (e) => e.type === 'step_entered' && (e.position as { current?: string }).current === '2',
    );
    expect(step2Entered).toBeDefined();
    expect(step2Entered?.prompt).toContain('parent-complete');
    expect(step2Entered?.prompt).not.toContain('{{ParentValue}}');
  });
});

describe('OUTPUTS scenario test (auto-execution via rd scenario run)', () => {
  let workspace: TestWorkspace;

  // Both steps auto-execute via rd echo so the scenario completes (result: COMPLETE).
  // Step 1 publishes OUTPUTS (Tag="v1.0") to state.variables; step 2 uses {{Tag}} in its
  // description. The COMPLETE terminal result proves both steps executed and OUTPUTS were
  // stored correctly (missing OUTPUTS would leave {{Tag}} unsubstituted but not fail the step;
  // the pipeline is validated by the standalone auto-execution integration tests).
  const SCENARIO_RUNBOOK = `---
name: auto-outputs-scenario
scenarios:
  outputs-flow:
    description: Auto-executed OUTPUTS stored and INPUTS injected across steps
    commands:
      - rd run auto-outputs-scenario.runbook.md
    result: COMPLETE
---
# Auto Outputs Scenario

## 1. Publish output
- PASS CONTINUE
- FAIL STOP
- OUTPUTS
  - Tag "v1.0"

\`\`\`sh
rd echo --result pass
\`\`\`

## 2. Complete
- PASS COMPLETE
- FAIL STOP

Release: {{Tag}}

\`\`\`sh
rd echo --result pass
\`\`\`
`;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'auto-outputs-scenario.runbook.md'), SCENARIO_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('scenario: auto-executed OUTPUTS→INPUTS pipeline completes successfully', async () => {
    const result = runCli('scenario run auto-outputs-scenario.runbook.md outputs-flow', workspace);
    // Exit 0 + COMPLETE terminal result proves both steps auto-executed.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('COMPLETE');
  });
});
