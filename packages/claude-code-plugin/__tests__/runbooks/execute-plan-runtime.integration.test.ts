/**
 * Runtime integration coverage for the execute-plan orchestrator.
 *
 * A project-local harness produces a `PlanPath` artifact (the proven
 * parent-produces-artifact pattern), then composes the bundled
 * `planning/execute-plan.runbook.md`. We assert the runtime facts that static
 * structure tests cannot: execute-plan issues an `implement-plan` delegation
 * token, and the claimed child inherits `PlanPath` across the delegation
 * boundary (rendered as a local work-dir path, never an rd:// URI).
 *
 * Pattern: follows `end-to-end-test-runtime.integration.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  runCli,
  activeRunCapabilityFromRun,
  claimCapabilityFromOutput,
  latestRunCapabilityFromOutput,
} from '../helpers/test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.join(__dirname, '..', '..');
const pluginRootEnv = `${pluginRoot}/`;

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

function eventRunbookPath(event: JsonEvent): string {
  const runbook = event.runbook as { readonly path?: unknown } | undefined;
  return typeof runbook?.path === 'string' ? runbook.path : '';
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
    readonly state: string;
    readonly token: string;
    readonly runbook: string;
  }>;
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
cat > "{{ path PlanPath }}" <<'JSON'
{"$schema":"https://rundown.org/schemas/plan.schema.json","name":"fixture","meta":{"version":"1.0.0"},"goal":"g","architecture_and_approach":"a","constraints_and_assumptions":"c","files":[{"path":"src/x.ts","action":"create"}],"tasks":[{"name":"t1","files":[],"subtasks":[{"name":"s1"}]}]}
JSON
\`\`\`

## 2. Execute
- PASS ALL COMPLETE
- FAIL ANY STOP

- planning/execute-plan.runbook.md
`;

describe('execute-plan runtime delegation + artifact handoff', () => {
  let tempDir: string;
  let previousPluginRoot: string | undefined;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'rd-exec-runtime-'));
    await mkdir(path.join(tempDir, '.rundown', 'runs'), { recursive: true });
    await mkdir(path.join(tempDir, '.rundown', 'runbooks'), { recursive: true });
    await writeFile(
      path.join(tempDir, '.rundown', 'runbooks', 'exec-plan-harness.runbook.md'),
      HARNESS,
    );
    previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = pluginRootEnv;
  });

  afterEach(async () => {
    if (previousPluginRoot === undefined) {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    } else {
      process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  function status(): StatusResponse {
    const result = runCli(['status'], tempDir);
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout) as StatusResponse;
  }

  function driveToImplementDelegate(): { token: string } {
    const start = runCli(['run', '--prompted', '--allow-all', 'exec-plan-harness'], tempDir);
    expect(start.exitCode).toBe(0);
    let runCapability = activeRunCapabilityFromRun(start);
    for (let i = 0; i < 12; i += 1) {
      const current = status();
      const pending = current.delegations?.find(
        (d) => d.state === 'pending' && d.runbook.endsWith('implement-plan.runbook.md'),
      );
      if (
        pending &&
        current.file?.endsWith('execute-plan.runbook.md') &&
        current.position?.current === '2'
      ) {
        return { token: pending.token };
      }
      const advance = runCli(['pass', '--run-capability', runCapability], tempDir);
      expect(advance.exitCode).toBe(0);
      runCapability = latestRunCapabilityFromOutput(advance.stdout) ?? runCapability;
    }
    throw new Error('Did not reach execute-plan implement DELEGATE step');
  }

  it('issues an implement-plan delegation token at execute-plan step 2', () => {
    const { token } = driveToImplementDelegate();
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
  });

  it('hands PlanPath through to the delegated implement-plan child as a local path', () => {
    const { token } = driveToImplementDelegate();

    const claim = runCli(['claim', token], tempDir);
    expect(claim.exitCode).toBe(0);
    const claimEvent = parseJsonEvents(claim.stdout).find((event) => event.kind === 'claim') as
      | { claim_id?: string }
      | undefined;
    expect(claimEvent).toBeDefined();
    const claimId = claimEvent?.claim_id;
    expect(claimId).toEqual(expect.stringMatching(/^rdclm_/));
    const claimCapability = claimCapabilityFromOutput(claim.stdout);
    expect(claimCapability).toEqual(expect.stringMatching(/^rdcc_/));

    expect(
      enteredStep(parseJsonEvents(claim.stdout), 'implement-plan.runbook.md', '1'),
    ).toBeDefined();

    // Step 2 of implement-plan rehydrates the inherited PlanPath artifact.
    const advance2Result = runCli(['pass', '--claim-capability', claimCapability!], tempDir);
    expect(advance2Result.exitCode).toBe(0);
    const advance2 = parseJsonEvents(advance2Result.stdout);
    const step2 = enteredStep(advance2, 'implement-plan.runbook.md', '2');
    expect(step2).toBeDefined();
    const step2Artifacts = step2!.artifacts as Record<string, unknown> | undefined;
    expect(Object.keys(step2Artifacts ?? {})).toContain('PlanPath');
    const prompt = typeof step2!.prompt === 'string' ? step2!.prompt : '';
    expect(prompt).toMatch(/\.rundown\/work\/.*plan\.json/);
    expect(prompt).not.toContain('rd://artifacts/');
  });
});
