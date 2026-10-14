/**
 * Runtime integration coverage for the end-to-end-test workflow's
 * review-and-collate path (#904, ADR 0005).
 *
 * The bundled `end-to-end-test` runbook launches `write-file` and then
 * `review-and-collate` as Inline Children on the root's Owner Token (#903);
 * review-and-collate delegates `review-file` and then `collate-files`. Driven
 * through the CLI in prompted mode with a simulated sub-agent, this pins the
 * runtime facts static structure tests cannot:
 *
 * - the delegated step's `step_entered` lists each child with its Claim
 *   Ticket, and `status` never shows one;
 * - `rundown claim <ticket>` starts the child under an Owner Token of its own,
 *   inheriting `PlanPath` across the delegation boundary as a local path;
 * - the child's completion changes nothing in its parent until the root's
 *   owner runs `rundown collect`, which applies it, enters the next delegated
 *   step with a fresh ticket, and — once collate-files is Collected —
 *   completes review-and-collate, which the root Collects implicitly.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, rm } from 'node:fs/promises';
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

/** The `step_entered` events of the runbook whose path ends with `suffix`. */
function entered(events: JsonEvent[], suffix: string): JsonEvent[] {
  return events.filter(
    (event) => event.type === 'step_entered' && runbookPath(event).endsWith(suffix),
  );
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

/** The run id a `runbook_started` announced for `suffix`. */
function startedRun(events: JsonEvent[], suffix: string): string {
  const started = events.find(
    (event) => event.type === 'runbook_started' && runbookPath(event).endsWith(suffix),
  );
  if (typeof started?.runbookId !== 'string') {
    throw new Error(`No runbook_started for ${suffix}`);
  }
  return started.runbookId;
}

/** The position `--step` must name next: the last entry's substep, else its step. */
function position(events: JsonEvent[]): string {
  const last = events.filter((event) => event.type === 'step_entered').at(-1);
  const at = last?.position as { current?: string; substep?: string } | undefined;
  if (at?.current === undefined) throw new Error('No step_entered observed');
  return at.substep !== undefined ? `${at.current}.${at.substep}` : at.current;
}

describe('end-to-end-test review-and-collate on Delegation (#904)', () => {
  let tempDir: string;
  let rootId: string;
  let previousPluginRoot: string | undefined;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'rd-e2e-runtime-'));
    await mkdir(path.join(tempDir, '.claude', 'rundown', 'runs'), { recursive: true });
    // Its own .rundown/ makes the workspace its own project root, so the
    // project-root walk never reaches a .rundown/ above the temp directory.
    await mkdir(path.join(tempDir, '.rundown'));
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

  /** Run a CLI command, expecting success, and return its events. */
  function ok(args: string[]): JsonEvent[] {
    const result = runCli(args, tempDir);
    expect({ args, exitCode: result.exitCode, stdout: result.stdout }).toMatchObject({
      exitCode: 0,
    });
    return parseJsonEvents(result.stdout);
  }

  /** Pass the position `events` last entered, as the owner of `runId`. */
  function pass(events: JsonEvent[], runId: string): JsonEvent[] {
    return ok(withOwnerToken(['pass', '--step', position(events)], tempDir, runId));
  }

  /**
   * Drive the bundled workflow, prompted, to review-and-collate's delegated
   * step 1: the root's step 1, then write-file's three steps on the root
   * token. Returns every event so far.
   */
  function driveToReviewDelegation(): JsonEvent[] {
    const events = ok(['run', '--prompted', 'rundown:end-to-end-test']);
    rootId = startedRun(events, 'end-to-end-test/end-to-end-test.runbook.md');
    for (let i = 0; i < 4 && ticketFor(events, 'review-file.runbook.md') === undefined; i += 1) {
      events.push(...pass(events, rootId));
    }
    return events;
  }

  it('lists the review-file child with its Claim Ticket, and status never shows it', () => {
    const events = driveToReviewDelegation();

    const ticket = ticketFor(events, 'review-file.runbook.md');
    expect(ticket).toMatch(/^rdt_/);
    const [reviewEntry] = entered(events, 'end-to-end-test/review-and-collate.runbook.md');
    expect(reviewEntry.position).toMatchObject({ current: '1', substep: '1' });

    const status = runCli(['status'], tempDir);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).not.toMatch(/rdt_/);
  });

  it('claims review-file under its own token and hands it PlanPath as a local path', () => {
    const events = driveToReviewDelegation();
    const claim = ok([
      'claim',
      ticketFor(events, 'review-file.runbook.md') ?? '',
      '--agent-id',
      'r1',
    ]);
    const childId = startedRun(claim, 'review-file.runbook.md');
    expect(claim.find((event) => event.type === 'runbook_started')).toMatchObject({
      owner_token: expect.stringMatching(/^rdo_/),
      parent: { step: '1.1' },
    });

    const step2 = pass(claim, childId);
    const [planEntry] = entered(step2, 'review-file.runbook.md');
    expect(planEntry.position).toMatchObject({ current: '2' });
    const artifacts = (planEntry.artifacts ?? {}) as Record<string, { path?: string }>;
    expect(artifacts.PlanPath.path).toMatch(/\.rundown\/work\/.*end-to-end-test-plan\.json$/);
  });

  it('applies each delegated child only on collect, then completes review-and-collate into the root', () => {
    const events = driveToReviewDelegation();
    const claim = ok(['claim', ticketFor(events, 'review-file.runbook.md') ?? '']);
    const reviewId = startedRun(claim, 'review-file.runbook.md');
    let child = claim;
    for (let i = 0; i < 4; i += 1) child = pass(child, reviewId);
    expect(child.some((event) => event.type === 'runbook_completed')).toBe(true);

    // The child's terminal changed nothing in its parent: it rests on 1.1.
    const parentId = startedRun(events, 'end-to-end-test/review-and-collate.runbook.md');
    const before = JSON.parse(runCli(['status', '--run', parentId], tempDir).stdout) as {
      position: { current: string; substep?: string };
      children: { status: string; result?: string }[];
    };
    expect(before.position).toMatchObject({ current: '1', substep: '1' });
    expect(before.children).toEqual([
      expect.objectContaining({ status: 'completed', result: 'pass' }),
    ]);

    // The root's token collects into the Inline Child that delegated.
    const collected = ok(withOwnerToken(['collect'], tempDir, rootId));
    expect(collected[0]).toMatchObject({
      type: 'children_collected',
      children: [expect.objectContaining({ step: '1.1', status: 'collected', result: 'pass' })],
    });
    const collateTicket = ticketFor(collected, 'collate-files.runbook.md');
    expect(collateTicket).toMatch(/^rdt_/);

    const collate = ok(['claim', collateTicket ?? '']);
    const collateId = startedRun(collate, 'collate-files.runbook.md');
    let collateEvents = collate;
    for (let i = 0; i < 3; i += 1) collateEvents = pass(collateEvents, collateId);

    const done = ok(withOwnerToken(['collect'], tempDir, rootId));
    expect(
      done.some((event) => event.type === 'runbook_completed' && event.runbookId === parentId),
    ).toBe(true);
    const root = JSON.parse(runCli(['status', '--run', rootId], tempDir).stdout) as {
      position: { current: string };
    };
    expect(root.position.current).toBe('4');
  });
});
