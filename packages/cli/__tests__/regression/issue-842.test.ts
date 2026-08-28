import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionService } from '@rundown-org/core';
import {
  createTestWorkspace,
  parseConcatenatedJson,
  readRunbookState,
  readSession,
  runCliInProcess,
  type TestWorkspace,
  withRunTarget,
} from '../helpers/test-utils.js';

function flattenEvents(events: unknown[]): Record<string, unknown>[] {
  const flat: Record<string, unknown>[] = [];
  for (const event of events) {
    if (Array.isArray(event)) {
      flat.push(...flattenEvents(event));
      continue;
    }
    if (event && typeof event === 'object') {
      flat.push(event as Record<string, unknown>);
    }
  }
  return flat;
}

// Issue #842, pinned to 5e43cc5dc: `propagateTerminalChildUpwardInner`
// (packages/core/src/runbook/inline-parent-advance.ts:412) is documented at
// its own :505 as the SOLE release owner — "release here exactly once and
// recurse ONE level up". On a nested inline chain where the parent has TWO
// inline-child steps and the second reaches terminal *inside* the advance
// triggered by the first, the outer seam's `buildAdvanceInlineParent` sees
// the inner seam's walk return `'done'` and releases the parent (and, by the
// same shape one level up, the grandparent) a SECOND time, then repeats the
// whole upward walk.
//
// #838/#843/#846 subsequently folded terminal Run Release into the
// terminal-state transaction and deleted `releaseOwner` entirely, which is
// exactly the mechanism this issue's repeated walk depended on. This test
// reproduces the issue's own recipe independently of that fix so it can
// stand as its acceptance evidence either way: it fails on the pinning
// assertion if the double release is still reachable, and passes if it is
// not.
describe('issue #842: inline chain releases each run exactly once', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('releases every run in the grandparent-parent-child1-child2 inline chain at most once from a single pass', async () => {
    // grandparent inline-launches parent — the CLI run target, so it lives at
    // the root runbooks path like every other `rundown run <path>` fixture.
    await writeFile(
      join(workspace.rootRunbooksDir(), 'grandparent.runbook.md'),
      `# Grandparent

## 1. Only
- PASS ALL COMPLETE
- FAIL ANY STOP

- parent.runbook.md
`,
    );

    // parent has TWO inline-child steps: child1 is manual (parks the run),
    // child2 auto-completes via a fenced command. Child2 reaching terminal
    // *inside* the advance triggered by child1's completion is the
    // load-bearing condition the issue names.
    await writeFile(
      join(workspace.runbooksDir(), 'parent.runbook.md'),
      `# Parent

## 1. First
- PASS ALL CONTINUE
- FAIL ANY STOP

- child1.runbook.md

## 2. Second
- PASS ALL COMPLETE
- FAIL ANY STOP

- child2.runbook.md
`,
    );

    await writeFile(
      join(workspace.runbooksDir(), 'child1.runbook.md'),
      `# Child1

## 1. Wait
- PASS COMPLETE
- FAIL STOP

Waiting for one pass.
`,
    );

    await writeFile(
      join(workspace.runbooksDir(), 'child2.runbook.md'),
      `# Child2

## 1. Finish automatically
- PASS COMPLETE
- FAIL STOP

\`\`\`bash
echo finished
\`\`\`
`,
    );

    const releaseSpy = jest.spyOn(SessionService.prototype, 'releaseRuns');
    try {
      const start = await runCliInProcess(
        'run runbooks/grandparent.runbook.md --allow-all',
        workspace,
      );
      expect(start.exitCode).toBe(0);

      // Parked waiting on child1: the default stack holds all three runs that
      // exist so far.
      const parked = await readSession(workspace);
      expect(parked.defaultStack).toHaveLength(3);
      const [grandparentRunId, parentRunId, child1RunId] = parked.defaultStack;
      expect(grandparentRunId).toBeDefined();
      expect(parentRunId).toBeDefined();
      expect(child1RunId).toBeDefined();
      if (!grandparentRunId || !parentRunId || !child1RunId) {
        throw new Error('expected grandparent, parent, and child1 run ids after parking');
      }

      // ONE `rundown pass` on child1's bearer claim: this drives child1 to
      // terminal, which advances parent into child2, which auto-completes
      // inside that same advance, which completes parent, which completes
      // grandparent — all inside this single command.
      const pass = await runCliInProcess(
        await withRunTarget(['pass', '--allow-all'], workspace),
        workspace,
      );
      expect(pass.exitCode).toBe(0);
      expect((await readSession(workspace)).defaultStack).toEqual([]);

      const passEvents = flattenEvents(parseConcatenatedJson(pass.stdout));

      // child2 never appears in the session stack (it launches and finishes
      // inside this one command), so its run id has to come from its own
      // `runbook_started` event.
      const knownRunIds = new Set([grandparentRunId, parentRunId, child1RunId]);
      const child2Started = passEvents.find(
        (event) =>
          event.type === 'runbook_started' &&
          typeof event.runbookId === 'string' &&
          !knownRunIds.has(event.runbookId),
      );
      const child2RunId = child2Started?.runbookId;
      expect(typeof child2RunId).toBe('string');
      if (typeof child2RunId !== 'string') {
        throw new Error('expected child2 to start inline inside the single pass');
      }

      // Sanity gate BEFORE the pinning assertion: the drive actually reached
      // terminal for every run in the chain, so a broken setup cannot
      // masquerade as either red or green on the release-count check below.
      // child1 is the directly-addressed run of this `pass`, so its own
      // completion surfaces as the command's action block (`complete: true`)
      // rather than a streamed `runbook_completed` event — persisted
      // lifecycle is the reliable signal for all four runs here.
      expect((await readRunbookState(workspace, child1RunId))?.lifecycle).toBe('completed');
      expect((await readRunbookState(workspace, child2RunId))?.lifecycle).toBe('completed');
      expect((await readRunbookState(workspace, parentRunId))?.lifecycle).toBe('completed');
      expect((await readRunbookState(workspace, grandparentRunId))?.lifecycle).toBe('completed');
      // THE PINNING ASSERTIONS, two watchpoints. First: each ancestor's
      // `runbook_completed` is emitted EXACTLY once — counted, never
      // Set-deduped, because a repeated upward walk's observable symptom is a
      // doubled completion event, and a Set would silently collapse it.
      const completionCountOf = (runId: string): number =>
        passEvents.filter(
          (event) => event.type === 'runbook_completed' && event.runbookId === runId,
        ).length;
      expect({
        child2: completionCountOf(child2RunId),
        parent: completionCountOf(parentRunId),
        grandparent: completionCountOf(grandparentRunId),
      }).toEqual({ child2: 1, parent: 1, grandparent: 1 });

      // Second: every run id appears at most once across all
      // `SessionService.releaseRuns` calls — the "release here exactly once"
      // contract the seam documented at inline-parent-advance.ts:505. At
      // 5e43cc5dc this failed with parent and grandparent both reading 2.
      // Post-#843/#846 this seam is bypassed entirely (releases fold into the
      // terminal-state transaction), so this spy guards only against a revert
      // to the standalone-release architecture; the exact-count check above
      // is what watches the current path.
      const releasedRunIds = releaseSpy.mock.calls.flatMap(([releases]) =>
        releases.map((release) => release.runId),
      );
      const releaseCountOf = (runId: string): number =>
        releasedRunIds.filter((releasedRunId) => releasedRunId === runId).length;
      const releaseCounts = {
        grandparent: releaseCountOf(grandparentRunId),
        parent: releaseCountOf(parentRunId),
        child1: releaseCountOf(child1RunId),
        child2: releaseCountOf(child2RunId),
      };

      const overReleased = Object.entries(releaseCounts).filter(([, count]) => count > 1);
      expect(overReleased).toEqual([]);
    } finally {
      releaseSpy.mockRestore();
    }
  }, 30_000);
});
