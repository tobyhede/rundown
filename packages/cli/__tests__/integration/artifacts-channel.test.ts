import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendArtifactManifestRecordSync, assertRunId } from '@rundown-org/core';
import {
  createTestWorkspace,
  parseFinalCliJsonObject,
  parseJsonEvents,
  readRunbookState,
  runCli,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

describe('artifacts channel (integration)', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  function appendManagedManifestRow(contextId: string, key: string) {
    const runId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const uri = `rd://artifacts/${contextId}/${runId}/${key}`;
    appendArtifactManifestRecordSync(
      { cwd: workspace.cwd, workPath: '.rundown/work' },
      {
        uri,
        runId,
        contextId,
        runbook: { source: 'project', path: 'producer.runbook.md' },
        key,
        timestamp: '2026-05-25T00:00:00.000Z',
      },
    );
    return uri;
  }

  /** Count manifest rows across every context's manifest.jsonl in the work dir. */
  async function readManifestRowCount(): Promise<number> {
    const workDir = join(workspace.cwd, '.rundown/work');
    let entries: string[];
    try {
      entries = await readdir(workDir);
    } catch {
      return 0;
    }
    let total = 0;
    for (const entry of entries) {
      if (!entry.startsWith('.rd-')) continue;
      try {
        const content = await readFile(join(workDir, entry, 'manifest.jsonl'), 'utf-8');
        total += content.split('\n').filter((line) => line.trim().length > 0).length;
      } catch {
        // No manifest in this context dir.
      }
    }
    return total;
  }

  async function writeExecutePlanRunbook(): Promise<void> {
    await writeFile(
      join(workspace.cwd, 'execute-plan.runbook.md'),
      `---
artifacts:
  - PlanPath
required:
  - PlanPath
---
# Execute Plan

## 1. Review
- PASS COMPLETE
- FAIL STOP

Plan at {{ path PlanPath }}
`,
    );
  }

  it('rd run --artifacts rehydrates and projects a local path', async () => {
    const uri = appendManagedManifestRow('ctx-a', 'PlanPath');
    // A command block lets us observe the *projected* value in command_started,
    // proving rehydration produced a local work-path — not the rd:// URI verbatim.
    await writeFile(
      join(workspace.cwd, 'execute-plan.runbook.md'),
      `---
artifacts:
  - PlanPath
required:
  - PlanPath
---
# Execute Plan

## 1. Review
- PASS COMPLETE
- FAIL STOP

\`\`\`bash
rd echo plan={{ path PlanPath }}
\`\`\`
`,
    );

    const { stdout, exitCode } = await runCliInProcess(
      ['run', 'execute-plan.runbook.md', '--artifacts', `PlanPath=${uri}`],
      workspace,
    );
    expect(exitCode).toBe(0);

    const events = parseJsonEvents(stdout);
    const commandStarted = events.filter((e) => e.type === 'command_started');
    expect(commandStarted).toHaveLength(1);
    // Projected to a local path under the work dir, ending in the manifest key —
    // and the raw rd:// URI must not survive into the command.
    expect(commandStarted[0].command).toContain('plan=');
    expect(commandStarted[0].command).toContain('PlanPath');
    expect(commandStarted[0].command).not.toContain('rd://');
    // The `{{ path PlanPath }}` expression must have actually been projected:
    // assert no unresolved template braces survive and the command carries the
    // local work-dir path the URI was projected to. Without these, the command
    // could pass the checks above while the template never resolved.
    expect(commandStarted[0].command).not.toContain('{{');
    expect(commandStarted[0].command).toContain('.rundown/work');
  });

  it('rejects a non-rd:// --artifacts value at the boundary', async () => {
    await writeExecutePlanRunbook();
    const { stdout, exitCode } = await runCliInProcess(
      ['run', 'execute-plan.runbook.md', '--prompted', '--artifacts', 'PlanPath=just-a-string'],
      workspace,
    );
    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout).error).toMatch(/Artifact input "PlanPath"/);
  });

  it('is read-only: a successful --artifacts run mints no new manifest rows', async () => {
    const uri = appendManagedManifestRow('ctx-a', 'PlanPath');
    await writeExecutePlanRunbook();
    const before = await readManifestRowCount();

    const { exitCode } = await runCliInProcess(
      ['run', 'execute-plan.runbook.md', '--prompted', '--artifacts', `PlanPath=${uri}`],
      workspace,
    );
    expect(exitCode).toBe(0);
    expect(await readManifestRowCount()).toBe(before); // invariant #3: channel never mints rows
  });

  it('FOR loop over an array of artifacts projects per iteration', async () => {
    const a = appendManagedManifestRow('ctx-a', 'p0'); // rd://artifacts/ctx-a/<run>/p0
    const b = appendManagedManifestRow('ctx-a', 'p1');
    await writeFile(
      join(workspace.cwd, 'fanout.runbook.md'),
      `---
artifacts:
  - Plans
---
# Fan Out

## 1. Process plans
- FOR plan IN {{ Plans }}
- PASS CONTINUE

### 1.1 Handle plan
- PASS CONTINUE

\`\`\`bash
rd echo plan={{ path plan }} index={{ Index }}
\`\`\`
`,
    );

    const { stdout, exitCode } = await runCliInProcess(
      ['run', 'fanout.runbook.md', '--artifacts-json', `Plans=["${a}","${b}"]`],
      workspace,
    );
    expect(exitCode).toBe(0);

    const events = parseJsonEvents(stdout);
    const commandStarted = events.filter((e) => e.type === 'command_started');
    expect(commandStarted).toHaveLength(2);

    const localPathOf = (uri: string) => uri.split('/').pop()!; // p0 / p1 — manifest key segment
    expect(commandStarted[0].command).toContain('plan=');
    expect(commandStarted[0].command).toContain(localPathOf(a));
    expect(commandStarted[0].command).toContain('index=1');
    expect(commandStarted[1].command).toContain(localPathOf(b));
    expect(commandStarted[1].command).toContain('index=2');

    // No unresolved template survives — proves per-iteration projection.
    expect(JSON.stringify(events)).not.toContain('{{');
  });

  // Flag-plumbing smoke test: each command must REGISTER --artifacts (not reject it
  // as an unknown option). Delegation *inheritance* is out of scope, so the assertion
  // is flag acceptance, not artifact propagation. A command may still exit non-zero for
  // unrelated setup reasons, but an "unknown option" error is what registration prevents.
  it.each<[string, string[]]>([
    ['delegate', ['delegate', '--step', '1.1']],
    ['claim', ['claim', '__no_such_token__']],
    ['resolve', ['resolve', 'PlanPath']],
  ])('%s registers --artifacts (parses, not an unknown option)', async (_cmd, baseArgs) => {
    const uri = appendManagedManifestRow('ctx-a', 'PlanPath');
    const { stdout, stderr } = await runCliInProcess(
      [...baseArgs, '--artifacts', `PlanPath=${uri}`],
      workspace,
    );
    expect(`${stdout}\n${stderr}`).not.toMatch(/unknown option.*--artifacts/i);
  });

  it.each<[string, string[]]>([
    ['delegate', ['delegate', '--step', '1.1']],
    ['claim', ['claim', '__no_such_token__']],
    ['resolve', ['resolve', 'PlanPath']],
  ])('%s registers --artifacts-json (parses, not an unknown option)', async (_cmd, baseArgs) => {
    const uri = appendManagedManifestRow('ctx-a', 'PlanPath');
    const { stdout, stderr } = await runCliInProcess(
      [...baseArgs, '--artifacts-json', `PlanPath=["${uri}"]`],
      workspace,
    );
    expect(`${stdout}\n${stderr}`).not.toMatch(/unknown option.*--artifacts-json/i);
  });

  it('rd resolve --artifacts rehydrates and satisfies the required gate', async () => {
    const uri = appendManagedManifestRow('ctx-a', 'PlanPath');
    await writeExecutePlanRunbook(); // declares artifacts: [PlanPath], required: [PlanPath]

    // If --artifacts forwarding were dropped, PlanPath would be unsupplied and the
    // required gate would fail — so a clean resolve proves the flag rehydrated it.
    const { stdout, exitCode } = await runCliInProcess(
      ['resolve', 'execute-plan.runbook.md', '--artifacts', `PlanPath=${uri}`],
      workspace,
    );
    expect(exitCode).toBe(0);
    const resolved = JSON.parse(stdout) as { valid: boolean; unresolved?: string[] };
    expect(resolved.valid).toBe(true);
    expect(resolved.unresolved ?? []).not.toContain('PlanPath');
  });

  it('rd claim --artifacts rehydrates the artifact into the claimed child run state', async () => {
    const uri = appendManagedManifestRow('ctx-a', 'PlanPath');

    // The child does NOT declare PlanPath, so frontmatter auto-resolution cannot
    // bind it — the artifact can only reach the child run state via the claim's
    // --artifacts boundary channel (the channel supplies undeclared names too).
    // This makes the test sensitive to dropping the forwarding.
    await writeFile(
      join(workspace.cwd, 'child.runbook.md'),
      `# Child

## 1. Execute
- PASS COMPLETE
`,
    );
    await writeFile(
      join(workspace.cwd, 'parent.runbook.md'),
      `# Parent

## 1. Review
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Delegate child
- DELEGATE
- child.runbook.md
`,
    );

    let result = runCli('run parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);
    const tokenMatch = /"token":\s*"(rdtk_[^"]+)"/.exec(result.stdout);
    expect(tokenMatch).not.toBeNull();

    result = runCli(`claim ${tokenMatch![1]} --artifacts PlanPath=${uri}`, workspace);
    expect(result.exitCode).toBe(0);
    const claimOutput = parseFinalCliJsonObject(result.stdout) as { run_id: string };

    const childState = await readRunbookState(workspace, claimOutput.run_id);
    expect(childState).not.toBeNull();
    expect(childState!.variables.PlanPath).toMatchObject({ kind: 'artifact-record', uri });
  });
});
