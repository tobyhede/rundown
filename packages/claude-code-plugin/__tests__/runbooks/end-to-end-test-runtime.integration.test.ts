/**
 * Runtime integration coverage for the bundled end-to-end-test workflow.
 *
 * Unlike `workflow.integration.test.ts` (which mostly validates parser/AST shape
 * and `rd check`), this suite drives the *real* runtime transitions of
 * `end-to-end-test/end-to-end-test.runbook.md` and its delegated
 * `review-and-collate.runbook.md` children:
 *
 * - inline launch of the local `write-file` and `review-and-collate` children,
 * - delegation-token issue at each `DELEGATE` substep,
 * - `rd claim` launching the delegated `review-file` child,
 * - claim-id-targeted `rd pass` advancing a prompted claimed child,
 * - auto-resolution of the parent substep and auto-advance on child completion,
 * - artifact alias handoff (the `PlanPath` produced by `write-file` flows into
 *   the delegated `review-file` child, and direct/`path` aliases render as
 *   local filesystem paths, never `rd://` URIs).
 *
 * Pattern: follows `workflow.integration.test.ts` (subprocess `runCli`, a temp
 * cwd, and `CLAUDE_PLUGIN_ROOT` pointed at the plugin so `rundown:` and bundled
 * schema artifacts resolve).
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCli } from '../helpers/test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginRoot = join(__dirname, '..', '..');

type JsonEvent = Record<string, unknown>;

/** Parse mixed CLI stdout, ignoring blank lines and non-JSON diagnostic text. */
function parseJsonEvents(stdout: string): JsonEvent[] {
  const events: JsonEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        events.push(parsed as JsonEvent);
      }
    } catch {}
  }
  return events;
}

function eventRunbookPath(event: JsonEvent): string {
  const runbook = event.runbook as { readonly path?: unknown } | undefined;
  return typeof runbook?.path === 'string' ? runbook.path : '';
}

function eventPromptText(event: JsonEvent): string {
  if (typeof event.prompt === 'string') return event.prompt;
  return typeof event.commandCode === 'string' ? event.commandCode : '';
}

function enteredStep(
  events: JsonEvent[],
  runbookSuffix: string,
  current: string,
): JsonEvent | undefined {
  return events.find(
    (event) =>
      event.type === 'step_entered' &&
      eventRunbookPath(event).endsWith(runbookSuffix) &&
      (event.position as { current?: string } | undefined)?.current === current,
  );
}

interface StatusResponse {
  readonly file?: string;
  readonly position?: { readonly current?: string };
  readonly delegations?: ReadonlyArray<{
    readonly substep: string;
    readonly state: string;
    readonly token: string;
    readonly runbook: string;
  }>;
}

