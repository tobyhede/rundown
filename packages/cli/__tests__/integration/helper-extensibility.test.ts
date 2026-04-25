// packages/cli/__tests__/integration/helper-extensibility.test.ts

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCli,
  parseJsonEvents,
  type TestWorkspace,
} from '../helpers/test-utils.js';

/**
 * A minimal runbook that uses the `upper` helper in its step body.
 *
 * With the helper registered, `{{ upper Name }}` renders as "WORLD" when
 * `Name=world`.  Without the helper, the call site is left verbatim in the
 * step prompt because neither the helper-call regex (which has a space) nor
 * the plain-variable regex (no space) fully resolve it.
 */
const HELPER_RUNBOOK = `---
name: helper-demo
---
# Helper Demo

## 1. Greet
- PASS COMPLETE
- FAIL STOP

Hello, {{ upper Name }}!
`;

/** ESM helper module content — .mjs so Node.js loads it as an ES module. */
const HELPER_MODULE_CONTENT =
  'export function upper(value) {\n  return String(value).toUpperCase();\n}\n';

describe('Helper extensibility — end-to-end (helper registered via .rundownrc)', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();

    // Create helper directory under .rundown
    const helperDir = join(workspace.cwd, '.rundown', 'helpers');
    await mkdir(helperDir, { recursive: true });

    // Write .mjs helper module
    await writeFile(join(helperDir, 'fmt.mjs'), HELPER_MODULE_CONTENT);

    // Declare the helper path in .rundownrc (JSON format)
    await writeFile(
      join(workspace.cwd, '.rundownrc'),
      JSON.stringify({ helpers: ['.rundown/helpers/fmt.mjs'] }, null, 2),
    );

    // Write the runbook
    await writeFile(join(workspace.cwd, 'demo.runbook.md'), HELPER_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('resolve reports no unresolved variables when helper transforms the placeholder', () => {
    const result = runCli('resolve demo.runbook.md --input Name=world', workspace);

    expect(result.exitCode).toBe(0);

    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.valid).toBe(true);

    // Helper dispatched successfully — no placeholder left over
    const unresolved = parsed.unresolved as string[] | undefined;
    expect(unresolved ?? []).toHaveLength(0);
  });

  it('run --prompted renders {{ upper Name }} as WORLD in the step_entered prompt', () => {
    const result = runCli('run --prompted demo.runbook.md --input Name=world', workspace);

    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout) as Array<Record<string, unknown>>;
    const stepEntered = events.find((e) => e.type === 'step_entered');

    expect(stepEntered).toBeDefined();
    // Helper applied — rendered value must be uppercase
    expect(stepEntered!.prompt).toContain('WORLD');
    // No literal placeholder should survive
    expect(stepEntered!.prompt).not.toContain('{{ upper Name }}');
  });
});

describe('Helper extensibility — end-to-end (no helper registered)', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();

    // Write the runbook only — no .rundownrc, so no helpers are loaded
    await writeFile(join(workspace.cwd, 'demo.runbook.md'), HELPER_RUNBOOK);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('run --prompted preserves {{ upper Name }} verbatim in the step_entered prompt', () => {
    const result = runCli('run --prompted demo.runbook.md --input Name=world', workspace);

    expect(result.exitCode).toBe(0);

    const events = parseJsonEvents(result.stdout) as Array<Record<string, unknown>>;
    const stepEntered = events.find((e) => e.type === 'step_entered');

    expect(stepEntered).toBeDefined();
    // Without the helper, the placeholder is left as-is
    expect(stepEntered!.prompt).toContain('{{ upper Name }}');
    // The uppercased value must not appear
    expect(stepEntered!.prompt).not.toContain('WORLD');
  });
});
