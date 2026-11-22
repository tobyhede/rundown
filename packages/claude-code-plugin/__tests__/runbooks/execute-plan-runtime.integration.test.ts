/**
 * Runtime integration coverage for execute-plan's delegated step 2 (#904).
 *
 * A project-local harness produces a `PlanPath` artifact and composes the
 * bundled `planning/execute-plan.runbook.md` inline on its own Owner Token.
 * Driven prompted with a simulated sub-agent, this pins what static structure
 * tests cannot: execute-plan's step 2 lists an `implement-plan` child with its
 * Claim Ticket; the claimed child inherits `PlanPath` across the delegation
 * boundary, rendered as a local work-dir path and never an `rd://` URI; and
 * the owner's `rundown collect` applies its pass and enters step 3, whose
 * code-review child gets a fresh ticket.
 *
 * #905 adds the review loop: each GOTO re-entry of step 3 (3 -> 4 -> 3)
 * reserves a new child, Collect reads only the current visit's child, and an
 * earlier visit's ticket is refused; and `rundown retry` recovers a lost
 * code-review ticket.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCli, withOwnerToken } from '../helpers/test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.join(__dirname, '..', '..');

type JsonEvent = Record<string, unknown>;

function parseJsonEvents(stdout: string): JsonEvent[] {
  const events: JsonEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        events.push(parsed as JsonEvent);
      }
    } catch {
      // skip non-JSON diagnostic lines
    }
  }
  return events;
}

function runbookPath(event: JsonEvent): string {
  const runbook = event.runbook as { readonly path?: unknown } | undefined;
  return typeof runbook?.path === 'string' ? runbook.path : '';
}

/** The Claim Ticket a `step_entered` issued for a child running `suffix`, if any. */
function ticketFor(events: JsonEvent[], suffix: string): string | undefined {
  for (const event of events) {
    if (event.type !== 'step_entered') continue;
    const children = (event.children ?? []) as { runbook?: string; ticket?: string }[];
    const child = children.find((candidate) => candidate.runbook?.endsWith(suffix));
    if (typeof child?.ticket === 'string') return child.ticket;
  }
  return undefined;
}

function startedRun(events: JsonEvent[], suffix: string): string {
  const started = events.find(
    (event) => event.type === 'runbook_started' && runbookPath(event).endsWith(suffix),
  );
  if (typeof started?.runbookId !== 'string') throw new Error(`No runbook_started for ${suffix}`);
  return started.runbookId;
}

function position(events: JsonEvent[]): string {
  const last = events.filter((event) => event.type === 'step_entered').at(-1);
  const at = last?.position as { current?: string; substep?: string } | undefined;
  if (at?.current === undefined) throw new Error('No step_entered observed');
  return at.substep !== undefined ? `${at.current}.${at.substep}` : at.current;
}

const HARNESS = `---
name: exec-plan-harness
OUTPUTS:
  - PlanPath
  - CodeReviewPath
---
# Exec Plan Harness

## 1. Seed plan
- ARTIFACTS
  - PlanPath "plan.json"
  - CodeReviewPath "code-review.json"
- PASS CONTINUE
- FAIL STOP

\`\`\`bash
printf '{}' > "{{ path PlanPath }}" && printf '{"items":[]}' > "{{ path CodeReviewPath }}"
\`\`\`

## 2. Execute
- PASS ALL COMPLETE
- FAIL ANY STOP

- planning/execute-plan.runbook.md
`;

