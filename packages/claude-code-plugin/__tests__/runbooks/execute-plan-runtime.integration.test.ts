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
---
# Exec Plan Harness

## 1. Seed plan
- ARTIFACTS
  - PlanPath "plan.json"
- PASS CONTINUE
- FAIL STOP

\`\`\`bash
printf '{}' > "{{ path PlanPath }}"
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
    const prompt = String(step2.find((event) => event.type === 'step_entered')?.prompt ?? '');
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
});
