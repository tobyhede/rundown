import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILTIN_TEMPLATE_HELPER_NAME_SET } from '@rundown-org/parser';
import { parseRunbookDocument } from '@rundown-org/parser';
import {
  ArtifactChannelError,
  BUILTIN_RENDER_HELPERS,
  type FileSourcePolicyError,
  RESERVED_TEMPLATE_HELPER_NAMES,
  assertRunId,
  ArtifactRecordSchema,
  createBuiltinVariables,
  detectTemplateHelperCollisions,
  isBuiltinRenderHelper,
  isJsonArrayStream,
  isValidVariableName,
  partitionVariables,
  prepareParsedRunbook,
  resolveTemplateHelperCall,
  resolveVariableLayers,
  type ArtifactRecord,
  type PrepareParsedRunbookInput,
  type VariableLayer,
} from '../../src/runbook/index.js';
import type { PolicyEvaluator, PolicyPrompter } from '../../src/policy/index.js';
import {
  parseJsonArtifactUriArrayTransport,
  readExactArtifactRecordArrayFromManifest,
} from '../../src/runbook/artifact-inputs.js';
import { appendArtifactManifestRecordSync } from '../../src/runbook/artifact-manifest.js';
import {
  isTrustedArtifactArray,
  isTrustedArtifactRecord,
} from '../../src/runbook/effective-vars.js';
import {
  brandTrustedArtifactArrayForTest,
  brandTrustedArtifactRecordForTest,
} from '../../src/testing/effective-vars.js';

describe('template helper semantics', () => {
  it('reserves artifact-producing built-in helper names', () => {
    expect(RESERVED_TEMPLATE_HELPER_NAMES.has('path')).toBe(true);
    expect(RESERVED_TEMPLATE_HELPER_NAMES.has('artifact')).toBe(true);
    expect(RESERVED_TEMPLATE_HELPER_NAMES.has('validateSchema')).toBe(true);
  });

  it('aliases reserved template helper names to the parser-owned helper set', () => {
    expect(RESERVED_TEMPLATE_HELPER_NAMES).toBe(BUILTIN_TEMPLATE_HELPER_NAME_SET);
    expect([...RESERVED_TEMPLATE_HELPER_NAMES].sort()).toEqual([
      'artifact',
      'path',
      'validateSchema',
    ]);
    expect([...BUILTIN_RENDER_HELPERS].sort()).toEqual(['artifact', 'path', 'validateSchema']);
  });

  it('isBuiltinRenderHelper recognizes exactly the built-in render helpers', () => {
    expect(isBuiltinRenderHelper('artifact')).toBe(true);
    expect(isBuiltinRenderHelper('path')).toBe(true);
    expect(isBuiltinRenderHelper('validateSchema')).toBe(true);
    expect(isBuiltinRenderHelper('upper')).toBe(false);
  });

  it('resolveTemplateHelperCall returns the original for any name absent from the user registry', () => {
    const registry = new Map<string, (value: string) => string>([
      ['upper', (value) => value.toUpperCase()],
    ]);
    // Built-in names are never registered as user helpers (reserved at load
    // time) and are dispatched by the typed registry in substituteText, not
    // here — so this user-helper resolver simply misses and preserves them.
    for (const name of BUILTIN_RENDER_HELPERS) {
      expect(resolveTemplateHelperCall(registry, name, 'arg', `{{ ${name} arg }}`)).toBe(
        `{{ ${name} arg }}`,
      );
    }
    // Genuine user helpers still resolve.
    expect(resolveTemplateHelperCall(registry, 'upper', 'arg', '{{ upper arg }}')).toBe('ARG');
  });

  it('detects user variable names shadowed by registered helpers', () => {
    const registry = new Map<string, (value: string) => string>([
      ['upper', (value) => value.toUpperCase()],
      ['slug', (value) => value.toLowerCase()],
    ]);

    expect(detectTemplateHelperCollisions(registry, { upper: 'value', env: 'prod' })).toEqual([
      'upper',
    ]);
  });
});