describe('execute-plan step 2 delegation and artifact handoff (#904)', () => {
  let tempDir: string;
  let rootId: string;
  let previousPluginRoot: string | undefined;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'rd-exec-runtime-'));
    await mkdir(path.join(tempDir, '.rundown', 'runbooks'), { recursive: true });
    await writeFile(
      path.join(tempDir, '.rundown', 'runbooks', 'exec-plan-harness.runbook.md'),
      HARNESS,
    );
    previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
  });

  afterEach(async () => {
    if (previousPluginRoot === undefined) {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    } else {
      process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  function ok(args: string[]): JsonEvent[] {
    const result = runCli(args, tempDir);
    expect({ args, exitCode: result.exitCode, stdout: result.stdout }).toMatchObject({
      exitCode: 0,
    });
    return parseJsonEvents(result.stdout);
  }

  function pass(events: JsonEvent[], runId: string): JsonEvent[] {
    return ok(withOwnerToken(['pass', '--step', position(events)], tempDir, runId));
  }

  /** Drive the harness, prompted, to execute-plan's delegated step 2. */
  function driveToImplementDelegation(): JsonEvent[] {
    const events = ok(['run', '--prompted', 'exec-plan-harness']);
    rootId = startedRun(events, 'exec-plan-harness.runbook.md');
    for (let i = 0; i < 3 && ticketFor(events, 'implement-plan.runbook.md') === undefined; i += 1) {
      events.push(...pass(events, rootId));
    }
    return events;
  }

  it('lists an implement-plan child with its Claim Ticket at execute-plan step 2', () => {
    const events = driveToImplementDelegation();
    expect(ticketFor(events, 'implement-plan.runbook.md')).toMatch(/^rdt_/);
    const entry = events.filter((event) => event.type === 'step_entered').at(-1);
    expect(runbookPath(entry ?? {})).toBe('planning/execute-plan.runbook.md');
    expect(entry?.position).toMatchObject({ current: '2', substep: '1' });
  });

  it('hands PlanPath to the claimed implement-plan child as a local path, and collect enters code review', () => {
    const events = driveToImplementDelegation();
    const claim = ok(['claim', ticketFor(events, 'implement-plan.runbook.md') ?? '']);
    const childId = startedRun(claim, 'implement-plan.runbook.md');

    const step2 = pass(claim, childId);
    const entry = step2.find((event) => event.type === 'step_entered');
    const prompt = typeof entry?.prompt === 'string' ? entry.prompt : '';
    expect(prompt).toMatch(/\.rundown\/work\/.*plan\.json/);
    expect(prompt).not.toContain('rd://artifacts/');

    const done = pass(pass(step2, childId), childId);
    expect(done.some((event) => event.type === 'runbook_completed')).toBe(true);

    const collected = ok(withOwnerToken(['collect'], tempDir, rootId));
    expect(collected[0]).toMatchObject({
      type: 'children_collected',
      children: [expect.objectContaining({ status: 'collected', result: 'pass' })],
    });
    expect(ticketFor(collected, 'code-review.runbook.md')).toMatch(/^rdt_/);
  });

  /** Every child a `step_entered` listed for a runbook ending in `suffix`, in order. */
  function childrenFor(events: JsonEvent[], suffix: string): { runId: string; ticket: string }[] {
    return events
      .filter((event) => event.type === 'step_entered')
      .flatMap(
        (event) => (event.children ?? []) as { runId: string; runbook?: string; ticket?: string }[],
      )
      .filter((child) => child.runbook?.endsWith(suffix) && typeof child.ticket === 'string')
      .map((child) => ({ runId: child.runId, ticket: child.ticket ?? '' }));
  }

  /** Run a command the CLI must refuse, returning its error envelope. */
  function refused(args: string[]): JsonEvent {
    const result = runCli(args, tempDir);
    expect({ args, exitCode: result.exitCode }).toMatchObject({ exitCode: 1 });
    // The error envelope is one pretty-printed JSON document.
    return JSON.parse(result.stdout) as JsonEvent;
  }

  /** Claim a ticket and fail the child at its first step: a failing Child Result. */
  function failChild(ticket: string, suffix: string): string {
    const claim = ok(['claim', ticket]);
    const childId = startedRun(claim, suffix);
    const failed = runCli(withOwnerToken(['fail', '--step', '1'], tempDir, childId), tempDir);
    expect(failed.exitCode).toBe(1);
    return childId;
  }

  /** Claim a ticket and pass the child to completion: a passing Child Result. */
  function passChild(ticket: string, suffix: string): string {
    const claim = ok(['claim', ticket]);
    const childId = startedRun(claim, suffix);
    let events = claim;
    for (let i = 0; i < 5 && !events.some((event) => event.type === 'runbook_completed'); i += 1) {
      events = pass(events, childId);
    }
    expect(events.some((event) => event.type === 'runbook_completed')).toBe(true);
    return childId;
  }

  it('reserves a new child on each re-entry of the 3 -> 4 -> 3 review loop and collects only the current one (#905)', () => {
    const events = driveToImplementDelegation();
    passChild(ticketFor(events, 'implement-plan.runbook.md') ?? '', 'implement-plan.runbook.md');
    const entered: JsonEvent[] = [...ok(withOwnerToken(['collect'], tempDir, rootId))];
    const review = () => childrenFor(entered, 'code-review.runbook.md');
    const address = () => childrenFor(entered, 'address-review.runbook.md');
    expect(review()).toHaveLength(1);

    // First visit to step 3: the review fails, FAIL ANY CONTINUE enters step 4.
    const firstReview = failChild(review()[0].ticket, 'code-review.runbook.md');
    entered.push(...ok(withOwnerToken(['collect'], tempDir, rootId)));
    expect(address()).toHaveLength(1);

    // Step 4's fix passes: PASS ALL GOTO 3 re-enters the review step.
    passChild(address()[0].ticket, 'address-review.runbook.md');
    const reentry = ok(withOwnerToken(['collect'], tempDir, rootId));
    entered.push(...reentry);
    expect(reentry.find((event) => event.type === 'step_transitioned')).toMatchObject({
      action: 'GOTO',
      at: '3.1',
    });
    expect(review()).toHaveLength(2);
    const [first, second] = review();
    expect(second.runId).not.toBe(first.runId);
    expect(first.runId).toBe(firstReview);

    // Collect reads only the current visit's child: the finished first review
    // is neither reported nor applied again.
    const pending = ok(withOwnerToken(['collect'], tempDir, rootId));
    expect(pending[0]).toMatchObject({
      type: 'children_collected',
      children: [{ step: '3.1', runId: second.runId, status: 'unclaimed' }],
    });
    // Its ticket is refused as no longer counted, never re-claimed.
    expect(refused(['claim', first.ticket])).toMatchObject({ code: 'DELEGATION_CANCELLED' });

    // Second loop: each re-entry reserves afresh again.
    failChild(second.ticket, 'code-review.runbook.md');
    entered.push(...ok(withOwnerToken(['collect'], tempDir, rootId)));
    expect(address()).toHaveLength(2);
    expect(address()[1].runId).not.toBe(address()[0].runId);
    passChild(address()[1].ticket, 'address-review.runbook.md');
    entered.push(...ok(withOwnerToken(['collect'], tempDir, rootId)));
    expect(new Set(review().map((child) => child.runId)).size).toBe(3);

    // Status lists only the third visit's child, and never a ticket.
    const status = runCli(
      ['status', '--run', startedRun(events, 'execute-plan.runbook.md')],
      tempDir,
    );
    expect(status.exitCode).toBe(0);
    expect(status.stdout).not.toMatch(/rdt_/);
    expect((JSON.parse(status.stdout) as JsonEvent).children).toEqual([
      { runId: review()[2].runId, step: '3.1', status: 'reserved' },
    ]);
  });

  it('retries a lost code-review ticket: the old ticket is refused and the new one is claimed (#905)', () => {
    const events = driveToImplementDelegation();
    passChild(ticketFor(events, 'implement-plan.runbook.md') ?? '', 'implement-plan.runbook.md');
    const collected = ok(withOwnerToken(['collect'], tempDir, rootId));
    const lost = ticketFor(collected, 'code-review.runbook.md') ?? '';

    const retried = ok(withOwnerToken(['retry', '--step', '3.1'], tempDir, rootId));

    expect(retried[0]).toMatchObject({
      type: 'delegation_retried',
      step: '3.1',
      children: [expect.objectContaining({ ticket: expect.stringMatching(/^rdt_/) })],
    });
    const fresh = (retried[0].children as { ticket: string }[])[0].ticket;
    expect(fresh).not.toBe(lost);
    expect(refused(['claim', lost])).toMatchObject({ code: 'DELEGATION_CANCELLED' });
    expect(startedRun(ok(['claim', fresh]), 'code-review.runbook.md')).toMatch(/^rd_/);
  });
});