describe('end-to-end-test runtime delegation + artifact handoff', () => {
  let tempDir: string;
  let previousPluginRoot: string | undefined;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'rd-e2e-runtime-'));
    await mkdir(join(tempDir, '.claude', 'rundown', 'runs'), { recursive: true });
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

  /** Advance the active runbook with a bare `rd pass` and collect its events. */
  function pass(): JsonEvent[] {
    const result = runCli(['pass'], tempDir);
    return parseJsonEvents(result.stdout);
  }

  function status(): StatusResponse {
    const result = runCli(['status'], tempDir);
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout) as StatusResponse;
  }

  /**
   * Drive the bundled workflow in prompted mode until `review-and-collate`
   * reaches its first DELEGATE substep, returning the auto-issued token and the
   * accumulated events. Bounded so a flow regression fails loudly instead of
   * hanging.
   */
  function driveToReviewDelegate(): { token: string; events: JsonEvent[] } {
    const start = runCli(['run', '--prompted', 'rundown:end-to-end-test'], tempDir);
    expect(start.exitCode).toBe(0);
    const events = parseJsonEvents(start.stdout);

    for (let i = 0; i < 12; i += 1) {
      const current = status();
      const pending = current.delegations?.find(
        (d) => d.state === 'pending' && d.runbook.endsWith('review-file.runbook.md'),
      );
      if (
        pending &&
        current.file?.endsWith('review-and-collate.runbook.md') &&
        current.position?.current === '1'
      ) {
        return { token: pending.token, events };
      }
      events.push(...pass());
    }
    throw new Error('Did not reach review-and-collate DELEGATE step');
  }

  it('inline-launches write-file and review-and-collate from the parent', () => {
    const { events } = driveToReviewDelegate();

    expect(enteredStep(events, 'end-to-end-test/write-file.runbook.md', '1')).toBeDefined();
    expect(enteredStep(events, 'end-to-end-test/review-and-collate.runbook.md', '1')).toBeDefined();
  });

  it('auto-issues a review-file delegation token at the DELEGATE substep', () => {
    const { token } = driveToReviewDelegate();
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
  });

  it('hands PlanPath through to the delegated review child as a local path', () => {
    const { token } = driveToReviewDelegate();

    const claim = runCli(['claim', token], tempDir);
    expect(claim.exitCode).toBe(0);
    const claimEvents = parseJsonEvents(claim.stdout);
    const claimResult = claimEvents.find((event) => event.kind === 'claim') as
      | { claim_id?: string }
      | undefined;
    const claimId = claimResult?.claim_id;
    expect(claimId).toEqual(expect.stringMatching(/^rdclm_/));

    // The claim launches the review-file child at step 1.
    expect(enteredStep(claimEvents, 'review-file.runbook.md', '1')).toBeDefined();

    // Step 2 of review-file rehydrates the inherited PlanPath artifact, proving
    // the alias produced by write-file was handed across the delegation.
    const advance2 = parseJsonEvents(runCli(['pass', '--claim-id', claimId!], tempDir).stdout);
    const reviewStep2 = enteredStep(advance2, 'review-file.runbook.md', '2');
    expect(reviewStep2).toBeDefined();
    const step2Artifacts = reviewStep2!.artifacts as Record<string, unknown> | undefined;
    expect(step2Artifacts).toBeDefined();
    expect(Object.keys(step2Artifacts!)).toContain('PlanPath');

    // Step 3 writes ReviewPath; its prompt renders `{{ path ReviewPath }}` as a
    // local work-dir path, never an rd:// URI (direct/path alias semantics).
    const advance3 = parseJsonEvents(runCli(['pass', '--claim-id', claimId!], tempDir).stdout);
    const reviewStep3 = enteredStep(advance3, 'review-file.runbook.md', '3');
    expect(reviewStep3).toBeDefined();
    expect(eventPromptText(reviewStep3!)).toMatch(
      /\.rundown\/work\/.*\/rd_[a-f0-9]{32}\/end-to-end-test-review\.json/,
    );
    expect(eventPromptText(reviewStep3!)).not.toContain('rd://artifacts/');
  });

  it('advances a claimed child via claim-id and auto-aggregates into the parent', () => {
    const { token } = driveToReviewDelegate();

    const claim = runCli(['claim', token], tempDir);
    expect(claim.exitCode).toBe(0);
    const claimId = (
      parseJsonEvents(claim.stdout).find((event) => event.kind === 'claim') as {
        claim_id?: string;
      }
    ).claim_id;
    expect(claimId).toEqual(expect.stringMatching(/^rdclm_/));

    // review-file has four steps; drive all of them with claim-id transitions.
    let lastEvents: JsonEvent[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = runCli(['pass', '--claim-id', claimId!], tempDir);
      expect(result.exitCode).toBe(0);
      lastEvents = parseJsonEvents(result.stdout);
    }

    // On the child's final pass the parent auto-resolves substep 1 and the
    // review-and-collate parent advances to its second DELEGATE step (collate).
    expect(
      lastEvents.some(
        (event) =>
          event.type === 'step_entered' &&
          eventRunbookPath(event).endsWith('review-and-collate.runbook.md') &&
          (event.position as { current?: string } | undefined)?.current === '2',
      ),
    ).toBe(true);

    // The parent is now at its second DELEGATE substep with a fresh collate token.
    const after = status();
    expect(after.file).toMatch(/review-and-collate\.runbook\.md$/);
    expect(after.position?.current).toBe('2');
    const collate = after.delegations?.find((d) => d.runbook.endsWith('collate-files.runbook.md'));
    expect(collate?.state).toBe('pending');
    expect(collate?.token).toEqual(expect.stringMatching(/^rdtk_/));
  });
});
