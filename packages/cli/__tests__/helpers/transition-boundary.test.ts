import { describe, it, expect } from '@jest/globals';
import { readFile } from 'node:fs/promises';

describe('CLI transition boundary', () => {
  it('does not use raw actor send or updateFromActor in runbook transition helpers', async () => {
    const files = [
      new URL('../../src/helpers/transitions.ts', import.meta.url),
      new URL('../../src/helpers/goto-workflow.ts', import.meta.url),
    ];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      expect(source).not.toMatch(/\bactor\.send\s*\(/);
      expect(source).not.toMatch(/\bupdateFromActor\s*\(/);
    }
  });

  it('does not write semantic launch initialization in runbook-pipeline', async () => {
    const source = await readFile(
      new URL('../../src/helpers/runbook-pipeline.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toMatch(/\bensureActiveEntry\s*\(/);
    expect(source).not.toMatch(/\binitializeSubsteps\s*\(/);
    expect(source).not.toMatch(/lastAction\s*:\s*\{\s*type\s*:\s*['"]START['"]/);
  });

  it('keeps transition-orchestrator render-only after actor sync', async () => {
    const source = await readFile(
      new URL('../../src/helpers/transition-orchestrator.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toMatch(/manager\.update\s*\(/);
    expect(source).not.toMatch(/manager\.load\s*\(/);
    expect(source).not.toMatch(/lastAction\s*:/);
    expect(source).not.toMatch(/lastResult\s*:/);
    expect(source).not.toMatch(/lifecycle\s*:\s*['"](completed|stopped)['"]/);
  });

  it('does not clear lastResult in goto-workflow', async () => {
    const source = await readFile(
      new URL('../../src/helpers/goto-workflow.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toMatch(/clearLastResult\s*\(/);
  });

  it('does not assemble synthetic transition events from execution.ts', async () => {
    const source = await readFile(
      new URL('../../src/services/execution.ts', import.meta.url),
      'utf8',
    );

    // The stopped-on-entry path (artifact resolution failure pre-loop) must
    // route through deriveTransitionObservation, not local payload assembly.
    expect(source).not.toMatch(/extractLastAction\s*\(/);
    expect(source).not.toMatch(/isInternalFailureLastAction\s*\(/);
    expect(source).not.toMatch(/extractInternalFailureMessage\s*\(/);
    expect(source).not.toMatch(/deriveStoppedReason\s*\(/);
    expect(source).not.toMatch(/parseActionType\s*\(/);
  });

  it('passes command stream options into fresh inline child launches', async () => {
    const source = await readFile(
      new URL('../../src/services/execution.ts', import.meta.url),
      'utf8',
    );

    expect(source).toMatch(
      /const launchResult = await startRunbook\(\s*\{\s*output,\s*manager,\s*actorService,\s*sessionService,\s*lifecycleService: new ExecutionLifecycleService\(manager\),\s*cwd,\s*commandStreamOptions,\s*\}/,
    );
  });

  it('does not send COMMAND_RESULT or inline command observation payloads from CLI execution code', async () => {
    const source = await readFile(
      new URL('../../src/services/execution.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain("type: 'COMMAND_RESULT'");
    expect(source).not.toContain('type: "COMMAND_RESULT"');
    expect(source).not.toContain("emitter.emit('STEP_ENTERED'");
    expect(source).not.toContain('emitter.emit("STEP_ENTERED"');
    expect(source).not.toContain("emitter.emit('COMMAND_STARTED'");
    expect(source).not.toContain("emitter.emit('COMMAND_COMPLETED'");
    expect(source).not.toContain("manager.update(runbookId, {\n        lifecycle: 'stopped'");
  });

  // Positive emit coverage is provided by transition-orchestrator.test.ts
  // ('returns the synchronized updated state on non-terminal transitions'),
  // which asserts the exact { action: 'CONTINUE', from: '1', at: '2', result: 'PASS' }
  // shape through the sink. Duplicating it here is unnecessary.
});
