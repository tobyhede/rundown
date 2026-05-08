import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendArtifactManifestRecord,
  manifestPathForContext,
  type ArtifactRecord,
} from '@rundown-org/core';
import type { ResolvedRunbook } from '@rundown-org/parser';
import {
  expandLoopVariablesForCommand,
  substituteRunbookVariables,
  substituteText,
} from '../../src/services/template-renderer.js';

const RUN_ID = 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CONTEXT_ID = 'ctx1';
const WORK_PATH = '.rundown/work';
const RUNBOOK = { source: 'project' as const, path: 'planning/write-plan.runbook.md' };

const PLAN: ArtifactRecord = {
  uri: `rd://artifacts/${CONTEXT_ID}/runs/${RUN_ID}/plan.json`,
  runId: RUN_ID,
  contextId: CONTEXT_ID,
  runbook: RUNBOOK,
  key: 'plan.json',
  timestamp: '2026-05-07T00:00:00.000Z',
};

const REVIEW_A: ArtifactRecord = {
  uri: `rd://artifacts/${CONTEXT_ID}/runs/${RUN_ID}/review-plan-a.json`,
  runId: RUN_ID,
  contextId: CONTEXT_ID,
  runbook: RUNBOOK,
  key: 'review-plan-a.json',
  timestamp: '2026-05-07T00:00:00.000Z',
};

describe('template rendering does not mutate the artifact manifest', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'render-purity-'));
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, PLAN);
    await appendArtifactManifestRecord({ cwd, workPath: WORK_PATH }, REVIEW_A);
  });

  afterEach(async () => {
    await fsp.rm(cwd, { recursive: true, force: true });
  });

  async function readManifestBytes(): Promise<string> {
    const file = manifestPathForContext({ cwd, workPath: WORK_PATH }, CONTEXT_ID);
    return fsp.readFile(file, 'utf8');
  }

  /**
   * Snapshot the recursive directory listing under `<cwd>/<workPath>` so the
   * test catches non-manifest filesystem mutations (e.g. a stray `mkdirSync`
   * or a file write that bypasses the manifest helper). Byte-equal manifest
   * comparison kills "appended row" mutants but misses "created sibling
   * directory" mutants — both are forbidden by spec §313.
   */
  async function snapshotWorkDir(): Promise<readonly string[]> {
    const root = path.join(cwd, WORK_PATH);
    const entries = await fsp.readdir(root, { recursive: true });
    return [...entries].sort();
  }

  it('renders 100 prompt/command substitutions without changing the manifest or work directory', async () => {
    const beforeManifest = await readManifestBytes();
    const beforeDir = await snapshotWorkDir();

    const variables = {
      WorkPath: WORK_PATH,
      ContextId: CONTEXT_ID,
      RunId: RUN_ID,
      PlanPath: PLAN,
      Reviews: [REVIEW_A],
    } as const;

    for (let i = 0; i < 100; i++) {
      substituteText(
        'Plan {{ PlanPath }} at {{ path PlanPath }} record {{ artifact PlanPath }} reviews {{ Reviews }} paths {{ path Reviews }} records {{ artifact Reviews }} literal {{ path "plan.json" }}',
        variables,
        undefined,
        { cwd },
      );
      expandLoopVariablesForCommand(
        'echo {{ PlanPath }} {{ path PlanPath }} {{ Reviews }} {{ path "plan.json" }}',
        variables,
        { cwd },
      );
    }

    expect(await readManifestBytes()).toBe(beforeManifest);
    expect(await snapshotWorkDir()).toEqual(beforeDir);
  });

  it('renders empty wildcards across forms without changing the manifest or work directory', async () => {
    const beforeManifest = await readManifestBytes();
    const beforeDir = await snapshotWorkDir();

    const variables = {
      WorkPath: WORK_PATH,
      ContextId: CONTEXT_ID,
      RunId: RUN_ID,
      Reviews: [],
    } as const;

    for (let i = 0; i < 50; i++) {
      substituteText(
        '{{ Reviews }} | {{ path Reviews }} | {{ artifact Reviews }}',
        variables,
        undefined,
        { cwd },
      );
    }

    expect(await readManifestBytes()).toBe(beforeManifest);
    expect(await snapshotWorkDir()).toEqual(beforeDir);
  });

  it('substituteRunbookVariables preserves manifest and work-dir contents across whole-runbook renders', async () => {
    const beforeManifest = await readManifestBytes();
    const beforeDir = await snapshotWorkDir();
    // ResolvedRunbook = Omit<Runbook, 'steps'> & { steps: ResolvedStep[] }.
    // It does NOT carry `frontmatter` or `sourcePath` — those live on
    // `ParseResult` and are stripped before resolution. Use only `Runbook`
    // fields (`name`, `title`, `description`, `version`, `author`, `tags`)
    // plus `steps`.
    const runbook: ResolvedRunbook = {
      name: 'render-purity-test',
      title: '{{ PlanPath }}',
      description: 'Render plan {{ path PlanPath }} reviews {{ Reviews }}',
      steps: [],
    };
    const variables = {
      WorkPath: WORK_PATH,
      ContextId: CONTEXT_ID,
      RunId: RUN_ID,
      PlanPath: PLAN,
      Reviews: [REVIEW_A],
    } as const;

    for (let i = 0; i < 25; i++) {
      substituteRunbookVariables(runbook, variables, { cwd });
    }

    expect(await readManifestBytes()).toBe(beforeManifest);
    expect(await snapshotWorkDir()).toEqual(beforeDir);
  });

  it('rendered command output is identical across repeated renders (byte-equal)', () => {
    const variables = {
      WorkPath: WORK_PATH,
      ContextId: CONTEXT_ID,
      RunId: RUN_ID,
      PlanPath: PLAN,
      Reviews: [REVIEW_A],
    } as const;

    const first = expandLoopVariablesForCommand(
      'cat {{ path PlanPath }}; jq . {{ path Reviews }}; echo {{ artifact PlanPath }}',
      variables,
      { cwd },
    );
    const second = expandLoopVariablesForCommand(
      'cat {{ path PlanPath }}; jq . {{ path Reviews }}; echo {{ artifact PlanPath }}',
      variables,
      { cwd },
    );
    expect(second).toBe(first);
  });
});
