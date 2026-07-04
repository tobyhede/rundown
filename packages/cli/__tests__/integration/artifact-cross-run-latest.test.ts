import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCliInProcess,
  parseConcatenatedJson,
  type TestWorkspace,
  withRunTarget,
} from '../helpers/test-utils.js';

/**
 * Cross-run `latest=true` selector resolution through same-context delegation.
 *
 * A flat single run cannot produce two manifest rows in the same
 * `(runbook.source, runbook.path, key)` group — its producer is idempotent per
 * key. Same-context delegation is the only way to accumulate sibling-run
 * artifacts under one context: a delegated child inherits the parent's
 * `ContextId` and writes into the shared manifest. This test delegates the SAME
 * child runbook twice, so both runs produce `plan.json` in one context, then
 * asserts that `latest=true` collapses the two rows to the single newest record
 * end-to-end (parser → state machine → artifactResolveActor → resolveSelector).
 *
 * The per-record winner logic (newest timestamp, then greater URI) is pinned
 * exhaustively at the unit/property layer; this test proves the collapse is
 * observable through the real CLI pipeline across sibling runs.
 */

interface FrontierEntry {
  id: string;
  token: string;
}

interface PublicArtifactRecord {
  runId: string;
  key: string;
  timestamp: string;
}

/** Walk parsed (possibly nested) events for the DELEGATE step's frontier. */
function findFrontier(events: unknown[]): FrontierEntry[] | undefined {
  for (const ev of events) {
    if (Array.isArray(ev)) {
      const nested = findFrontier(ev);
      if (nested) return nested;
    } else if (ev && typeof ev === 'object') {
      const e = ev as { type?: string; delegateFrontier?: FrontierEntry[] };
      if (e.type === 'step_entered' && e.delegateFrontier) return e.delegateFrontier;
    }
  }
  return undefined;
}

/** Find the artifacts working set bound at a given step across event streams. */
function findStepArtifacts(
  events: unknown[],
  step: string,
): Record<string, PublicArtifactRecord | PublicArtifactRecord[]> | undefined {
  let found: Record<string, PublicArtifactRecord | PublicArtifactRecord[]> | undefined;
  const walk = (nodes: unknown[]): void => {
    for (const ev of nodes) {
      if (Array.isArray(ev)) {
        walk(ev);
      } else if (ev && typeof ev === 'object') {
        const e = ev as {
          type?: string;
          position?: { current?: string };
          artifacts?: Record<string, PublicArtifactRecord | PublicArtifactRecord[]>;
        };
        // Keep the last matching entry — aggregation may re-enter the step.
        if (e.type === 'step_entered' && e.position?.current === step && e.artifacts) {
          found = e.artifacts;
        }
      }
    }
  };
  walk(events);
  return found;
}

describe('cross-run latest selector via same-context delegation', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  // Child produces `plan.json`. Delegated children inherit the parent's
  // ContextId, so two claims of this child yield two rows in one context.
  const CHILD = `# Child Plan

## 1. Generate plan
- ARTIFACTS
  - MyPlan "plan.json"
- PASS COMPLETE
- FAIL STOP

\`\`\`bash
printf '{}' > "{{ path MyPlan }}"
\`\`\`
`;

  // Parent delegates the child twice, then in step 2 resolves the shared
  // context both unfiltered (AllPlans → 2) and with latest=true (LatestPlan → 1).
  const PARENT = `# Cross-run latest parent

## 1. Fan-out
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 First planner
- child-plan.runbook.md

### 1.2 Second planner
- child-plan.runbook.md

## 2. Resolve newest plan
- ARTIFACTS
  - AllPlans "rd://artifacts/{{ ContextId }}/*/plan.json"
  - LatestPlan "rd://artifacts/{{ ContextId }}/*/plan.json?latest=true"
- PASS COMPLETE
- FAIL STOP

\`\`\`bash
rd echo --result pass
\`\`\`
`;

  it('collapses two sibling-run artifacts to the newest record', async () => {
    // Child must resolve via discovery; write to both project locations.
    await writeFile(join(workspace.cwd, 'runbooks', 'child-plan.runbook.md'), CHILD);
    await writeFile(join(workspace.runbooksDir(), 'child-plan.runbook.md'), CHILD);
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), PARENT);

    // Start the parent. It pauses on the DELEGATE step and auto-issues a token
    // per substep. --allow-all lets each claimed child run its producer command
    // non-interactively (the child writes a file, unlike rd-internal echo).
    const start = await runCliInProcess(
      'run runbooks/parent.runbook.md --allow-all --non-interactive',
      workspace,
    );
    expect(start.exitCode).toBe(0);

    const frontier = findFrontier(parseConcatenatedJson(start.stdout)) ?? [];
    const token1 = frontier.find((f) => f.id === '1.1')?.token;
    const token2 = frontier.find((f) => f.id === '1.2')?.token;
    expect(token1).toBeDefined();
    expect(token2).toBeDefined();

    // Claim each child in order so timestamps are strictly increasing: the
    // second claim's artifact is the newest and must win the latest group.
    const claim1 = await runCliInProcess(
      ['claim', token1!, '--allow-all', '--non-interactive'],
      workspace,
    );
    expect(claim1.exitCode).toBe(0);
    const claim2 = await runCliInProcess(
      ['claim', token2!, '--allow-all', '--non-interactive'],
      workspace,
    );
    expect(claim2.exitCode).toBe(0);

    // Aggregation fires when the second child resolves, advancing the parent to
    // step 2. collect is idempotent and guarantees the step-2 entry is emitted.
    const collect = await runCliInProcess(
      await withRunTarget(['collect', '--allow-all', '--non-interactive'], workspace),
      workspace,
    );
    expect(collect.exitCode).toBe(0);

    const allEvents = [claim1, claim2, collect].flatMap((r) => parseConcatenatedJson(r.stdout));
    const artifacts = findStepArtifacts(allEvents, '2');
    expect(artifacts).toBeDefined();

    // Unfiltered selector sees both sibling-run artifacts.
    const allPlans = artifacts!.AllPlans;
    expect(Array.isArray(allPlans)).toBe(true);
    expect(allPlans as PublicArtifactRecord[]).toHaveLength(2);

    // latest=true collapses the same-group rows to a single record...
    const latest = artifacts!.LatestPlan;
    expect(Array.isArray(latest)).toBe(false);
    const latestRecord = latest as PublicArtifactRecord;
    expect(latestRecord.key).toBe('plan.json');

    // ...and it is the newest of the two by manifest timestamp.
    const newest = (allPlans as PublicArtifactRecord[]).reduce((a, b) =>
      b.timestamp > a.timestamp ? b : a,
    );
    expect(latestRecord.runId).toBe(newest.runId);
    expect(latestRecord.timestamp).toBe(newest.timestamp);
  }, 30_000);
});
