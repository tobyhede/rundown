import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  appendArtifactManifestRecord,
  ArtifactRecordSchema,
  assertRunId,
  manifestPathForContext,
  type ArtifactRecord,
  expandLoopVariablesForCommand,
  resolveForBounds,
  substituteRunbookVariables,
  substituteText,
  type TemplateRenderOptions,
} from '../../src/runbook/index.js';
import type {
  ArtifactDeclaration,
  ParsedSubstep,
  ResolvedRunbook,
  ResolvedStep,
  Runbook,
  StepWithSubsteps,
  Substep,
  Transitions,
} from '@rundown-org/parser';
const RUN_ID = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const CONTEXT_ID = 'ctx1';
const WORK_PATH = '.rundown/work';
const RUNBOOK = { source: 'project' as const, path: 'planning/write-plan.runbook.md' };

function renderOptions(cwd: string): TemplateRenderOptions {
  return {
    context: {
      kind: 'runnable',
      cwd,
      workPath: WORK_PATH,
      contextId: CONTEXT_ID,
      runId: RUN_ID,
    },
  };
}

const PLAN: ArtifactRecord = {
  kind: 'artifact-record',
  uri: `rd://artifacts/${CONTEXT_ID}/${RUN_ID}/plan.json`,
  runId: RUN_ID,
  contextId: CONTEXT_ID,
  runbook: RUNBOOK,
  key: 'plan.json',
  timestamp: '2026-05-07T00:00:00.000Z',
};

const REVIEW_A: ArtifactRecord = {
  kind: 'artifact-record',
  uri: `rd://artifacts/${CONTEXT_ID}/${RUN_ID}/review-plan-a.json`,
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

    // Sample render once to assert rendering actually happened — kills mutants
    // that return '' (or any stable string) for everything while still passing
    // the manifest/dir purity snapshots below.
    const sampleSubstitute = substituteText(
      'Plan {{ PlanPath }}',
      variables,
      undefined,
      renderOptions(cwd),
    );
    expect(sampleSubstitute).toBe(`Plan ${PLAN.uri}`);
    const sampleCommand = expandLoopVariablesForCommand(
      'cat {{ path PlanPath }}',
      variables,
      renderOptions(cwd),
    );
    expect(sampleCommand).toContain(`.rd-${CONTEXT_ID}`);
    expect(sampleCommand.endsWith('plan.json')).toBe(true);

    for (let i = 0; i < 100; i++) {
      substituteText(
        'Plan {{ PlanPath }} at {{ path PlanPath }} record {{ artifact PlanPath }} reviews {{ Reviews }} paths {{ path Reviews }} records {{ artifact Reviews }} literal {{ path "plan.json" }}',
        variables,
        undefined,
        renderOptions(cwd),
      );
      expandLoopVariablesForCommand(
        'echo {{ PlanPath }} {{ path PlanPath }} {{ Reviews }} {{ path "plan.json" }}',
        variables,
        renderOptions(cwd),
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

    // Sample once to assert each helper form renders an empty array as '[]'.
    const sampleEmpty = substituteText(
      '{{ Reviews }} | {{ path Reviews }} | {{ artifact Reviews }}',
      variables,
      undefined,
      renderOptions(cwd),
    );
    expect(sampleEmpty).toBe('[] | [] | []');

    for (let i = 0; i < 50; i++) {
      substituteText(
        '{{ Reviews }} | {{ path Reviews }} | {{ artifact Reviews }}',
        variables,
        undefined,
        renderOptions(cwd),
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
      substituteRunbookVariables(runbook, variables, renderOptions(cwd));
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
      renderOptions(cwd),
    );
    const second = expandLoopVariablesForCommand(
      'cat {{ path PlanPath }}; jq . {{ path Reviews }}; echo {{ artifact PlanPath }}',
      variables,
      renderOptions(cwd),
    );
    expect(second).toBe(first);
  });

  it('projects managed artifact paths from record URI identity', () => {
    const producerContextId = 'producer-context';
    const importedPlan: ArtifactRecord = {
      ...PLAN,
      contextId: producerContextId,
      uri: `rd://artifacts/${producerContextId}/${RUN_ID}/plan.json`,
    };

    const rendered = substituteText(
      '{{ Plan }} | {{ path Plan }}',
      {
        WorkPath: WORK_PATH,
        Plan: importedPlan,
      },
      undefined,
      renderOptions(cwd),
    );

    expect(rendered).toBe(
      `${importedPlan.uri} | ${path.join(cwd, WORK_PATH, `.rd-${producerContextId}`, RUN_ID, 'plan.json')}`,
    );
  });

  it('projects file artifact paths from file URI records', async () => {
    const schemaPath = path.join(cwd, 'review.schema.json');
    await fsp.writeFile(schemaPath, '{}');
    const canonicalSchemaPath = await fsp.realpath(schemaPath);
    const schemaArtifact = ArtifactRecordSchema.parse({
      kind: 'file-artifact-record',
      uri: pathToFileURL(canonicalSchemaPath).href,
      runId: RUN_ID,
      contextId: CONTEXT_ID,
      runbook: RUNBOOK,
      key: path.basename(canonicalSchemaPath),
      timestamp: '2026-05-07T00:00:00.000Z',
    });

    const rendered = substituteText(
      '{{ Schema }} | {{ path Schema }}',
      {
        WorkPath: WORK_PATH,
        Schema: schemaArtifact,
      },
      undefined,
      renderOptions(cwd),
    );

    expect(rendered).toBe(`${schemaArtifact.uri} | ${canonicalSchemaPath}`);
  });

  it('renders literal {{ path "key" }} in prepared context without a runId segment', () => {
    const text = '{{ path "plan.json" }}';
    const result = substituteText(text, {}, undefined, {
      context: {
        kind: 'prepared',
        cwd,
        workPath: WORK_PATH,
        contextId: CONTEXT_ID,
      },
    });
    expect(result).toBe(path.join(cwd, WORK_PATH, `.rd-${CONTEXT_ID}`, 'plan.json'));
  });
});

