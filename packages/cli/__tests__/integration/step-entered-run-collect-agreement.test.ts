import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  findActionOutput,
  parseConcatenatedJson,
  requireFrontierToken,
  runCliInProcess,
  withRunTarget,
  type TestWorkspace,
} from '../helpers/test-utils.js';

/**
 * `rundown run` and `rundown collect` emit the SAME `STEP_ENTERED` for the same
 * execution unit (#816 characterised the divergence; #820 closed it).
 *
 * Two functions used to build the `StepEntryMetadata` behind this payload and
 * they disagreed: the CLI execution loop rendered `description`, `prompt`,
 * `commandCode` and `commandLang`; core's collection service filled ids,
 * position, name and flags and left every rendered field absent. All four are
 * optional on the type, which is what let the disagreement compile.
 *
 * There is one builder now — the core entry seam both paths enter through — so
 * this file's job flipped from pinning the gap to pinning its absence. The
 * assertion is still end to end, on ONE substep of ONE runbook entered twice:
 * first by `rundown run`, then by the RETRY re-entry that `rundown collect`
 * drives. That is the level at which an orchestrator observes it, and it is the
 * only level at which "the same unit, entered two ways" is a statement about the
 * product rather than about a function.
 */
describe('STEP_ENTERED agreement between run and collect (#816 / #820)', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /** The H3 title of substep 1.1, which the parser stores as its description. */
  const SUBSTEP_DESCRIPTION = 'Task A';
  /** The prose under substep 1.1, which the parser stores as its prompt. */
  const SUBSTEP_PROMPT = 'Describe task A in prose.';

  /**
   * Every `step_entered` event in a command's stdout, in emission order.
   *
   * Events arrive as concatenated JSON, sometimes nested inside arrays, so the
   * flatten is not optional.
   *
   * @param stdout - Raw stdout from one CLI invocation.
   * @returns The `step_entered` payloads that invocation emitted.
   */
  function stepEnteredEvents(stdout: string): Record<string, unknown>[] {
    const flat: Record<string, unknown>[] = [];
    const walk = (nodes: unknown[]): void => {
      for (const node of nodes) {
        if (Array.isArray(node)) walk(node);
        else if (node && typeof node === 'object') flat.push(node as Record<string, unknown>);
      }
    };
    walk(parseConcatenatedJson(stdout));
    return flat.filter((event) => event.type === 'step_entered');
  }

  /**
   * A parent whose substeps both DELEGATE, aggregating `FAIL ANY RETRY 1 STOP`.
   *
   * The RETRY is what makes the SAME substep reachable from both paths: the
   * first entry is `rundown run`'s, and the re-entry the retry produces is
   * projected by `rundown collect` through core's re-entry frontier seam.
   */
  async function writeRunbooks(): Promise<void> {
    const passChild = [
      '# Child Pass',
      '',
      '## 1. Do work',
      '',
      '- PASS COMPLETE',
      '- FAIL STOP',
      '',
      '```bash',
      'rd echo --result pass',
      '```',
      '',
    ].join('\n');
    const failChild = [
      '# Child Fail',
      '',
      '## 1. Do work',
      '',
      '- PASS COMPLETE',
      '- FAIL STOP',
      '',
      '```bash',
      'rd echo --result fail',
      '```',
      '',
    ].join('\n');
    const parent = [
      '# Parent',
      '',
      '## 1. Fan-out',
      '',
      '- DELEGATE',
      '- PASS ALL CONTINUE',
      '- FAIL ANY RETRY 1 STOP',
      '',
      `### 1.1 ${SUBSTEP_DESCRIPTION}`,
      '',
      SUBSTEP_PROMPT,
      '',
      '- child.runbook.md',
      '',
      '### 1.2 Task B',
      '',
      '- child-fail.runbook.md',
      '',
      '## 2. Done',
      '',
      '- PASS COMPLETE',
      '- FAIL STOP',
      '',
      'Finished.',
      '',
    ].join('\n');

    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), passChild);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), passChild);
    await writeFile(join(workspace.cwd, 'runbooks', 'child-fail.runbook.md'), failChild);
    await writeFile(join(workspace.runbooksDir(), 'child-fail.runbook.md'), failChild);
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parent);
  }

  /** Claim a delegated substep's token and report its result under that bearer. */
  async function reportUnder(token: string, result: 'pass' | 'fail'): Promise<void> {
    const claim = await runCliInProcess(`claim ${token}`, workspace);
    expect(claim.exitCode).toBe(0);
    const claimId = String(findActionOutput(claim.stdout)!.claim_id);
    await runCliInProcess([result, '--claim-id', claimId], workspace);
  }

  it('renders the same description and prompt whichever command entered the substep', async () => {
    await writeRunbooks();

    // ---- Path 1: `rundown run` enters substep 1.1 for the first time. -------
    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const runEntries = stepEnteredEvents(start.stdout);
    expect(runEntries).toHaveLength(1);
    const runEntry = runEntries[0];

    // The loop's builder renders both fields off the resolved substep.
    expect(runEntry.description).toBe(SUBSTEP_DESCRIPTION);
    expect(runEntry.prompt).toBe(SUBSTEP_PROMPT);

    // ---- Drive the aggregation to RETRY so collect re-enters 1.1. ----------
    await reportUnder(requireFrontierToken(start.stdout, '1.1'), 'pass');
    await reportUnder(requireFrontierToken(start.stdout, '1.2'), 'fail');

    // ---- Path 2: `rundown collect` re-enters the SAME substep. -------------
    const collected = await runCliInProcess(await withRunTarget(['collect'], workspace), workspace);
    expect(collected.exitCode).toBe(0);
    const collectEntries = stepEnteredEvents(collected.stdout);
    expect(collectEntries).toHaveLength(1);
    const collectEntry = collectEntries[0];

    // THE FLIP. Both of these were `toBeUndefined()` before #820: same substep,
    // same runbook, same cursor, and core's builder carried neither rendered
    // field.
    expect(collectEntry.description).toBe(SUBSTEP_DESCRIPTION);
    expect(collectEntry.prompt).toBe(SUBSTEP_PROMPT);

    // ...and everything else agrees too, which is what makes the two payloads
    // comparable at all. Asserted field by field rather than by diffing the
    // objects, because the frontier tokens are freshly minted on re-entry (that
    // is the RETRY working) and the envelope carries a `seq`.
    expect(collectEntry.position).toEqual(runEntry.position);
    expect(collectEntry.stepName).toBe(runEntry.stepName);
    expect(collectEntry.isSubstep).toBe(runEntry.isSubstep);
    expect(collectEntry.prompted).toBe(runEntry.prompted);
    expect(collectEntry.hasCommand).toBe(runEntry.hasCommand);
    expect(collectEntry.runbookId).toBe(runEntry.runbookId);
    // Both entries are the delegating substep, not the parent step.
    expect(collectEntry.isSubstep).toBe(true);
    expect(collectEntry.position).toMatchObject({ current: '1', substep: '1' });
  }, 30_000);
});