describe('parsed runbook preparation', () => {
  function parse(markdown: string) {
    const parsed = parseRunbookDocument(markdown, 'workflow.runbook.md');
    return parsed;
  }

  it('injects RunbookRef for prepared runbooks and RunId for runnable runbooks', () => {
    const parsed = parse('# Workflow\n\n## 1. Start\nHello {{RunbookRef.path}} {{RunId}}');
    const base: Omit<PrepareParsedRunbookInput, 'identity'> = {
      rawRunbook: parsed.runbook,
      frontmatter: parsed.frontmatter,
      diagnostics: parsed.diagnostics,
      cwd: '/tmp/project',
      templateVars: { env: 'prod', ContextId: 'ctx1', WorkPath: '.rundown/work' },
      providedKeys: new Set(['env']),
      runbookRef: { source: 'project', path: 'workflow.runbook.md' },
      helperRegistry: new Map(),
    };

    const prepared = prepareParsedRunbook({ ...base, identity: { kind: 'prepared' } });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.templateVars.RunbookRef).toEqual({
        source: 'project',
        path: 'workflow.runbook.md',
      });
      expect(prepared.templateVars).not.toHaveProperty('RunId');
    }

    const runnable = prepareParsedRunbook({
      ...base,
      identity: { kind: 'runnable', runId: assertRunId('rd_0123456789abcdef0123456789abcdef') },
    });
    expect(runnable.ok).toBe(true);
    if (runnable.ok) {
      expect(runnable.templateVars.RunId).toBe('rd_0123456789abcdef0123456789abcdef');
    }
  });

  it('validates required inputs against externally provided keys', () => {
    const parsed = parse(
      '---\ninputs:\n  - env\nrequired:\n  - env\n---\n# Workflow\n\n## 1. Start\n{{env}}',
    );

    const result = prepareParsedRunbook({
      rawRunbook: parsed.runbook,
      frontmatter: parsed.frontmatter,
      diagnostics: parsed.diagnostics,
      cwd: '/tmp/project',
      templateVars: { env: 'builtin-default', ContextId: 'ctx1', WorkPath: '.rundown/work' },
      providedKeys: new Set(),
      runbookRef: { source: 'project', path: 'workflow.runbook.md' },
      helperRegistry: new Map(),
      identity: { kind: 'prepared' },
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'MISSING_REQUIRED_VARS',
      error:
        'Missing required variable: "env". Provide via --input, --input-file, config.yaml, RD_INPUT_* environment variable, or prior runbook OUTPUTS.',
    });
  });

  it('reports MISSING_REQUIRED_VARS for an unsupplied required artifact', () => {
    const parsed = parse(
      '---\nartifacts:\n  - PlanPath\nrequired:\n  - PlanPath\n---\n# Workflow\n\n## 1. Start\n{{PlanPath}}',
    );

    const result = prepareParsedRunbook({
      rawRunbook: parsed.runbook,
      frontmatter: parsed.frontmatter,
      diagnostics: parsed.diagnostics,
      cwd: '/tmp/project',
      templateVars: { ContextId: 'ctx1', WorkPath: '.rundown/work' },
      providedKeys: new Set<string>(), // nothing supplied
      runbookRef: { source: 'project', path: 'workflow.runbook.md' },
      helperRegistry: new Map(),
      identity: { kind: 'prepared' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('MISSING_REQUIRED_VARS');
      // Artifact-declared required names must point at the artifact-channel flags,
      // not only the variable-channel providers.
      expect(result.error).toContain('--artifacts');
      expect(result.error).toContain('--artifacts-json');
    }
  });

  it('surfaces an inherited loop variable declared via artifacts through the caller seam', () => {
    // Single-namespace invariant: a delegating parent's FOR iteration binding is
    // surfaced when the child declares the loop variable across `inputs ∪ artifacts`.
    // Exercise the real caller (`prepareParsedRunbook`) — which assembles that
    // union — rather than calling `surfaceIterationBinding` with a hand-built
    // declared list, so a regression dropping `frontmatter.artifacts` from the
    // union is caught here.
    const parsed = parse('---\nartifacts:\n  - plan\n---\n# Workflow\n\n## 1. Start\n{{plan}}');

    const result = prepareParsedRunbook({
      rawRunbook: parsed.runbook,
      frontmatter: parsed.frontmatter,
      diagnostics: parsed.diagnostics,
      cwd: '/tmp/project',
      templateVars: { ContextId: 'ctx1', WorkPath: '.rundown/work' },
      providedKeys: new Set<string>(),
      iterationBinding: {
        kind: 'item',
        index: 0,
        variable: 'plan',
        value: 'rd://artifacts/ctx/run/p0',
      },
      runbookRef: { source: 'project', path: 'workflow.runbook.md' },
      helperRegistry: new Map(),
      identity: { kind: 'prepared' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // `plan` is declared only via `artifacts:`; it surfaces exactly as an
      // `inputs:`-declared loop variable would.
      expect(result.templateVars.plan).toBe('rd://artifacts/ctx/run/p0');
    }
  });

  it('passes when the required artifact is in providedKeys', () => {
    const parsed = parse(
      '---\nartifacts:\n  - PlanPath\nrequired:\n  - PlanPath\n---\n# Workflow\n\n## 1. Start\n{{PlanPath}}',
    );

    const result = prepareParsedRunbook({
      rawRunbook: parsed.runbook,
      frontmatter: parsed.frontmatter,
      diagnostics: parsed.diagnostics,
      cwd: '/tmp/project',
      templateVars: { PlanPath: 'x', ContextId: 'ctx1', WorkPath: '.rundown/work' },
      providedKeys: new Set(['PlanPath']),
      runbookRef: { source: 'project', path: 'workflow.runbook.md' },
      helperRegistry: new Map(),
      identity: { kind: 'prepared' },
    });

    expect(result.ok).toBe(true);
  });

  it('keys the required gate off providedKeys, not raw templateVars presence', () => {
    const parsed = parse(
      '---\nartifacts:\n  - PlanPath\nrequired:\n  - PlanPath\n---\n# Workflow\n\n## 1. Start\n{{PlanPath}}',
    );

    const result = prepareParsedRunbook({
      rawRunbook: parsed.runbook,
      frontmatter: parsed.frontmatter,
      diagnostics: parsed.diagnostics,
      cwd: '/tmp/project',
      // PlanPath is present in templateVars but absent from providedKeys: a value
      // in the render map does not satisfy `required` — only an explicit provided
      // key does. This fails if the gate ever reads templateVars instead.
      templateVars: { PlanPath: 'x', ContextId: 'ctx1', WorkPath: '.rundown/work' },
      providedKeys: new Set<string>(),
      runbookRef: { source: 'project', path: 'workflow.runbook.md' },
      helperRegistry: new Map(),
      identity: { kind: 'prepared' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('MISSING_REQUIRED_VARS');
    }
  });

  it('applies helper syntax consistently in descriptions, prompts, commands, and ARTIFACTS raw tokens', () => {
    const parsed = parse(`# Workflow

## 1. Build {{ upper env }}
- ARTIFACTS
  - Plan "{{ upper env }}.md"

Prompt {{ upper env }}

\`\`\`bash
echo {{ upper env }}
\`\`\`
`);

    const result = prepareParsedRunbook({
      rawRunbook: parsed.runbook,
      frontmatter: parsed.frontmatter,
      diagnostics: parsed.diagnostics,
      cwd: '/tmp/project',
      templateVars: { env: 'prod', ContextId: 'ctx1', WorkPath: '.rundown/work' },
      providedKeys: new Set(['env']),
      runbookRef: { source: 'project', path: 'workflow.runbook.md' },
      helperRegistry: new Map([['upper', (value: string) => value.toUpperCase()]]),
      identity: { kind: 'runnable', runId: assertRunId('rd_0123456789abcdef0123456789abcdef') },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const step = result.runbook.steps[0];
      expect(step.description).toContain('PROD');
      expect(step.prompt).toContain('PROD');
      if (step.kind !== 'command') throw new Error('expected command step');
      expect(step.command.code).toContain('PROD');
      expect(step.artifacts?.[0]?.rawToken).toBe('PROD.md');
    }
  });

  it('does not report artifact direct aliases as unresolved during preparation', () => {
    const artifact: ArtifactRecord = {
      kind: 'artifact-record',
      uri: 'rd://artifacts/ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
      runId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contextId: 'ctx1',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    };
    const parsed = parse('# Workflow\n\n## 1. Review\nUse {{ Plan }}');

    const result = prepareParsedRunbook({
      rawRunbook: parsed.runbook,
      frontmatter: parsed.frontmatter,
      diagnostics: parsed.diagnostics,
      cwd: '/tmp/project',
      templateVars: { ContextId: 'ctx1', WorkPath: '.rundown/work' },
      runtimeVars: { Plan: artifact },
      providedKeys: new Set(['Plan']),
      runbookRef: { source: 'project', path: 'workflow.runbook.md' },
      helperRegistry: new Map(),
      identity: { kind: 'prepared' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runbook.steps[0]?.prompt).toBe(
        'Use /tmp/project/.rundown/work/.rd-ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
      );
      expect(result.unresolved).not.toContain('Plan');
      // The runtime vars supplied as input must be surfaced verbatim on the
      // result so callers (e.g. the CLI pipeline, which persists
      // parsedPreparation.runtimeVars into run state) can read them back. The
      // prompt assertion above only exercises the substitution path, which
      // shares the same local; this pins the returned field independently.
      expect(result.runtimeVars).toEqual({ Plan: artifact });
    }
  });
});

describe('variable preparation', () => {
  let tmpDir: string;

  function appendManagedManifestRow(
    contextId: string,
    key: string,
    runId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  ) {
    const uri = `rd://artifacts/${contextId}/${runId}/${key}`;
    const row = {
      uri,
      runId,
      contextId,
      runbook: { source: 'project' as const, path: 'producer.runbook.md' },
      key,
      timestamp: '2026-05-25T00:00:00.000Z',
    };
    appendArtifactManifestRecordSync({ cwd: tmpDir, workPath: '.rundown/work' }, row);
    return row;
  }

  function managedRecord(contextId: string, key = 'plan.json'): ArtifactRecord {
    const row = appendManagedManifestRow(contextId, key);
    return ArtifactRecordSchema.parse({ ...row, kind: 'artifact-record' });
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rd-core-vars-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('validates identifiers and rejects poisoned keys', () => {
    expect(isValidVariableName('env')).toBe(true);
    expect(isValidVariableName('_private')).toBe(true);
    expect(isValidVariableName('camelCase')).toBe(true);
    expect(isValidVariableName('UPPER_123')).toBe(true);
    expect(isValidVariableName('123bad')).toBe(false);
    expect(isValidVariableName('env-name')).toBe(false);
    expect(isValidVariableName('env.name')).toBe(false);
    expect(isValidVariableName('bad!')).toBe(false);
    expect(isValidVariableName(' env')).toBe(false);
    expect(isValidVariableName('env ')).toBe(false);
    expect(isValidVariableName('')).toBe(false);
    expect(isValidVariableName('__proto__')).toBe(false);
    expect(isValidVariableName('constructor')).toBe(false);
  });

  it('creates deterministic builtins from supplied process facts', () => {
    const vars = createBuiltinVariables({
      now: new Date('2026-05-15T01:02:03.004Z'),
      branch: 'feature/batch-7',
      contextId: 'abc12345',
    });

    expect(vars).toEqual({
      Date: '2026-05-15',
      DateTime: '2026-05-15T01:02:03.004Z',
      Year: '2026',
      Month: '05',
      Day: '15',
      Branch: 'feature/batch-7',
      WorkPath: '.rundown/work',
      ContextId: 'abc12345',
    });
  });

  it('applies precedence builtins < config < inherited < env < cli and tracks provided keys', async () => {
    const result = await resolveVariableLayers(
      [
        { kind: 'builtins', channel: 'variable', values: { env: 'builtin', Date: '2026-05-15' } },
        { kind: 'config', channel: 'variable', values: { env: 'config', configOnly: 'yes' } },
        { kind: 'inherited', channel: 'variable', values: { env: 'inherited', parentOnly: 'yes' } },
        { kind: 'env', channel: 'variable', values: { env: 'env', envOnly: 'yes' } },
        { kind: 'cli', channel: 'variable', values: { env: 'cli', cliOnly: 'yes' } },
      ],
      { cwd: tmpDir },
    );

    expect(result.vars).toMatchObject({
      env: 'cli',
      configOnly: 'yes',
      parentOnly: 'yes',
      envOnly: 'yes',
      cliOnly: 'yes',
      Date: '2026-05-15',
    });
    expect(result.providedKeys.has('env')).toBe(true);
    expect(result.providedKeys.has('Date')).toBe(false);
  });

  it('rejects reserved runtime variables from non-builtin layers before routing side effects', async () => {
    await expect(
      resolveVariableLayers(
        [
          { kind: 'builtins', channel: 'variable', values: { Step: 'builtin-step' } },
          { kind: 'cli', channel: 'variable', values: { Step: 'shadow', safe: 'value' } },
        ],
        { cwd: tmpDir },
      ),
    ).rejects.toThrow('Reserved runtime variable "Step" cannot be overridden');
  });

  it('routes json and jsonl file sources inside the project root', async () => {
    const json = path.join(tmpDir, 'items.json');
    const jsonl = path.join(tmpDir, 'stream.jsonl');
    await writeFile(json, '[{"name":"one"}]');
    await writeFile(jsonl, '{"name":"one"}\n{"name":"two"}\n');

    const result = await resolveVariableLayers(
      [
        {
          kind: 'cli',
          channel: 'variable',
          values: { items: `file:${json}`, stream: `file:${jsonl}` },
        },
      ],
      { cwd: tmpDir },
    );

    expect(result.vars.items).toEqual([{ name: 'one' }]);
    expect(isJsonArrayStream(result.vars.stream)).toBe(true);
  });

  it('blocks file sources outside the project root without reading them', async () => {
    const nested = path.join(tmpDir, 'project');
    await mkdir(nested);
    const outside = path.join(tmpDir, 'outside.json');
    await writeFile(outside, '["secret"]');

    const result = await resolveVariableLayers(
      [{ kind: 'cli', channel: 'variable', values: { data: `file:${outside}` } }],
      { cwd: nested },
    );

    expect(result.vars.data).toBeUndefined();
    expect(result.warnings).toContain(
      'Ignoring file source "data" — path escapes project directory',
    );
  });

  it('returns null when reading an empty exact artifact URI array from the manifest', async () => {
    await expect(
      readExactArtifactRecordArrayFromManifest([], {
        cwd: tmpDir,
        workPath: '.rundown/work',
      }),
    ).resolves.toBeNull();
  });

  it('parses only JSON string transports made entirely of artifact URIs', () => {
    const uri = 'rd://artifacts/context-a/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json';

    expect(parseJsonArtifactUriArrayTransport(`  ["${uri}"]`)).toEqual([uri]);
    expect(parseJsonArtifactUriArrayTransport('{"uri":"rd://artifacts/context-a"}')).toBeNull();
    expect(parseJsonArtifactUriArrayTransport('[not json')).toBeNull();
    expect(parseJsonArtifactUriArrayTransport(`["${uri}","plain"]`)).toBeNull();
  });

  it('returns null when any exact artifact URI array entry is missing from the manifest', async () => {
    const present = appendManagedManifestRow('context-a', 'a.json');
    const missing = 'rd://artifacts/context-a/rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/missing.json';

    await expect(
      readExactArtifactRecordArrayFromManifest([present.uri, missing], {
        cwd: tmpDir,
        workPath: '.rundown/work',
      }),
    ).resolves.toBeNull();
  });

  it('returns null when an exact artifact URI array entry is malformed', async () => {
    await expect(
      readExactArtifactRecordArrayFromManifest(['rd://not-artifacts'], {
        cwd: tmpDir,
        workPath: '.rundown/work',
      }),
    ).resolves.toBeNull();
  });

  it('does not rehydrate exact artifact URI arrays from partial identity collisions', async () => {
    const runId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const target = `rd://artifacts/context-a/${runId}/plan.json`;
    appendManagedManifestRow(
      'context-a',
      'plan.json',
      assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    );
    appendManagedManifestRow('context-a', 'other.json');
    appendManagedManifestRow('context-b', 'plan.json');

    await expect(
      readExactArtifactRecordArrayFromManifest([target], {
        cwd: tmpDir,
        workPath: '.rundown/work',
      }),
    ).resolves.toBeNull();
  });

  it('does not accept file artifact rows when rehydrating managed exact URI arrays', async () => {
    const filePath = path.join(tmpDir, 'plan.json');
    await writeFile(filePath, '{}');
    const runId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const target = `rd://artifacts/context-a/${runId}/plan.json`;

    appendArtifactManifestRecordSync(
      { cwd: tmpDir, workPath: '.rundown/work' },
      {
        kind: 'file-artifact-record',
        uri: pathToFileURL(filePath).href,
        runId,
        contextId: 'context-a',
        runbook: { source: 'project', path: 'producer.runbook.md' },
        key: 'plan.json',
        timestamp: '2026-05-25T00:00:00.000Z',
      },
    );

    await expect(
      readExactArtifactRecordArrayFromManifest([target], {
        cwd: tmpDir,
        workPath: '.rundown/work',
      }),
    ).resolves.toBeNull();
  });

  it('throws a structured policy error when the file-source policy denies a read', async () => {
    const json = path.join(tmpDir, 'items.json');
    await writeFile(json, '["one"]');
    const canonicalJson = await realpath(json);

    await expect(
      resolveVariableLayers(
        [{ kind: 'cli', channel: 'variable', values: { items: `file:${json}` } }],
        {
          cwd: tmpDir,
          security: {
            evaluator: {
              checkPath: () => ({ allowed: false, requiresPrompt: false, reason: 'blocked' }),
            } as unknown as PolicyEvaluator,
          },
        },
      ),
    ).rejects.toMatchObject({
      name: 'FileSourcePolicyError',
      code: 'POLICY_DENIED',
      variable: 'items',
      filePath: canonicalJson,
      reason: 'blocked',
    } satisfies Partial<FileSourcePolicyError>);
  });

  it('does not prompt when file-source policy denies without prompting', async () => {
    const json = path.join(tmpDir, 'items.json');
    await writeFile(json, '["one"]');
    const canonicalJson = await realpath(json);
    let prompted = false;

    await expect(
      resolveVariableLayers(
        [{ kind: 'cli', channel: 'variable', values: { items: `file:${json}` } }],
        {
          cwd: tmpDir,
          security: {
            evaluator: {
              checkPath: () => ({ allowed: false, requiresPrompt: false, reason: 'blocked' }),
            } as unknown as PolicyEvaluator,
            prompter: {
              requestPermission: async () => {
                prompted = true;
                return { granted: true, persist: false };
              },
            } as unknown as PolicyPrompter,
          },
        },
      ),
    ).rejects.toMatchObject({
      name: 'FileSourcePolicyError',
      code: 'POLICY_DENIED',
      variable: 'items',
      filePath: canonicalJson,
      reason: 'blocked',
    } satisfies Partial<FileSourcePolicyError>);

    expect(prompted).toBe(false);
  });

  it('rehydrates exact artifact URI input from the URI context manifest', async () => {
    const producerContext = 'producer-context';
    const row = appendManagedManifestRow(producerContext, 'plan.json');

    const result = await resolveVariableLayers(
      [{ kind: 'artifact-cli', channel: 'artifact', values: { Plan: row.uri } }],
      { cwd: tmpDir },
    );

    expect(result.vars.Plan).toMatchObject({
      kind: 'artifact-record',
      uri: row.uri,
      contextId: producerContext,
      runId: row.runId,
      key: 'plan.json',
    });
  });

  it('maps external artifact-shaped input by URI and ignores supplied record fields', async () => {
    const row = appendManagedManifestRow('producer-context', 'plan.json');

    const result = await resolveVariableLayers(
      [
        {
          kind: 'artifact-cli',
          channel: 'artifact',
          values: {
            Plan: {
              kind: 'artifact-record',
              uri: row.uri,
              runId: assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
              contextId: 'forged-context',
              runbook: { source: 'project', path: 'forged.runbook.md' },
              key: 'forged.json',
              timestamp: '2026-05-26T00:00:00.000Z',
              path: '/outside/project/secret.txt',
            },
          },
        },
      ],
      { cwd: tmpDir },
    );

    expect(result.vars.Plan).toEqual({
      kind: 'artifact-record',
      uri: row.uri,
      runId: row.runId,
      contextId: row.contextId,
      runbook: row.runbook,
      key: row.key,
      timestamp: row.timestamp,
    });
    expect(isTrustedArtifactRecord(result.vars.Plan)).toBe(true);
  });

  it('does not trust external artifact-shaped arrays supplied via the variable channel', async () => {
    // Clean break: artifact-record objects no longer rehydrate-by-URI on the
    // variable channel. An array of unbranded artifact-shaped objects routes as
    // plain JSON and is rejected at the partitioning trust seam (forged
    // provenance) — the array analog of the scalar forgery test below.
    const first = appendManagedManifestRow('context-a', 'a.json');
    const second = appendManagedManifestRow('context-a', 'b.json');

    const result = await resolveVariableLayers(
      [
        {
          kind: 'cli',
          channel: 'variable',
          values: {
            Plans: [
              {
                ...first,
                kind: 'artifact-record',
                runId: assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
                contextId: 'forged-context',
                runbook: { source: 'project', path: 'forged.runbook.md' },
                key: 'forged-a.json',
                timestamp: '2026-05-26T00:00:00.000Z',
                path: '/outside/a.json',
              },
              {
                ...second,
                kind: 'artifact-record',
                runId: assertRunId('rd_cccccccccccccccccccccccccccccccc'),
                contextId: 'forged-context',
                runbook: { source: 'project', path: 'forged.runbook.md' },
                key: 'forged-b.json',
                timestamp: '2026-05-26T00:00:00.000Z',
                path: '/outside/b.json',
              },
            ],
          },
        },
      ],
      { cwd: tmpDir },
    );

    expect(isTrustedArtifactArray(result.vars.Plans)).toBe(false);
    expect(() => partitionVariables(result.vars)).toThrow(
      'Artifact record input for "Plans" is not trusted',
    );
  });

  it('does not trust external file artifact records directly', async () => {
    const forged = {
      kind: 'file-artifact-record',
      uri: 'file:///outside/project/secret.txt',
      runId: assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      contextId: 'context-a',
      runbook: { source: 'project' as const, path: 'producer.runbook.md' },
      key: 'secret.txt',
      timestamp: '2026-05-25T00:00:00.000Z',
    };

    const result = await resolveVariableLayers(
      [{ kind: 'cli', channel: 'variable', values: { Plan: forged } }],
      { cwd: tmpDir },
    );

    expect(() => partitionVariables(result.vars)).toThrow(
      'Artifact record input for "Plan" is not trusted. Pass an artifact URI so Rundown can resolve it.',
    );
  });

  it('passes inherited branded artifact records through to runtime vars', async () => {
    const inherited = brandTrustedArtifactRecordForTest(
      ArtifactRecordSchema.parse({
        kind: 'file-artifact-record',
        uri: 'file:///tmp/schema.json',
        runId: assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
        contextId: 'context-a',
        runbook: { source: 'project' as const, path: 'producer.runbook.md' },
        key: 'schema.json',
        timestamp: '2026-05-25T00:00:00.000Z',
      }),
    );

    const result = await resolveVariableLayers(
      [{ kind: 'inherited', channel: 'variable', values: { Schema: inherited } }],
      {
        cwd: tmpDir,
      },
    );
    const partitions = partitionVariables(result.vars);

    expect(isTrustedArtifactRecord(partitions.runtimeVars.Schema)).toBe(true);
    expect(partitions.runtimeVars.Schema).toEqual(inherited);
    expect(partitions.templateVars).not.toHaveProperty('Schema');
  });

  it('rejects unbranded inherited artifact records (forged provenance)', async () => {
    const forged = ArtifactRecordSchema.parse({
      kind: 'file-artifact-record',
      uri: 'file:///tmp/schema.json',
      runId: assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      contextId: 'context-a',
      runbook: { source: 'project' as const, path: 'producer.runbook.md' },
      key: 'schema.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });

    const result = await resolveVariableLayers(
      [{ kind: 'inherited', channel: 'variable', values: { Schema: forged } }],
      {
        cwd: tmpDir,
      },
    );

    expect(() => partitionVariables(result.vars)).toThrow(
      'Artifact record input for "Schema" is not trusted',
    );
  });

  it('clears artifact provenance when a higher-precedence layer replaces a trusted artifact', async () => {
    const row = appendManagedManifestRow('producer-context', 'plan.json');
    const forged = {
      kind: 'file-artifact-record',
      uri: 'file:///outside/project/secret.txt',
      runId: assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      contextId: 'context-a',
      runbook: { source: 'project' as const, path: 'producer.runbook.md' },
      key: 'secret.txt',
      timestamp: '2026-05-25T00:00:00.000Z',
    };

    const result = await resolveVariableLayers(
      [
        { kind: 'config', channel: 'variable', values: { Plan: row.uri } },
        { kind: 'cli', channel: 'variable', values: { Plan: forged } },
      ],
      { cwd: tmpDir },
    );

    expect(isTrustedArtifactRecord(result.vars.Plan)).toBe(false);
    expect(() => partitionVariables(result.vars)).toThrow(
      'Artifact record input for "Plan" is not trusted. Pass an artifact URI so Rundown can resolve it.',
    );
  });

  it('leaves selector URI inputs as literal strings', async () => {
    const selector = 'rd://artifacts/ctx/*/plan.json';
    const result = await resolveVariableLayers(
      [{ kind: 'cli', channel: 'variable', values: { Plan: selector } }],
      { cwd: tmpDir },
    );

    expect(result.vars.Plan).toBe(selector);
  });

  it('leaves shorthand-looking inputs as literal strings', async () => {
    const result = await resolveVariableLayers(
      [{ kind: 'cli', channel: 'variable', values: { Plan: 'plan.json', AnyPlan: '*/plan.json' } }],
      { cwd: tmpDir },
    );

    expect(result.vars.Plan).toBe('plan.json');
    expect(result.vars.AnyPlan).toBe('*/plan.json');
  });

  it('leaves missing exact URI input as a literal string', async () => {
    const uri = 'rd://artifacts/missing-context/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json';
    const result = await resolveVariableLayers(
      [{ kind: 'cli', channel: 'variable', values: { Plan: uri } }],
      { cwd: tmpDir },
    );

    expect(result.vars.Plan).toBe(uri);
  });

  it('rehydrates an array of exact artifact URI inputs', async () => {
    const first = appendManagedManifestRow('context-a', 'a.json');
    const second = appendManagedManifestRow('context-a', 'b.json');

    const result = await resolveVariableLayers(
      [{ kind: 'artifact-cli', channel: 'artifact', values: { Plans: [first.uri, second.uri] } }],
      { cwd: tmpDir },
    );

    expect(result.vars.Plans).toEqual([
      expect.objectContaining({ kind: 'artifact-record', uri: first.uri }),
      expect.objectContaining({ kind: 'artifact-record', uri: second.uri }),
    ]);
  });

  it('rehydrates a JSON string array of exact artifact URI inputs', async () => {
    const first = appendManagedManifestRow('context-a', 'a.json');
    const second = appendManagedManifestRow('context-a', 'b.json');

    const result = await resolveVariableLayers(
      [
        {
          kind: 'artifact-cli',
          channel: 'artifact',
          values: { Plans: JSON.stringify([first.uri, second.uri]) },
        },
      ],
      { cwd: tmpDir },
    );

    expect(result.vars.Plans).toEqual([
      expect.objectContaining({ kind: 'artifact-record', uri: first.uri }),
      expect.objectContaining({ kind: 'artifact-record', uri: second.uri }),
    ]);
  });

  it('preserves original URI array input when any entry does not resolve', async () => {
    const first = appendManagedManifestRow('context-a', 'a.json');
    const missing = 'rd://artifacts/context-a/rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/missing.json';
    const original = [first.uri, missing];

    const result = await resolveVariableLayers(
      [{ kind: 'cli', channel: 'variable', values: { Plans: original } }],
      {
        cwd: tmpDir,
      },
    );

    expect(result.vars.Plans).toEqual(original);
  });

  it('preserves original JSON URI array string when any entry does not resolve', async () => {
    const first = appendManagedManifestRow('context-a', 'a.json');
    const missing = 'rd://artifacts/context-a/rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/missing.json';
    const original = JSON.stringify([first.uri, missing]);

    const result = await resolveVariableLayers(
      [{ kind: 'cli', channel: 'variable', values: { Plans: original } }],
      {
        cwd: tmpDir,
      },
    );

    expect(result.vars.Plans).toBe(original);
  });

  it('preserves arrays containing selector URIs as template-safe arrays', async () => {
    const original = ['rd://artifacts/context-a/*/plan.json'];
    const result = await resolveVariableLayers(
      [{ kind: 'cli', channel: 'variable', values: { Plans: original } }],
      {
        cwd: tmpDir,
      },
    );

    expect(result.vars.Plans).toEqual(original);
  });

  it('does not treat empty arrays as artifact transports', async () => {
    const result = await resolveVariableLayers(
      [{ kind: 'cli', channel: 'variable', values: { Plans: [] } }],
      { cwd: tmpDir },
    );

    expect(result.vars.Plans).toEqual([]);
  });

  it('does not trust empty JSON URI array string transports', async () => {
    const result = await resolveVariableLayers(
      [{ kind: 'cli', channel: 'variable', values: { Plans: '[]' } }],
      { cwd: tmpDir },
    );

    expect(result.vars.Plans).toBe('[]');
    expect(isTrustedArtifactArray(result.vars.Plans)).toBe(false);
  });

  describe('boundary channel clean break', () => {
    it('artifact channel brands; variable channel passes the same URI as a string', async () => {
      const uri = appendManagedManifestRow('producer-context', 'PlanPath').uri;

      const artifactLayer: VariableLayer = {
        kind: 'artifact-cli',
        channel: 'artifact',
        values: { PlanPath: uri },
      };
      const variableLayer: VariableLayer = {
        kind: 'cli',
        channel: 'variable',
        values: { PlanPath: uri },
      };

      const branded = await resolveVariableLayers([artifactLayer], { cwd: tmpDir });
      expect(isTrustedArtifactRecord(branded.vars.PlanPath)).toBe(true);

      const plain = await resolveVariableLayers([variableLayer], { cwd: tmpDir });
      expect(typeof plain.vars.PlanPath).toBe('string');
      expect(plain.vars.PlanPath).toBe(uri);
      expect(isTrustedArtifactRecord(plain.vars.PlanPath)).toBe(false);
    });

    it('array branch: artifact channel brands an array; variable channel leaves it plain', async () => {
      const a = appendManagedManifestRow('context-a', 'a').uri;
      const b = appendManagedManifestRow('context-a', 'b').uri;

      const branded = await resolveVariableLayers(
        [{ kind: 'artifact-cli', channel: 'artifact', values: { Plans: [a, b] } }],
        { cwd: tmpDir },
      );
      expect(isTrustedArtifactArray(branded.vars.Plans)).toBe(true);

      // The SAME array of valid rd:// URIs on the variable channel must NOT be branded —
      // this pins the second consume site (routeVariable array branch) so a mutant on its
      // `channel === 'artifact'` guard is killed.
      const plain = await resolveVariableLayers(
        [{ kind: 'cli', channel: 'variable', values: { Plans: [a, b] } }],
        { cwd: tmpDir },
      );
      expect(isTrustedArtifactArray(plain.vars.Plans)).toBe(false);
    });
  });

  describe('artifact channel must resolve', () => {
    it('rejects a non-rd:// scalar on the artifact channel (no string fallthrough)', async () => {
      const layer: VariableLayer = {
        kind: 'artifact-cli',
        channel: 'artifact',
        values: { PlanPath: 'just-a-string' },
      };
      await expect(resolveVariableLayers([layer], { cwd: tmpDir })).rejects.toThrow(
        /Artifact input "PlanPath"/,
      );
    });

    it('rejects a missing manifest row on the artifact channel', async () => {
      const layer: VariableLayer = {
        kind: 'artifact-cli',
        channel: 'artifact',
        values: { PlanPath: 'rd://artifacts/ctx/run/does-not-exist' },
      };
      await expect(resolveVariableLayers([layer], { cwd: tmpDir })).rejects.toThrow(
        /Artifact input "PlanPath"/,
      );
    });

    it('rejects an array containing a non-rd:// entry on the artifact channel', async () => {
      const good = appendManagedManifestRow('context-a', 'A').uri;
      const layer: VariableLayer = {
        kind: 'artifact-cli',
        channel: 'artifact',
        values: { Plans: [good, 'not-a-uri'] },
      };
      await expect(resolveVariableLayers([layer], { cwd: tmpDir })).rejects.toThrow(
        /Artifact input "Plans"/,
      );
    });

    it('throws a typed ArtifactChannelError with INVALID_ARTIFACT_INPUT for a scalar', async () => {
      const layer: VariableLayer = {
        kind: 'artifact-cli',
        channel: 'artifact',
        values: { PlanPath: 'just-a-string' },
      };
      const error = await resolveVariableLayers([layer], { cwd: tmpDir }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ArtifactChannelError);
      expect((error as ArtifactChannelError).code).toBe('INVALID_ARTIFACT_INPUT');
      expect((error as ArtifactChannelError).key).toBe('PlanPath');
    });

    it('throws a typed ArtifactChannelError with INVALID_ARTIFACT_INPUT for an array', async () => {
      const good = appendManagedManifestRow('context-a', 'A').uri;
      const layer: VariableLayer = {
        kind: 'artifact-cli',
        channel: 'artifact',
        values: { Plans: [good, 'not-a-uri'] },
      };
      const error = await resolveVariableLayers([layer], { cwd: tmpDir }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ArtifactChannelError);
      expect((error as ArtifactChannelError).code).toBe('INVALID_ARTIFACT_INPUT');
      expect((error as ArtifactChannelError).key).toBe('Plans');
    });

    it('reports an empty artifact array distinctly (not as a per-entry shape error)', async () => {
      const layer: VariableLayer = {
        kind: 'artifact-cli',
        channel: 'artifact',
        values: { Plans: [] },
      };
      const error = await resolveVariableLayers([layer], { cwd: tmpDir }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ArtifactChannelError);
      expect((error as ArtifactChannelError).code).toBe('INVALID_ARTIFACT_INPUT');
      expect((error as ArtifactChannelError).key).toBe('Plans');
      expect((error as ArtifactChannelError).message).toMatch(/empty array/);
    });
  });

  describe('cross-channel value collision', () => {
    it('errors when the same key arrives via both variable and artifact channels', async () => {
      const uri = appendManagedManifestRow('producer-context', 'X').uri;
      const variableLayer: VariableLayer = {
        kind: 'cli',
        channel: 'variable',
        values: { X: 'scalar' },
      };
      const artifactLayer: VariableLayer = {
        kind: 'artifact-cli',
        channel: 'artifact',
        values: { X: uri },
      };
      await expect(
        resolveVariableLayers([variableLayer, artifactLayer], { cwd: tmpDir }),
      ).rejects.toThrow(/"X".*both the variable and artifact channels/);
    });

    it('throws a typed ArtifactChannelError with ARTIFACT_CHANNEL_COLLISION', async () => {
      const uri = appendManagedManifestRow('producer-context', 'X').uri;
      const variableLayer: VariableLayer = {
        kind: 'cli',
        channel: 'variable',
        values: { X: 'scalar' },
      };
      const artifactLayer: VariableLayer = {
        kind: 'artifact-cli',
        channel: 'artifact',
        values: { X: uri },
      };
      const error = await resolveVariableLayers([variableLayer, artifactLayer], {
        cwd: tmpDir,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ArtifactChannelError);
      expect((error as ArtifactChannelError).code).toBe('ARTIFACT_CHANNEL_COLLISION');
      expect((error as ArtifactChannelError).key).toBe('X');
    });

    it('does not flag a non-reserved builtin name as a cross-channel collision', async () => {
      // WorkPath is a built-in (implicit) variable but not a reserved name. A user
      // supplying it once via --artifacts must NOT be reported as supplying it via
      // "both channels" — the implicit builtins layer is not a user channel.
      const uri = appendManagedManifestRow('producer-context', 'WorkPath').uri;
      const builtinsLayer: VariableLayer = {
        kind: 'builtins',
        channel: 'variable',
        values: { WorkPath: '/implicit/work/path' },
      };
      const artifactLayer: VariableLayer = {
        kind: 'artifact-cli',
        channel: 'artifact',
        values: { WorkPath: uri },
      };
      const result = await resolveVariableLayers([builtinsLayer, artifactLayer], { cwd: tmpDir });
      expect(isTrustedArtifactRecord(result.vars.WorkPath)).toBe(true);
    });

    it('does NOT error when a key is supplied via one channel only', async () => {
      const uri = appendManagedManifestRow('producer-context', 'X').uri;
      const variableLayer: VariableLayer = {
        kind: 'cli',
        channel: 'variable',
        values: { A: 'scalar' },
      };
      const artifactLayer: VariableLayer = {
        kind: 'artifact-cli',
        channel: 'artifact',
        values: { X: uri },
      };
      const result = await resolveVariableLayers([variableLayer, artifactLayer], { cwd: tmpDir });
      expect(result.vars.A).toBe('scalar');
      expect(isTrustedArtifactRecord(result.vars.X)).toBe(true);
    });
  });

  describe('artifact channel required gate', () => {
    it('artifact-cli layer feeds providedKeys (required-gate input seam)', async () => {
      const uri = appendManagedManifestRow('producer-context', 'PlanPath').uri;
      const resolved = await resolveVariableLayers(
        [{ kind: 'artifact-cli', channel: 'artifact', values: { PlanPath: uri } }],
        { cwd: tmpDir },
      );
      expect(resolved.providedKeys.has('PlanPath')).toBe(true);
      expect(isTrustedArtifactRecord(resolved.vars.PlanPath)).toBe(true);
    });

    it('is permissive: an undeclared artifact name still supplies', async () => {
      const uri = appendManagedManifestRow('producer-context', 'Extra').uri;
      const resolved = await resolveVariableLayers(
        [{ kind: 'artifact-cli', channel: 'artifact', values: { Extra: uri } }],
        { cwd: tmpDir },
      );
      expect(isTrustedArtifactRecord(resolved.vars.Extra)).toBe(true);
    });
  });

  it('partitions artifact values into runtime variables', () => {
    const artifact = brandTrustedArtifactRecordForTest(managedRecord('ctx1'));
    const result = partitionVariables({
      Plain: 'value',
      Count: 3,
      Plan: artifact,
    });

    expect(result.templateVars).toEqual({ Plain: 'value', Count: 3 });
    expect(result.runtimeVars).toEqual({ Plan: artifact });
  });

  it('rejects artifact-shaped values without provenance during partitioning', () => {
    const artifact = managedRecord('ctx1');

    expect(() => partitionVariables({ Plan: artifact })).toThrow(
      'Artifact record input for "Plan" is not trusted. Pass an artifact URI so Rundown can resolve it.',
    );
  });

  it('rejects file artifact-shaped values without provenance during partitioning', () => {
    const artifact = {
      kind: 'file-artifact-record' as const,
      uri: 'file:///tmp/review.schema.json',
      runId: assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      contextId: 'ctx1',
      runbook: { source: 'project' as const, path: 'review.runbook.md' },
      key: 'review.schema.json',
      timestamp: '2024-01-01T00:00:00.000Z',
    };

    expect(() => partitionVariables({ Schema: artifact })).toThrow(
      'Artifact record input for "Schema" is not trusted. Pass an artifact URI so Rundown can resolve it.',
    );
  });

  it('rejects unbranded arrays when every entry is artifact-shaped', () => {
    const managed = managedRecord('ctx1');
    const file = {
      kind: 'file-artifact-record' as const,
      uri: 'file:///tmp/review.schema.json',
      runId: assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      contextId: 'ctx1',
      runbook: { source: 'project' as const, path: 'review.runbook.md' },
      key: 'review.schema.json',
      timestamp: '2024-01-01T00:00:00.000Z',
    };

    expect(() => partitionVariables({ Artifacts: [managed, file] })).toThrow(
      'Artifact record input for "Artifacts" is not trusted. Pass an artifact URI so Rundown can resolve it.',
    );
  });

  it('preserves mixed JSON arrays that are not wholly artifact-shaped', () => {
    const managed = managedRecord('ctx1');
    const values = [managed, { kind: 'note', value: 'keep me as template JSON' }, null, 'plain'];

    const result = partitionVariables({ Values: values });

    expect(result.templateVars).toEqual({ Values: values });
    expect(result.runtimeVars).toEqual({});
  });

  it('preserves scalar template values during partitioning', () => {
    const result = partitionVariables({
      Name: 'plain',
      Count: 3,
    });

    expect(result.templateVars).toEqual({ Name: 'plain', Count: 3 });
    expect(result.runtimeVars).toEqual({});
  });

  it('preserves plain JSON objects during partitioning', () => {
    const value = { kind: 'note', title: 'plain object' };

    const result = partitionVariables({ Note: value });

    expect(result.templateVars).toEqual({ Note: value });
    expect(result.runtimeVars).toEqual({});
  });

  it('preserves empty arrays during partitioning', () => {
    const result = partitionVariables({ Values: [] });

    expect(result.templateVars).toEqual({ Values: [] });
    expect(result.runtimeVars).toEqual({});
  });

  it('preserves arrays with non-object entries even when one entry looks artifact-shaped', () => {
    const values = [managedRecord('ctx1'), 'plain'];

    const result = partitionVariables({ Values: values });

    expect(result.templateVars).toEqual({ Values: values });
    expect(result.runtimeVars).toEqual({});
  });

  it('preserves arrays containing null and plain JSON objects', () => {
    const values = [null, { kind: 'note', title: 'plain object' }];

    const result = partitionVariables({ Values: values });

    expect(result.templateVars).toEqual({ Values: values });
    expect(result.runtimeVars).toEqual({});
  });

  it('preserves arrays of non-artifact JSON objects as template variables', () => {
    const values = [
      { kind: 'note', value: 'first' },
      { kind: 'artifact-record', value: 'kind alone is not an artifact record array bypass' },
    ];

    const result = partitionVariables({ Values: values });

    expect(result.templateVars).toEqual({ Values: values });
    expect(result.runtimeVars).toEqual({});
  });

  it('keeps artifact arrays out of templateVars', () => {
    const arr = brandTrustedArtifactArrayForTest([managedRecord('ctx1')]);
    const result = partitionVariables({ Plans: arr });

    expect(result.templateVars).toEqual({});
    expect(result.runtimeVars).toEqual({ Plans: arr });
  });
});