/**
 * Per language.md §10.1.1, the quoted token in an `ARTIFACTS` declaration is
 * template-expanded before parsing. These tests pin that the renderer walks
 * `step.artifacts[].rawToken` and substitutes built-ins (`{{ContextId}}`,
 * `{{RunId}}`) and user variables before the resolver sees the value.
 */
describe('substituteRunbookVariables expands ARTIFACTS rawToken', () => {
  /** Minimal default transitions matching the parser's defaults. */
  const DEFAULT_TRANSITIONS: Transitions = {
    pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
    fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
  };

  /** Build a base ResolvedStep with the given artifacts list. */
  function makeStep(artifacts: readonly ArtifactDeclaration[] | undefined): ResolvedStep {
    return {
      kind: 'base',
      name: '1',
      description: 'A step',
      transitions: DEFAULT_TRANSITIONS,
      artifacts,
    } satisfies Extract<ResolvedStep, { kind: 'base' }>;
  }

  /** Wrap a step in a minimal ResolvedRunbook so we can call substituteRunbookVariables. */
  function makeRunbook(step: ResolvedStep): ResolvedRunbook {
    return { name: 'rb', steps: [step] };
  }

  it('expands {{ContextId}} and {{RunId}} inside rawToken', () => {
    const decl: ArtifactDeclaration = {
      name: 'Plan',
      rawToken: 'rd://artifacts/{{ContextId}}/{{RunId}}/plan.json',
    };
    const result = substituteRunbookVariables(makeRunbook(makeStep([decl])), {
      ContextId: 'ctx1',
      RunId: 'rd_0123456789abcdef0123456789abcdef',
    });
    expect(result.steps[0].artifacts).toEqual([
      {
        name: 'Plan',
        rawToken: 'rd://artifacts/ctx1/rd_0123456789abcdef0123456789abcdef/plan.json',
      },
    ]);
  });

  it('expands a user variable inside rawToken', () => {
    const decl: ArtifactDeclaration = {
      name: 'Tagged',
      rawToken: 'review-{{Tag}}.json',
    };
    const result = substituteRunbookVariables(makeRunbook(makeStep([decl])), { Tag: 'risk' });
    expect(result.steps[0].artifacts?.[0].rawToken).toBe('review-risk.json');
  });

  it('expands a mixed URI rawToken with built-ins and a user variable', () => {
    const decl: ArtifactDeclaration = {
      name: 'Reviews',
      rawToken: 'rd://artifacts/{{ContextId}}/*/{{Tag}}.json',
    };
    const result = substituteRunbookVariables(makeRunbook(makeStep([decl])), {
      ContextId: 'ctx1',
      Tag: 'review-plan',
    });
    expect(result.steps[0].artifacts?.[0].rawToken).toBe('rd://artifacts/ctx1/*/review-plan.json');
  });

  it('round-trips a rawToken with no template placeholders unchanged (value-equal)', () => {
    const decl: ArtifactDeclaration = {
      name: 'Plan',
      rawToken: 'plan.json',
    };
    const result = substituteRunbookVariables(makeRunbook(makeStep([decl])), {});
    expect(result.steps[0].artifacts?.[0]).toEqual({
      name: 'Plan',
      rawToken: 'plan.json',
    });
  });

  it('round-trips a naked declaration (rawToken: null) unchanged', () => {
    const decl: ArtifactDeclaration = {
      name: 'Plan',
      rawToken: null,
    };
    const result = substituteRunbookVariables(makeRunbook(makeStep([decl])), {
      ContextId: 'ctx1',
    });
    // Naked form has nothing to expand — the declaration must round-trip
    // identically (same shape and same null token).
    expect(result.steps[0].artifacts?.[0]).toEqual({
      name: 'Plan',
      rawToken: null,
    });
  });

  it('treats an empty artifacts array as a no-op', () => {
    const result = substituteRunbookVariables(makeRunbook(makeStep([])), { ContextId: 'ctx1' });
    expect(result.steps[0].artifacts).toEqual([]);
  });

  it('treats undefined artifacts as a no-op', () => {
    const result = substituteRunbookVariables(makeRunbook(makeStep(undefined)), {
      ContextId: 'ctx1',
    });
    expect(result.steps[0].artifacts).toBeUndefined();
  });

  // The substituteArtifacts docstring promises identity-preservation when no
  // declaration's rawToken would change. Pin that contract so the helper
  // doesn't silently start re-allocating on no-op runs.
  it('preserves the original artifacts array reference when no rawToken changes', () => {
    const original: readonly ArtifactDeclaration[] = [
      { name: 'Plan', rawToken: 'plan.json' },
      { name: 'Asserted', rawToken: null },
    ];
    const result = substituteRunbookVariables(makeRunbook(makeStep(original)), {
      Tag: 'unused',
    });
    expect(result.steps[0].artifacts).toBe(original);
  });

  it('preserves the original artifacts array reference when every declaration is naked', () => {
    const original: readonly ArtifactDeclaration[] = [
      { name: 'Plan', rawToken: null },
      { name: 'Reviews', rawToken: null },
    ];
    const result = substituteRunbookVariables(makeRunbook(makeStep(original)), {
      ContextId: 'ctx1',
    });
    expect(result.steps[0].artifacts).toBe(original);
  });

  it('preserves declaration identity for unchanged entries when only some entries expand', () => {
    const stable: ArtifactDeclaration = { name: 'Plan', rawToken: 'plan.json' };
    const naked: ArtifactDeclaration = { name: 'Asserted', rawToken: null };
    const expanding: ArtifactDeclaration = { name: 'Tagged', rawToken: 'review-{{Tag}}.json' };
    const original: readonly ArtifactDeclaration[] = [stable, naked, expanding];

    const result = substituteRunbookVariables(makeRunbook(makeStep(original)), { Tag: 'risk' });
    const out = result.steps[0].artifacts;

    // The array reference must change because at least one entry expanded.
    expect(out).not.toBe(original);
    // Unchanged entries keep their original object identity.
    expect(out?.[0]).toBe(stable);
    expect(out?.[1]).toBe(naked);
    // Expanded entry is a new object with the substituted rawToken.
    expect(out?.[2]).not.toBe(expanding);
    expect(out?.[2].rawToken).toBe('review-risk.json');
  });

  it('produces a NEW step object — does not mutate the original', () => {
    const original = makeStep([{ name: 'Plan', rawToken: 'plan-{{Tag}}.json' }]);
    const runbook = makeRunbook(original);
    const result = substituteRunbookVariables(runbook, { Tag: 'a' });

    expect(result.steps[0]).not.toBe(original);
    // Original declaration is not mutated.
    expect(original.artifacts?.[0].rawToken).toBe('plan-{{Tag}}.json');
    // Substituted declaration carries the expanded value.
    expect(result.steps[0].artifacts?.[0].rawToken).toBe('plan-a.json');
  });

  it('expands rawToken on substep ARTIFACTS as well as step-level ARTIFACTS', () => {
    const substepDecl: ArtifactDeclaration = {
      name: 'Inner',
      rawToken: 'rd://artifacts/{{ContextId}}/*/inner.json',
    };
    const substep: Substep = {
      id: '1',
      description: 'sub',
      transitions: DEFAULT_TRANSITIONS,
      artifacts: [substepDecl],
    };
    const step: ResolvedStep = {
      kind: 'substeps',
      name: '1',
      description: 'parent',
      transitions: DEFAULT_TRANSITIONS,
      substeps: [substep],
    };
    const result = substituteRunbookVariables({ name: 'rb', steps: [step] }, { ContextId: 'ctx1' });
    const resolvedSubstep = (result.steps[0] as Extract<ResolvedStep, { kind: 'substeps' }>)
      .substeps[0];
    expect(resolvedSubstep.artifacts?.[0].rawToken).toBe('rd://artifacts/ctx1/*/inner.json');
  });
});

