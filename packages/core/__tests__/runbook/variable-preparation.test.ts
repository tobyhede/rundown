import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseRunbookDocument } from '@rundown-org/parser';
import {
  type FileSourcePolicyError,
  RESERVED_TEMPLATE_HELPER_NAMES,
  assertRunId,
  createBuiltinVariables,
  detectTemplateHelperCollisions,
  isJsonArrayStream,
  isValidVariableName,
  prepareParsedRunbook,
  resolveVariableLayers,
  type PrepareParsedRunbookInput,
} from '../../src/runbook/index.js';
import type { PolicyEvaluator } from '../../src/policy/index.js';

describe('template helper semantics', () => {
  it('reserves artifact-producing built-in helper names', () => {
    expect(RESERVED_TEMPLATE_HELPER_NAMES.has('path')).toBe(true);
    expect(RESERVED_TEMPLATE_HELPER_NAMES.has('artifact')).toBe(true);
    expect(RESERVED_TEMPLATE_HELPER_NAMES.has('validateSchema')).toBe(true);
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
      templateVars: { env: 'prod' },
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
      templateVars: { env: 'builtin-default' },
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
      templateVars: { env: 'prod' },
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
});

describe('variable preparation', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'rd-core-vars-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('validates identifiers and rejects poisoned keys', () => {
    expect(isValidVariableName('env')).toBe(true);
    expect(isValidVariableName('_private')).toBe(true);
    expect(isValidVariableName('123bad')).toBe(false);
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
        { kind: 'builtins', values: { env: 'builtin', Date: '2026-05-15' } },
        { kind: 'config', values: { env: 'config', configOnly: 'yes' } },
        { kind: 'inherited', values: { env: 'inherited', parentOnly: 'yes' } },
        { kind: 'env', values: { env: 'env', envOnly: 'yes' } },
        { kind: 'cli', values: { env: 'cli', cliOnly: 'yes' } },
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
          { kind: 'builtins', values: { Step: 'builtin-step' } },
          { kind: 'cli', values: { Step: 'shadow', safe: 'value' } },
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
      [{ kind: 'cli', values: { items: `file:${json}`, stream: `file:${jsonl}` } }],
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
      [{ kind: 'cli', values: { data: `file:${outside}` } }],
      { cwd: nested },
    );

    expect(result.vars.data).toBeUndefined();
    expect(result.warnings).toContain(
      'Ignoring file source "data" — path escapes project directory',
    );
  });

  it('throws a structured policy error when the file-source policy denies a read', async () => {
    const json = path.join(tmpDir, 'items.json');
    await writeFile(json, '["one"]');
    const canonicalJson = await realpath(json);

    await expect(
      resolveVariableLayers([{ kind: 'cli', values: { items: `file:${json}` } }], {
        cwd: tmpDir,
        security: {
          evaluator: {
            checkPath: () => ({ allowed: false, requiresPrompt: false, reason: 'blocked' }),
          } as unknown as PolicyEvaluator,
        },
      }),
    ).rejects.toMatchObject({
      name: 'FileSourcePolicyError',
      code: 'POLICY_DENIED',
      variable: 'items',
      filePath: canonicalJson,
      reason: 'blocked',
    } satisfies Partial<FileSourcePolicyError>);
  });
});
