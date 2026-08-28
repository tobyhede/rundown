import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
// Static import of the command module under test: the behavioural test below
// drives it through `runCliInProcess` (a dynamic import Stryker's
// `--findRelatedTests` cannot see), so this static edge is what links the file
// into the inverse module graph. See collect.test.ts for the pattern and
// command-test-mutation-linkage.test.ts for the guard.
import { registerCollectCommand as _linkCollectCommand } from '../../src/commands/collect.js';
import { OutputEmitter } from '../../src/services/output-emitter.js';
import {
  createTestWorkspace,
  findActionOutput,
  parseConcatenatedJson,
  requireFrontierToken,
  runCliInProcess,
  readRunbookState,
  type TestWorkspace,
} from '../helpers/test-utils.js';

// Observation commit gate (#853), CLI seam: when the renderer breaks mid-way
// through the collect continuation's observation stream, the command must fail
// closed (non-zero exit) while the run rests at its last COMMITTED boundary —
// the durable state is not rewritten and no terminal is announced that the
// stream cannot deliver. Progression behavior itself is pinned at the core
// activation seam (run-progression.test.ts); this test covers only the CLI's
// observation wiring and exit mapping.
describe('collect observation gate (#853)', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await workspace.cleanup();
  });

  it('exits non-zero on a broken renderer and leaves the run at its committed boundary', async () => {
    const parent = [
      '# Parent',
      '',
      '## 1. Fan-out',
      '',
      '- PASS ALL CONTINUE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 Child',
      '',
      '- DELEGATE',
      '',
      '- child.runbook.md',
      '',
      '## 2. Command step',
      '',
      '- PASS COMPLETE',
      '- FAIL STOP',
      '',
      '```bash',
      'echo issue-853',
      '```',
      '',
    ].join('\n');
    const child = ['# Child', '', '## 1. Done', '', '- PASS COMPLETE', '', 'Done.', ''].join('\n');

    await writeFile(join(workspace.runbooksDir(), 'parent.runbook.md'), parent);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), child);

    const start = await runCliInProcess('run parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const startEvents = parseConcatenatedJson(start.stdout) as Record<string, unknown>[];
    const started = startEvents.find(
      (event) => (event as { type?: string }).type === 'runbook_started',
    );
    if (!started) throw new Error('expected a runbook_started event');
    const parentRunId = String((started as { runbookId?: unknown }).runbookId);
    const parentClaimId = String((started as { claim_id?: unknown }).claim_id);

    const token = requireFrontierToken(start.stdout, '1.1');
    const claim = await runCliInProcess(`claim ${token}`, workspace);
    expect(claim.exitCode).toBe(0);
    const childClaimId = findActionOutput<{ claim_id: string }>(claim.stdout)?.claim_id;
    const passed = await runCliInProcess(['pass', '--claim-id', String(childClaimId)], workspace);
    expect(passed.exitCode).toBe(0);

    // Break the renderer exactly once, on the follow-on command's completion
    // observation. Aggregation itself runs no commands, so the first
    // COMMAND_COMPLETED that reaches the renderer is the fenced follow-on
    // turn's — whose commit has, by the gate's ordering, already landed.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- captured only to `.call(this, …)` inside the mock below; never invoked unbound
    const realExecutionEvent = OutputEmitter.prototype.executionEvent;
    let broke = false;
    jest.spyOn(OutputEmitter.prototype, 'executionEvent').mockImplementation(function (
      this: OutputEmitter,
      event,
    ) {
      if (!broke && event.type === 'COMMAND_COMPLETED') {
        broke = true;
        throw new Error('renderer pipe closed');
      }
      realExecutionEvent.call(this, event);
    });

    const collected = await runCliInProcess(
      ['collect', '--claim-id', parentClaimId, '--allow-all'],
      workspace,
    );

    expect(broke).toBe(true);
    // Fail closed: the reporting channel died, so the command cannot claim a
    // clean finish...
    expect(collected.exitCode).not.toBe(0);
    // ...while the durable state keeps the committed boundary: the fenced turn
    // (PASS COMPLETE) landed before its observation failed.
    const after = await readRunbookState(workspace, parentRunId);
    expect(after?.lifecycle).toBe('completed');
    // The stream never asserted the finish it could not deliver.
    const events = parseConcatenatedJson(collected.stdout) as Record<string, unknown>[];
    const types = events.map((event) => (event as { type?: string }).type);
    expect(types).not.toContain('runbook_completed');
    expect(types).not.toContain('runbook_stopped');
    // The failure is the activation's typed outcome, not an escaping throw:
    // the command still concluded its own protocol — the applied collect
    // action object is rendered last — rather than unwinding into the RD-999
    // unknown-error envelope.
    expect(findActionOutput(collected.stdout)).toBeDefined();
    expect(collected.stdout).not.toContain('RD-999');
    expect(collected.stderr).not.toContain('RD-999');
    // The failure exit is DIAGNOSED (#853 review F2): the one arm whose
    // diagnostic cannot ride the observation stream — the stream is the broken
    // thing — still renders a best-effort error envelope, so an agent parsing
    // the output does not see success-shaped output beside a failure exit.
    expect(collected.stdout + collected.stderr).toContain('OBSERVATION_DELIVERY_FAILED');
  }, 20_000);
});