describe('resolveForBounds preserves substep ARTIFACTS', () => {
  const DEFAULT_TRANSITIONS: Transitions = {
    pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
    fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
  };

  it('passes substep.artifacts through ParsedSubstep -> Substep resolution', () => {
    const decl: ArtifactDeclaration = {
      name: 'Plan',
      rawToken: 'rd://artifacts/{{ContextId}}/{{RunId}}/plan.json',
    };
    const parsedSubstep: ParsedSubstep = {
      id: '1',
      description: 'sub',
      transitions: DEFAULT_TRANSITIONS,
      artifacts: [decl],
    };
    const step: StepWithSubsteps = {
      kind: 'substeps',
      name: '1',
      description: 'parent',
      transitions: DEFAULT_TRANSITIONS,
      substeps: [parsedSubstep],
    };
    const runbook: Runbook = { name: 'rb', steps: [step] };

    const { runbook: resolved } = resolveForBounds(runbook, {});

    const resolvedSubstep = (resolved.steps[0] as Extract<ResolvedStep, { kind: 'substeps' }>)
      .substeps[0];
    expect(resolvedSubstep.artifacts).toEqual([decl]);
  });
});

describe('substituteRunbookVariables preserves FOR-scoped placeholders in substep ARTIFACTS', () => {
  const DEFAULT_TRANSITIONS: Transitions = {
    pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
    fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
  };

  // Outer-scope `item` collides with the FOR loop variable name. Without
  // FOR-scope filtering, substituteText would resolve `{{ item }}` against this
  // outer value at substitution time and freeze the wrong rawToken before
  // iteration ever starts.
  it('does not bind {{ item }} from outer scope into a FOR substep rawToken', () => {
    const substepDecl: ArtifactDeclaration = {
      name: 'Plan',
      rawToken: 'rd://artifacts/{{ContextId}}/{{RunId}}/{{ item }}.json',
    };
    const substep: Substep = {
      id: '1',
      description: 'sub',
      transitions: DEFAULT_TRANSITIONS,
      artifacts: [substepDecl],
    };
    const forStep: ResolvedStep = {
      kind: 'for',
      name: '1',
      description: 'loop',
      transitions: DEFAULT_TRANSITIONS,
      forClause: { variable: 'item', start: 1, end: 3 },
      substeps: [substep],
    };

    const result = substituteRunbookVariables(
      { name: 'rb', steps: [forStep] },
      { ContextId: 'ctx1', RunId: 'rd_0123456789abcdef0123456789abcdef', item: 'OUTER' },
    );

    const resolvedSubstep = (result.steps[0] as Extract<ResolvedStep, { kind: 'for' }>).substeps[0];
    expect(resolvedSubstep.artifacts?.[0].rawToken).toBe(
      'rd://artifacts/ctx1/rd_0123456789abcdef0123456789abcdef/{{ item }}.json',
    );
  });

  it('does not bind {{ item.path }} from outer scope into a FOR substep rawToken', () => {
    const substepDecl: ArtifactDeclaration = {
      name: 'Plan',
      rawToken: 'rd://artifacts/{{ContextId}}/{{RunId}}/{{ item.path }}',
    };
    const substep: Substep = {
      id: '1',
      description: 'sub',
      transitions: DEFAULT_TRANSITIONS,
      artifacts: [substepDecl],
    };
    const forStep: ResolvedStep = {
      kind: 'for',
      name: '1',
      description: 'loop',
      transitions: DEFAULT_TRANSITIONS,
      forClause: { variable: 'item', start: 1, end: 3 },
      substeps: [substep],
    };

    const result = substituteRunbookVariables(
      { name: 'rb', steps: [forStep] },
      {
        ContextId: 'ctx1',
        RunId: 'rd_0123456789abcdef0123456789abcdef',
        item: { path: 'OUTER.json' },
      },
    );

    const resolvedSubstep = (result.steps[0] as Extract<ResolvedStep, { kind: 'for' }>).substeps[0];
    expect(resolvedSubstep.artifacts?.[0].rawToken).toBe(
      'rd://artifacts/ctx1/rd_0123456789abcdef0123456789abcdef/{{ item.path }}',
    );
  });

  // Loop-index placeholders are populated per-iteration at execution time
  // (execution.ts builds `Index`/`context.current.index` from the active FOR
  // frame). If they leak into the initial substitution frame via inheritance
  // or any future plumbing, they must still survive substituteArtifacts so
  // the runtime can resolve them per-iteration.
  it('preserves Index / index / context.current.index placeholders in FOR substep ARTIFACTS', () => {
    const substepDecl: ArtifactDeclaration = {
      name: 'Iter',
      rawToken:
        'rd://artifacts/{{ContextId}}/{{RunId}}/iter-{{index}}-{{Index}}-{{context.current.index}}.json',
    };
    const substep: Substep = {
      id: '1',
      description: 'sub',
      transitions: DEFAULT_TRANSITIONS,
      artifacts: [substepDecl],
    };
    const forStep: ResolvedStep = {
      kind: 'for',
      name: '1',
      description: 'loop',
      transitions: DEFAULT_TRANSITIONS,
      forClause: { variable: 'item', start: 1, end: 3 },
      substeps: [substep],
    };

    const result = substituteRunbookVariables(
      { name: 'rb', steps: [forStep] },
      {
        ContextId: 'ctx1',
        RunId: 'rd_0123456789abcdef0123456789abcdef',
        index: 'OUTER_idx',
        Index: 'OUTER_Idx',
        'context.current.index': 'OUTER_ccx',
      },
    );

    const resolvedSubstep = (result.steps[0] as Extract<ResolvedStep, { kind: 'for' }>).substeps[0];
    expect(resolvedSubstep.artifacts?.[0].rawToken).toBe(
      'rd://artifacts/ctx1/rd_0123456789abcdef0123456789abcdef/iter-{{index}}-{{Index}}-{{context.current.index}}.json',
    );
  });

  it('still expands non-FOR-scoped variables in a FOR substep rawToken', () => {
    const substepDecl: ArtifactDeclaration = {
      name: 'Tagged',
      rawToken: 'rd://artifacts/{{ContextId}}/*/{{Tag}}-{{ item }}.json',
    };
    const substep: Substep = {
      id: '1',
      description: 'sub',
      transitions: DEFAULT_TRANSITIONS,
      artifacts: [substepDecl],
    };
    const forStep: ResolvedStep = {
      kind: 'for',
      name: '1',
      description: 'loop',
      transitions: DEFAULT_TRANSITIONS,
      forClause: { variable: 'item', start: 1, end: 3 },
      substeps: [substep],
    };

    const result = substituteRunbookVariables(
      { name: 'rb', steps: [forStep] },
      { ContextId: 'ctx1', Tag: 'review' },
    );

    const resolvedSubstep = (result.steps[0] as Extract<ResolvedStep, { kind: 'for' }>).substeps[0];
    expect(resolvedSubstep.artifacts?.[0].rawToken).toBe(
      'rd://artifacts/ctx1/*/review-{{ item }}.json',
    );
  });
});
