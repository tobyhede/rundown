import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  discoverVariables,
  FileSourcePolicyError,
  findConfigFile,
  parseVarFlag,
  loadVariablesFromFile,
  BUILTIN_VARIABLES,
  getBuiltinVariables,
  resolveVariables,
  routeExtraVars,
  collectCliFlags,
  setExecFileSyncImpl,
} from '../../src/services/variable-discovery.js';
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  appendArtifactManifestRecordSync,
  assertRunId,
  isError,
  isJsonArrayStream,
  isTrustedArtifactArray,
  isTrustedArtifactRecord,
  resolveForValue,
  RUNDOWN_DIR,
  WORK_DIR,
} from '@rundown-org/core';
import type { ForContext, PolicyEvaluator, PolicyPrompter } from '@rundown-org/core';
import { brandEffectiveVarsForTest } from '../helpers/brand-helpers.js';
import { mockFn } from '../helpers/typed-mocks.js';

// Narrowed mock surfaces: `resolveVariables` only invokes `checkPath` on
// the evaluator and `requestPermission` on the prompter for these tests.
// Casting via `unknown` keeps argument-type checking on the captured
// methods without forcing the test to construct a fully-fledged class.
type CheckPathFn = PolicyEvaluator['checkPath'];
type RequestPermissionFn = PolicyPrompter['requestPermission'];

const RESERVED_IDENTITY_KEY_VARIANTS = [
  BUILTIN_VARIABLES.RunId,
  'runid',
  BUILTIN_VARIABLES.RunbookRef,
  'RUNBOOKREF',
] as const;

describe('parseVarFlag', () => {
  it('should parse key=value format', () => {
    expect(parseVarFlag('test_command=npm test')).toEqual({
      key: 'test_command',
      value: 'npm test',
    });
  });

  it('should handle values with equals signs', () => {
    expect(parseVarFlag('cmd=echo a=b')).toEqual({
      key: 'cmd',
      value: 'echo a=b',
    });
  });

  it('should return null for invalid format (no equals)', () => {
    expect(parseVarFlag('invalid')).toBeNull();
  });

  it('should return null for empty key', () => {
    expect(parseVarFlag('=value')).toBeNull();
  });

  it('should return null for invalid identifier characters', () => {
    expect(parseVarFlag('invalid-key=value')).toBeNull();
    expect(parseVarFlag('123key=value')).toBeNull();
    expect(parseVarFlag('key.name=value')).toBeNull();
  });

  it('should accept valid identifiers', () => {
    expect(parseVarFlag('_private=value')).toEqual({ key: '_private', value: 'value' });
    expect(parseVarFlag('camelCase=value')).toEqual({ key: 'camelCase', value: 'value' });
    expect(parseVarFlag('UPPER_CASE_123=value')).toEqual({ key: 'UPPER_CASE_123', value: 'value' });
  });

  it('should allow empty value', () => {
    expect(parseVarFlag('key=')).toEqual({ key: 'key', value: '' });
  });

  it.each(['__proto__', 'constructor', 'prototype'])('should reject poisoned key: %s', (key) => {
    expect(parseVarFlag(`${key}=value`)).toBeNull();
  });
});

describe('getBuiltinVariables', () => {
  afterEach(() => {
    setExecFileSyncImpl(nodeExecFileSync);
  });

  it('should return all expected built-in variables', () => {
    const builtins = getBuiltinVariables();

    expect(builtins).toHaveProperty('Date');
    expect(builtins).toHaveProperty('DateTime');
    expect(builtins).toHaveProperty('Year');
    expect(builtins).toHaveProperty('Month');
    expect(builtins).toHaveProperty('Day');
    expect(builtins).toHaveProperty('Branch');
    expect(builtins).toHaveProperty('WorkPath');
    expect(builtins).toHaveProperty('ContextId');
    expect(builtins).not.toHaveProperty('RunId');
    expect(builtins).not.toHaveProperty('RunbookRef');
  });

  it('should return Date in YYYY-MM-DD format', () => {
    const builtins = getBuiltinVariables();

    expect(builtins.Date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('should return DateTime in ISO 8601 format', () => {
    const builtins = getBuiltinVariables();

    // ISO 8601 format: YYYY-MM-DDTHH:mm:ss.sssZ
    expect(builtins.DateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('should return Year as 4-digit string', () => {
    const builtins = getBuiltinVariables();

    expect(builtins.Year).toMatch(/^\d{4}$/);
  });

  it('should return Month as 2-digit zero-padded string (01-12)', () => {
    const builtins = getBuiltinVariables();

    expect(builtins.Month).toMatch(/^(0[1-9]|1[0-2])$/);
  });

  it('should return Day as 2-digit zero-padded string (01-31)', () => {
    const builtins = getBuiltinVariables();

    expect(builtins.Day).toMatch(/^(0[1-9]|[12]\d|3[01])$/);
  });

  it('should return WorkPath starting with WORK_DIR', () => {
    const builtins = getBuiltinVariables();

    expect(builtins.WorkPath.startsWith(WORK_DIR)).toBe(true);
  });

  it('should return Branch property', () => {
    const builtins = getBuiltinVariables();

    expect(builtins).toHaveProperty('Branch');
  });

  it('should return fixed WorkPath even when in git repo', () => {
    setExecFileSyncImpl(() => 'feature/my-branch\n');

    const builtins = getBuiltinVariables();
    expect(builtins.WorkPath).toBe(WORK_DIR);
    expect(builtins.Branch).toBe('feature/my-branch');
  });

  it('detects git branch with the expected command and trims stdout', () => {
    let capturedCommand: string | undefined;
    let capturedArgs: readonly string[] | undefined;
    let capturedOptions: unknown;
    setExecFileSyncImpl((command, args, options) => {
      capturedCommand = command;
      capturedArgs = args;
      capturedOptions = options;
      return 'feature/branch-check\n';
    });

    const builtins = getBuiltinVariables();

    expect(capturedCommand).toBe('git');
    expect(capturedArgs).toEqual(['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(capturedOptions).toEqual({
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(builtins.Branch).toBe('feature/branch-check');
  });

  it('should fall back to WORK_DIR when not in git', () => {
    setExecFileSyncImpl(() => {
      throw new Error('not a git repo');
    });

    const builtins = getBuiltinVariables();
    expect(builtins.WorkPath).toBe(WORK_DIR);
    expect(builtins.Branch).toBe('');
  });

  it('should fall back to WORK_DIR on detached HEAD', () => {
    setExecFileSyncImpl(() => 'HEAD\n');

    const builtins = getBuiltinVariables();
    expect(builtins.WorkPath).toBe(WORK_DIR);
    expect(builtins.Branch).toBe('');
  });

  it('should not generate RunId during variable discovery', () => {
    const builtins = getBuiltinVariables();

    expect(builtins).not.toHaveProperty('RunId');
  });

  it('registers runtime identity keys without emitting them as discovery builtins', () => {
    const builtins = getBuiltinVariables();

    expect(BUILTIN_VARIABLES.RunId).toBe('RunId');
    expect(BUILTIN_VARIABLES.RunbookRef).toBe('RunbookRef');
    expect(builtins).not.toHaveProperty(BUILTIN_VARIABLES.RunId);
    expect(builtins).not.toHaveProperty(BUILTIN_VARIABLES.RunbookRef);
  });

  it('should return ContextId as 8-char alphanumeric string', () => {
    const builtins = getBuiltinVariables();

    expect(builtins).toHaveProperty('ContextId');
    expect(builtins.ContextId).toMatch(/^[a-f0-9]+$/);
    expect(builtins.ContextId).toHaveLength(8);
  });

  it('should return unique ContextId across calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => getBuiltinVariables().ContextId));
    expect(ids.size).toBeGreaterThan(90);
  });

  it('should return consistent date components', () => {
    const builtins = getBuiltinVariables();

    // Date should match Year-Month-Day
    expect(builtins.Date).toBe(`${builtins.Year}-${builtins.Month}-${builtins.Day}`);
  });
});

describe('loadVariablesFromFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'var-file-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should load and parse valid YAML file', async () => {
    const filePath = path.join(tmpDir, 'vars.yaml');
    await fs.writeFile(filePath, 'test_command: npm test\nlint_command: npm run lint\nport: 3000');

    const result = await loadVariablesFromFile(filePath);

    expect(result).toEqual({
      test_command: 'npm test',
      lint_command: 'npm run lint',
      port: '3000',
    });
  });

  it('should return empty object for non-existent file', async () => {
    const filePath = path.join(tmpDir, 'does-not-exist.yaml');

    const result = await loadVariablesFromFile(filePath);

    expect(result).toEqual({});
  });

  it('should return empty object for malformed YAML', async () => {
    const filePath = path.join(tmpDir, 'malformed.yaml');
    await fs.writeFile(filePath, 'invalid: yaml: content:\n  - missing\n  proper: indentation');

    const result = await loadVariablesFromFile(filePath);

    expect(result).toEqual({});
  });

  it('should return empty object if YAML content is null', async () => {
    const filePath = path.join(tmpDir, 'null.yaml');
    await fs.writeFile(filePath, '');

    const result = await loadVariablesFromFile(filePath);

    expect(result).toEqual({});
  });

  it('should ignore array YAML values (numeric keys are invalid identifiers)', async () => {
    const filePath = path.join(tmpDir, 'array.yaml');
    await fs.writeFile(filePath, '- item1\n- item2\n- item3');

    const result = await loadVariablesFromFile(filePath);

    // Arrays are treated as objects with numeric keys by Object.entries(),
    // but numeric keys don't match VALID_IDENTIFIER pattern so they're ignored
    expect(result).toEqual({});
  });

  it('should return empty object if YAML content is not an object (string)', async () => {
    const filePath = path.join(tmpDir, 'string.yaml');
    await fs.writeFile(filePath, 'just a string');

    const result = await loadVariablesFromFile(filePath);

    expect(result).toEqual({});
  });

  it('should return empty object for scalar YAML in raw mode', async () => {
    const filePath = path.join(tmpDir, 'raw-string.yaml');
    await fs.writeFile(filePath, 'just a string');

    const result = await loadVariablesFromFile(filePath, {
      normalize: false,
      optional: false,
    });

    expect(result).toEqual({});
  });

  it('should return empty object for null YAML in raw mode', async () => {
    const filePath = path.join(tmpDir, 'raw-null.yaml');
    await fs.writeFile(filePath, '');

    const result = await loadVariablesFromFile(filePath, {
      normalize: false,
      optional: false,
    });

    expect(result).toEqual({});
  });

  it('should reject malformed YAML in required raw mode', async () => {
    const filePath = path.join(tmpDir, 'raw-malformed.yaml');
    await fs.writeFile(filePath, 'invalid: yaml: content:\n  - missing\n  proper: indentation');

    await expect(
      loadVariablesFromFile(filePath, {
        normalize: false,
        optional: false,
      }),
    ).rejects.toThrow();
  });

  it('should ignore complex YAML values when normalizing to strings', async () => {
    const filePath = path.join(tmpDir, 'nested.yaml');
    await fs.writeFile(filePath, 'nested:\n  x: 1\nplain: ok\n');

    const result = await loadVariablesFromFile(filePath);

    expect(result).toEqual({ plain: 'ok' });
  });

  it('should convert non-string values to strings (numbers)', async () => {
    const filePath = path.join(tmpDir, 'numbers.yaml');
    await fs.writeFile(filePath, 'port: 3000\nmax_connections: 100\npi: 3.14');

    const result = await loadVariablesFromFile(filePath);

    expect(result).toEqual({
      port: '3000',
      max_connections: '100',
      pi: '3.14',
    });
  });

  it('should convert non-string values to strings (booleans)', async () => {
    const filePath = path.join(tmpDir, 'booleans.yaml');
    await fs.writeFile(filePath, 'debug: true\nenabled: false');

    const result = await loadVariablesFromFile(filePath);

    expect(result).toEqual({
      debug: 'true',
      enabled: 'false',
    });
  });

  it('should convert mixed value types to strings', async () => {
    const filePath = path.join(tmpDir, 'mixed.yaml');
    await fs.writeFile(filePath, 'name: my-app\nport: 8080\ndebug: true\nversion: 1.2.3');

    const result = await loadVariablesFromFile(filePath);

    expect(result).toEqual({
      name: 'my-app',
      port: '8080',
      debug: 'true',
      version: '1.2.3',
    });
  });
});

describe('findConfigFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'find-config-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should return config path when .rundown/config.yaml exists', async () => {
    const rundownDir = path.join(tmpDir, RUNDOWN_DIR);
    await fs.mkdir(rundownDir, { recursive: true });
    const configPath = path.join(rundownDir, 'config.yaml');
    await fs.writeFile(configPath, 'key: value');

    const result = await findConfigFile(tmpDir);

    expect(result).toBe(configPath);
  });

  it('should return null when no config found', async () => {
    const result = await findConfigFile(tmpDir);
    expect(result).toBeNull();
  });

  it('should find config in parent directory', async () => {
    const rundownDir = path.join(tmpDir, RUNDOWN_DIR);
    await fs.mkdir(rundownDir, { recursive: true });
    const configPath = path.join(rundownDir, 'config.yaml');
    await fs.writeFile(configPath, 'key: value');

    const nested = path.join(tmpDir, 'nested', 'deep');
    await fs.mkdir(nested, { recursive: true });

    const result = await findConfigFile(nested);

    expect(result).toBe(configPath);
  });

  it('should stop at git root and return null', async () => {
    await fs.mkdir(path.join(tmpDir, '.git'));

    const nested = path.join(tmpDir, 'nested', 'deep');
    await fs.mkdir(nested, { recursive: true });

    const result = await findConfigFile(nested);
    expect(result).toBeNull();
  });

  it('should not find config above git root', async () => {
    // Parent has config
    const parentRundownDir = path.join(tmpDir, RUNDOWN_DIR);
    await fs.mkdir(parentRundownDir, { recursive: true });
    await fs.writeFile(path.join(parentRundownDir, 'config.yaml'), 'should_not_find: true');

    // Repo has .git
    const repoDir = path.join(tmpDir, 'repo');
    await fs.mkdir(path.join(repoDir, '.git'), { recursive: true });

    const subdir = path.join(repoDir, 'subdir');
    await fs.mkdir(subdir, { recursive: true });

    const result = await findConfigFile(subdir);
    expect(result).toBeNull();
  });

  it('should find config at git root level', async () => {
    // Git root with config
    await fs.mkdir(path.join(tmpDir, '.git'));
    const rundownDir = path.join(tmpDir, RUNDOWN_DIR);
    await fs.mkdir(rundownDir, { recursive: true });
    const configPath = path.join(rundownDir, 'config.yaml');
    await fs.writeFile(configPath, 'key: value');

    const nested = path.join(tmpDir, 'nested');
    await fs.mkdir(nested, { recursive: true });

    const result = await findConfigFile(nested);

    expect(result).toBe(configPath);
  });
});

describe('discoverVariables', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'var-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should discover .rundown/config.yaml', async () => {
    const rundownDir = path.join(tmpDir, RUNDOWN_DIR);
    await fs.mkdir(rundownDir, { recursive: true });
    await fs.writeFile(
      path.join(rundownDir, 'config.yaml'),
      'test_command: npm test\nlint_command: npm run lint',
    );

    const result = await discoverVariables(tmpDir);

    expect(result).toEqual({
      test_command: 'npm test',
      lint_command: 'npm run lint',
    });
  });

  it('should return empty object when no config found', async () => {
    const result = await discoverVariables(tmpDir);
    expect(result).toEqual({});
  });

  it('should stop discovery at git root', async () => {
    // Create .git in tmpDir (marks as root)
    await fs.mkdir(path.join(tmpDir, '.git'));

    // Create nested directory
    const nested = path.join(tmpDir, 'nested', 'deep');
    await fs.mkdir(nested, { recursive: true });

    // Config in parent of git root should not be found
    const result = await discoverVariables(nested);
    expect(result).toEqual({});
  });

  it('should not discover config.yaml above git root', async () => {
    // Create structure:
    // /parent/.rundown/config.yaml  <- should NOT be found
    // /parent/repo/.git/            <- git root
    // /parent/repo/subdir/          <- cwd

    // Create parent dir with .rundown/config.yaml
    const parentDir = tmpDir;
    const parentRundownDir = path.join(parentDir, RUNDOWN_DIR);
    await fs.mkdir(parentRundownDir, { recursive: true });
    await fs.writeFile(path.join(parentRundownDir, 'config.yaml'), 'should_not_find: this value');

    // Create repo subdirectory with .git (marks git root)
    const repoDir = path.join(parentDir, 'repo');
    await fs.mkdir(path.join(repoDir, '.git'), { recursive: true });

    // Create subdirectory below git root
    const subdir = path.join(repoDir, 'subdir');
    await fs.mkdir(subdir, { recursive: true });

    // Run discovery from subdir - should stop at git root, not find parent config
    const result = await discoverVariables(subdir);
    expect(result).toEqual({});
  });
});

describe('resolveVariables', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-var-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function appendManagedManifestRow(contextId = 'context-a', key = 'plan.json') {
    const runId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const uri = `rd://artifacts/${contextId}/${runId}/${key}`;
    const row = {
      uri,
      runId,
      contextId,
      runbook: { source: 'project' as const, path: 'producer.runbook.md' },
      key,
      timestamp: '2026-05-25T00:00:00.000Z',
    };
    appendArtifactManifestRecordSync({ cwd: tmpDir, workPath: WORK_DIR }, row);
    return row;
  }

  describe('scalar routing', () => {
    it('routes --input scalar to vars only', async () => {
      const result = await resolveVariables({ input: ['env=staging'] }, tmpDir);
      expect(result.vars.env).toBe('staging');
    });
  });

  describe('reserved runtime keys', () => {
    it('rejects reserved keys with an error', async () => {
      await expect(resolveVariables({ input: ['Step=shadow'] }, tmpDir)).rejects.toThrow(
        /reserved runtime variable/i,
      );
    });

    it('rejects reserved keys case-insensitively', async () => {
      await expect(resolveVariables({ input: ['INDEX=9'] }, tmpDir)).rejects.toThrow(
        /reserved runtime variable/i,
      );
    });

    it.each(
      RESERVED_IDENTITY_KEY_VARIANTS,
    )('rejects runtime identity key "%s" from --input', async (name) => {
      await expect(resolveVariables({ input: [`${name}=shadow`] }, tmpDir)).rejects.toThrow(
        /reserved runtime variable/i,
      );
    });

    it.each(
      RESERVED_IDENTITY_KEY_VARIANTS,
    )('rejects runtime identity key "%s" from --input-json', async (name) => {
      await expect(resolveVariables({ inputJson: [`${name}="shadow"`] }, tmpDir)).rejects.toThrow(
        /reserved runtime variable/i,
      );
    });

    it.each(
      RESERVED_IDENTITY_KEY_VARIANTS,
    )('rejects runtime identity key "%s" from --input-file', async (name) => {
      const varFile = path.join(tmpDir, `${name}.yaml`);
      await fs.writeFile(varFile, `${name}: shadow\n`);

      await expect(resolveVariables({ inputFile: [`${name}.yaml`] }, tmpDir)).rejects.toThrow(
        /reserved runtime variable/i,
      );
    });

    it.each(
      RESERVED_IDENTITY_KEY_VARIANTS,
    )('ignores runtime identity key "%s" from RD_INPUT_*', async (name) => {
      const envKey = `RD_INPUT_${name}`;
      const previous = process.env[envKey];
      process.env[envKey] = 'shadow';

      try {
        const result = await resolveVariables({}, tmpDir);

        expect(
          Object.keys(result.vars).some((key) => key.toLowerCase() === name.toLowerCase()),
        ).toBe(false);
        expect(
          Array.from(result.providedKeys).some((key) => key.toLowerCase() === name.toLowerCase()),
        ).toBe(false);
        expect(result.warnings.some((w) => w.includes(envKey) && w.includes('reserved'))).toBe(
          true,
        );
      } finally {
        if (previous === undefined) {
          delete process.env[envKey];
        } else {
          process.env[envKey] = previous;
        }
      }
    });

    it('reports all reserved key violations in a single error', async () => {
      const error = await resolveVariables({ input: ['Step=a', 'Index=b'] }, tmpDir).catch(
        (e: unknown) => e,
      );
      expect(isError(error)).toBe(true);
      if (!isError(error)) throw new Error('Expected an Error to be thrown');
      expect(error.message).toMatch(/reserved runtime variables/i);
      expect(error.message).toContain('"Step"');
      expect(error.message).toContain('"Index"');
    });

    it('does not route non-reserved keys when layer contains a reserved violation', async () => {
      await expect(
        resolveVariables({ input: ['safe=value', 'Step=shadow'] }, tmpDir),
      ).rejects.toThrow(/reserved runtime variable/i);
    });

    it('allows non-reserved variables', async () => {
      const result = await resolveVariables({ input: ['env=staging'] }, tmpDir);
      expect(result.vars.env).toBe('staging');
    });
  });

  describe('file: prefix routing', () => {
    it('routes --input file:.json to vars as JsonObject', async () => {
      const file = path.join(tmpDir, 'servers.json');
      await fs.writeFile(file, '{"host":"server-a","port":3000}');

      const result = await resolveVariables({ input: [`servers=file:${file}`] }, tmpDir);
      expect(result.vars.servers).toEqual({ host: 'server-a', port: 3000 });
    });

    it('routes --input file:.json array to vars as JsonArray', async () => {
      const file = path.join(tmpDir, 'items.json');
      await fs.writeFile(file, '["a","b","c"]');

      const result = await resolveVariables({ input: [`items=file:${file}`] }, tmpDir);
      expect(result.vars.items).toEqual(['a', 'b', 'c']);
    });

    it('routes --input file:.jsonl to vars as JsonArrayStream', async () => {
      const file = path.join(tmpDir, 'data.jsonl');
      await fs.writeFile(file, '{"a":1}\n');

      const result = await resolveVariables({ input: [`data=file:${file}`] }, tmpDir);
      expect(isJsonArrayStream(result.vars.data)).toBe(true);
      expect(result.vars.data).toMatchObject({
        kind: 'json-array-stream',
        path: await fs.realpath(file),
      });
    });

    it('resolves relative file: paths against cwd', async () => {
      const file = path.join(tmpDir, 'hosts.json');
      await fs.writeFile(file, '["h1"]');

      const result = await resolveVariables({ input: ['hosts=file:hosts.json'] }, tmpDir);
      expect(result.vars.hosts).toEqual(['h1']);
    });

    it('rejects unsupported file extensions', async () => {
      const file = path.join(tmpDir, 'data.txt');
      await fs.writeFile(file, 'content');

      await expect(resolveVariables({ input: [`data=file:${file}`] }, tmpDir)).rejects.toThrow(
        /Unsupported file extension/,
      );
    });
  });

  describe('YAML array routing', () => {
    it('routes YAML array to vars as JsonArray (type-preserving)', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'servers:\n  - alpha\n  - beta\n  - gamma\n');

      const result = await resolveVariables({ inputFile: ['vars.yaml'] }, tmpDir);
      expect(result.vars.servers).toEqual(['alpha', 'beta', 'gamma']);
    });
  });

  describe('YAML multiline string routing', () => {
    it('routes YAML multiline string to vars as plain string', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'log: |\n  line1\n  line2\n  line3\n');

      const result = await resolveVariables({ inputFile: ['vars.yaml'] }, tmpDir);
      // YAML block scalar with trailing newline stripped by YAML parser produces "line1\nline2\nline3\n"
      expect(typeof result.vars.log).toBe('string');
      expect((result.vars.log as string).includes('\n')).toBe(true);
    });
  });

  describe('YAML object routing', () => {
    it('preserves object values from --input-file', async () => {
      const tmpFile = path.join(tmpDir, 'objects.yaml');
      await fs.writeFile(tmpFile, 'config:\n  host: localhost\n  port: 3000\n');

      const result = await resolveVariables({ inputFile: ['objects.yaml'] }, tmpDir);

      expect(result.vars.config).toEqual({ host: 'localhost', port: 3000 });
    });

    it('stringifies YAML object with Date value and warns', async () => {
      const tmpFile = path.join(tmpDir, 'date-obj.yaml');
      // YAML parses unquoted timestamps as Date objects
      await fs.writeFile(tmpFile, 'event:\n  name: launch\n  date: 2026-03-20\n');

      const result = await resolveVariables({ inputFile: ['date-obj.yaml'] }, tmpDir);

      // Date gets parsed by yaml.load() as a JS Date, failing isJsonValue
      expect(typeof result.vars.event).toBe('string');
      expect(result.warnings).toContain(
        'Variable "event" contains non-JSON values; converting to string',
      );
    });

    it('preserves normal YAML object as JsonObject', async () => {
      const tmpFile = path.join(tmpDir, 'normal-obj.yaml');
      // Quoted strings prevent YAML date parsing
      await fs.writeFile(tmpFile, 'config:\n  host: localhost\n  port: 3000\n  debug: true\n');

      const result = await resolveVariables({ inputFile: ['normal-obj.yaml'] }, tmpDir);

      expect(result.vars.config).toEqual({ host: 'localhost', port: 3000, debug: true });
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('YAML file: prefix routing', () => {
    it('routes YAML file:.jsonl value to vars as JsonArrayStream', async () => {
      const dataFile = path.join(tmpDir, 'data.jsonl');
      await fs.writeFile(dataFile, '{"x":1}\n');
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, `items: "file:${dataFile}"\n`);

      const result = await resolveVariables({ inputFile: ['vars.yaml'] }, tmpDir);
      expect(isJsonArrayStream(result.vars.items)).toBe(true);
      expect(result.vars.items).toMatchObject({
        kind: 'json-array-stream',
        path: await fs.realpath(dataFile),
      });
    });
  });

  describe('inherited vars', () => {
    it('inherited vars override builtins', async () => {
      const result = await resolveVariables({ inheritedVars: { ContextId: 'parent123' } }, tmpDir);
      expect(result.vars.ContextId).toBe('parent123');
    });

    it('inherited vars override discovered config', async () => {
      const configDir = path.join(tmpDir, RUNDOWN_DIR);
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, 'config.yaml'), 'myVar: config\n');

      const result = await resolveVariables(
        {
          inheritedVars: { myVar: 'inherited' },
        },
        tmpDir,
      );
      expect(result.vars.myVar).toBe('inherited');
    });

    it('inherited ContextId survives discovered config override', async () => {
      const configDir = path.join(tmpDir, RUNDOWN_DIR);
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, 'config.yaml'), 'ContextId: config123\n');

      const result = await resolveVariables(
        {
          inheritedVars: { ContextId: 'parent123' },
        },
        tmpDir,
      );
      expect(result.vars.ContextId).toBe('parent123');
    });

    it('inherited ContextId survives when child has no override', async () => {
      const result = await resolveVariables(
        {
          inheritedVars: { ContextId: 'parent123' },
        },
        tmpDir,
      );
      expect(result.vars.ContextId).toBe('parent123');
    });
  });

  describe('precedence', () => {
    it('flag file sources override input-file file sources', async () => {
      const fileA = path.join(tmpDir, 'a.jsonl');
      const fileB = path.join(tmpDir, 'b.jsonl');
      await fs.writeFile(fileA, '{"from":"a"}\n');
      await fs.writeFile(fileB, '{"from":"b"}\n');

      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, `items: "file:${fileA}"\n`);

      const result = await resolveVariables(
        { inputFile: ['vars.yaml'], input: [`items=file:${fileB}`] },
        tmpDir,
      );
      expect(isJsonArrayStream(result.vars.items)).toBe(true);
      expect(result.vars.items).toMatchObject({
        kind: 'json-array-stream',
        path: await fs.realpath(fileB),
      });
    });
  });

  describe('artifact provenance', () => {
    it('marks exact artifact URI from --artifacts as trusted', async () => {
      const row = appendManagedManifestRow();

      const result = await resolveVariables({ artifacts: [`Plan=${row.uri}`] }, tmpDir);

      expect(result.vars.Plan).toMatchObject({ kind: 'artifact-record', uri: row.uri });
      expect(isTrustedArtifactRecord(result.vars.Plan)).toBe(true);
    });

    it('clean break: an rd:// URI via --input is a plain string (not rehydrated)', async () => {
      const row = appendManagedManifestRow();

      const result = await resolveVariables({ input: [`Plan=${row.uri}`] }, tmpDir);

      expect(result.vars.Plan).toBe(row.uri);
      expect(isTrustedArtifactRecord(result.vars.Plan)).toBe(false);
    });

    it('marks exact artifact URI arrays from --artifacts-json as trusted', async () => {
      const first = appendManagedManifestRow('context-a', 'a.json');
      const second = appendManagedManifestRow('context-a', 'b.json');

      const result = await resolveVariables(
        { artifactsJson: [`Plans=${JSON.stringify([first.uri, second.uri])}`] },
        tmpDir,
      );

      expect(result.vars.Plans).toEqual([
        expect.objectContaining({ kind: 'artifact-record', uri: first.uri }),
        expect.objectContaining({ kind: 'artifact-record', uri: second.uri }),
      ]);
      expect(isTrustedArtifactArray(result.vars.Plans)).toBe(true);
    });

    it('clean break: --input-file no longer rehydrates an artifact-shaped value (no --artifacts-file)', async () => {
      // There is intentionally no --artifacts-file (deferred). Under the clean
      // break, an artifact-shaped value supplied via --input-file routes on the
      // variable channel and is NOT branded — forgery is no longer checked here.
      const row = appendManagedManifestRow('producer-context', 'plan.json');
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(
        varFile,
        [
          'Plan:',
          '  kind: artifact-record',
          `  uri: ${row.uri}`,
          '  runId: rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          '  contextId: forged-context',
          '  key: forged.json',
          '  timestamp: 2026-05-26T00:00:00.000Z',
        ].join('\n'),
      );

      const result = await resolveVariables({ inputFile: ['vars.yaml'] }, tmpDir);

      expect(isTrustedArtifactRecord(result.vars.Plan)).toBe(false);
    });

    it('clean break: discovered config no longer rehydrates an rd:// URI', async () => {
      const row = appendManagedManifestRow();
      const configDir = path.join(tmpDir, RUNDOWN_DIR);
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, 'config.yaml'), `Plan: ${row.uri}\n`);

      const result = await resolveVariables({}, tmpDir);

      expect(result.vars.Plan).toBe(row.uri);
      expect(isTrustedArtifactRecord(result.vars.Plan)).toBe(false);
    });

    it('clean break: a raw rd:// URI inherited from a parent is a plain string', async () => {
      const row = appendManagedManifestRow();

      const result = await resolveVariables({ inheritedVars: { Plan: row.uri } }, tmpDir);

      expect(result.vars.Plan).toBe(row.uri);
      expect(isTrustedArtifactRecord(result.vars.Plan)).toBe(false);
    });

    it('clears artifact trust when a higher-precedence scalar overrides a trusted URI', async () => {
      const row = appendManagedManifestRow();
      const configDir = path.join(tmpDir, RUNDOWN_DIR);
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, 'config.yaml'), `Plan: ${row.uri}\n`);

      const result = await resolveVariables({ input: ['Plan=plain-value'] }, tmpDir);

      expect(result.vars.Plan).toBe('plain-value');
      expect(isTrustedArtifactRecord(result.vars.Plan)).toBe(false);
    });

    it('clean break: an rd:// URI from RD_INPUT is a plain string (not rehydrated)', async () => {
      const row = appendManagedManifestRow();
      const previous = process.env.RD_INPUT_Plan;
      process.env.RD_INPUT_Plan = row.uri;

      try {
        const result = await resolveVariables({}, tmpDir);

        expect(result.vars.Plan).toBe(row.uri);
        expect(isTrustedArtifactRecord(result.vars.Plan)).toBe(false);
      } finally {
        if (previous === undefined) {
          delete process.env.RD_INPUT_Plan;
        } else {
          process.env.RD_INPUT_Plan = previous;
        }
      }
    });
  });

  describe('artifact channel layering', () => {
    it('emits a separate artifact layer with channel "artifact"', async () => {
      const row = appendManagedManifestRow('producer-context', 'PlanPath');
      const resolved = await resolveVariables({ artifacts: [`PlanPath=${row.uri}`] }, tmpDir);
      // The trusted artifact record is the observable signature of the artifact
      // channel: only the artifact-channel layer rehydrates an rd:// URI into a
      // trusted record. A variable-channel value never does (see clean-break test).
      expect(isTrustedArtifactRecord(resolved.vars.PlanPath)).toBe(true);
    });

    it('tags every non-artifact layer as channel "variable"', async () => {
      const resolved = await resolveVariables({ input: ['name=value'] }, tmpDir);
      expect(resolved.vars.name).toBe('value');
      // Variable channel never produces a trusted artifact record — the inverse of
      // the artifact-channel assertion above, proving the layer was tagged "variable".
      expect(isTrustedArtifactRecord(resolved.vars.name)).toBe(false);
    });

    it('rejects a name supplied through both the variable and artifact channels', async () => {
      const row = appendManagedManifestRow('producer-context', 'PlanPath');
      // Cross-channel collision can only fire if the layers carry distinct channel
      // tags — a direct assertion that variable vs artifact layering is correct.
      await expect(
        resolveVariables({ input: ['PlanPath=plain'], artifacts: [`PlanPath=${row.uri}`] }, tmpDir),
      ).rejects.toThrow(/both the variable and artifact channels/);
    });

    it('reframes a malformed --artifacts-json value as a defensive invariant breach', async () => {
      // The argParser validates JSON before resolution; if a malformed value reaches
      // collectArtifactFlags the raw SyntaxError must be reframed as the defensive
      // guard, consistent with its sibling key/entry guards.
      await expect(resolveVariables({ artifactsJson: ['ok=not json'] }, tmpDir)).rejects.toThrow(
        /parser should have rejected this/,
      );
    });
  });

  describe('cross-source conflicts', () => {
    it('flag scalar overrides input-file array source', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'servers:\n  - alpha\n  - beta\n');

      const result = await resolveVariables(
        { inputFile: ['vars.yaml'], input: ['servers=prod'] },
        tmpDir,
      );
      expect(result.vars.servers).toBe('prod');
    });

    it('flag file: source overrides input-file array source', async () => {
      const dataFile = path.join(tmpDir, 'data.jsonl');
      await fs.writeFile(dataFile, '{"x":1}\n');
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'items:\n  - x\n  - y\n');

      const result = await resolveVariables(
        { inputFile: ['vars.yaml'], input: [`items=file:${dataFile}`] },
        tmpDir,
      );
      expect(isJsonArrayStream(result.vars.items)).toBe(true);
      expect(result.vars.items).toMatchObject({
        kind: 'json-array-stream',
        path: await fs.realpath(dataFile),
      });
    });

    it('input-file array overrides discovered config scalar', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'servers:\n  - a\n  - b\n');

      const configDir = path.join(tmpDir, RUNDOWN_DIR);
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, 'config.yaml'), 'servers: single\n');

      const result = await resolveVariables({ inputFile: ['vars.yaml'] }, tmpDir);
      expect(result.vars.servers).toEqual(['a', 'b']);
    });

    it('deterministic outcome: input-file scalar clears config array source', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'items: override\n');

      const configDir = path.join(tmpDir, RUNDOWN_DIR);
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, 'config.yaml'), 'items:\n  - x\n  - "y"\n');

      const result = await resolveVariables({ inputFile: ['vars.yaml'] }, tmpDir);
      expect(result.vars.items).toBe('override');
    });

    it('flag scalar overrides input-file multiline source', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'log: |\n  line1\n  line2\n');

      const result = await resolveVariables(
        { inputFile: ['vars.yaml'], input: ['log=override'] },
        tmpDir,
      );
      expect(result.vars.log).toBe('override');
    });
  });

  describe('file source sandbox check', () => {
    it('rejects sibling directory path (prefix bypass)', async () => {
      // cwd=/repo should reject /repo2/data.txt
      const cwd = path.join(tmpDir, 'repo');
      await fs.mkdir(cwd, { recursive: true });

      const siblingDir = path.join(tmpDir, 'repo2');
      await fs.mkdir(siblingDir, { recursive: true });
      const siblingFile = path.join(siblingDir, 'data.txt');
      await fs.writeFile(siblingFile, 'evil\n');

      const result = await resolveVariables({ input: [`data=file:${siblingFile}`] }, cwd);
      expect(result.vars).not.toHaveProperty('data');
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('path escapes project directory')]),
      );
    });

    it('accepts file within subdirectory', async () => {
      const sub = path.join(tmpDir, 'sub');
      await fs.mkdir(sub, { recursive: true });
      const file = path.join(sub, 'data.json');
      await fs.writeFile(file, '["ok"]');

      const result = await resolveVariables({ input: [`data=file:${file}`] }, tmpDir);
      expect(result.vars.data).toEqual(['ok']);
    });

    it('rejects path traversal via ../', async () => {
      const nested = path.join(tmpDir, 'project');
      await fs.mkdir(nested, { recursive: true });

      const result = await resolveVariables({ input: ['data=file:../escape.txt'] }, nested);
      expect(result.vars).not.toHaveProperty('data');
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('path escapes project directory')]),
      );
    });

    it('does not include rejected path-traversal file source in providedKeys', async () => {
      const nested = path.join(tmpDir, 'project');
      await fs.mkdir(nested, { recursive: true });

      const result = await resolveVariables({ input: ['data=file:../escape.txt'] }, nested);
      expect(result.vars).not.toHaveProperty('data');
      expect(result.providedKeys.has('data')).toBe(false);
    });

    it('does not count a rejected external value when a builtin already exists', async () => {
      const nested = path.join(tmpDir, 'project');
      await fs.mkdir(nested, { recursive: true });

      const result = await resolveVariables({ input: ['Date=file:../escape.txt'] }, nested);
      expect(result.vars).toHaveProperty('Date');
      expect(result.providedKeys.has('Date')).toBe(false);
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('path escapes project directory')]),
      );
    });

    it('includes accepted file source in providedKeys', async () => {
      const file = path.join(tmpDir, 'data.json');
      await fs.writeFile(file, '["ok"]');

      const result = await resolveVariables({ input: [`data=file:${file}`] }, tmpDir);
      expect(result.vars.data).toEqual(['ok']);
      expect(result.providedKeys.has('data')).toBe(true);
    });

    it('accepts directory whose name starts with double-dot', async () => {
      const dotDir = path.join(tmpDir, '..cache');
      await fs.mkdir(dotDir, { recursive: true });
      const file = path.join(dotDir, 'data.json');
      await fs.writeFile(file, '["ok"]');

      const result = await resolveVariables({ input: [`data=file:${file}`] }, tmpDir);
      expect(result.vars.data).toEqual(['ok']);
    });

    it('throws when policy denies a file-backed source', async () => {
      const file = path.join(tmpDir, '.env');
      await fs.writeFile(file, 'SECRET=value\n');

      const checkPath = mockFn<CheckPathFn>();
      checkPath.mockReturnValue({
        allowed: false,
        requiresPrompt: false,
        reason: 'Path blocked by policy',
      });
      await expect(
        resolveVariables({ input: [`data=file:${file}`] }, tmpDir, {
          evaluator: { checkPath } as unknown as PolicyEvaluator,
        }),
      ).rejects.toBeInstanceOf(FileSourcePolicyError);
    });

    it('prompts for file-backed sources when policy requires confirmation', async () => {
      const file = path.join(tmpDir, 'prompted.jsonl');
      await fs.writeFile(file, '{"ok":true}\n');
      const checkPath = mockFn<CheckPathFn>();
      checkPath.mockReturnValue({
        allowed: false,
        requiresPrompt: true,
        reason: 'Prompt before read',
      });
      const evaluator = { checkPath };
      const requestPermission = mockFn<RequestPermissionFn>();
      requestPermission.mockResolvedValue({ granted: true, persist: false });
      const prompter = { requestPermission };

      const result = await resolveVariables({ input: [`data=file:${file}`] }, tmpDir, {
        evaluator: evaluator as unknown as PolicyEvaluator,
        prompter: prompter as unknown as PolicyPrompter,
      });

      expect(prompter.requestPermission).toHaveBeenCalledWith(
        'read',
        await fs.realpath(file),
        'Prompt before read',
      );
      expect(isJsonArrayStream(result.vars.data)).toBe(true);
      expect(result.vars.data).toMatchObject({
        kind: 'json-array-stream',
        path: await fs.realpath(file),
      });
    });

    it('fails cleanly when a promptable file-backed source has no prompter', async () => {
      const file = path.join(tmpDir, 'prompted-no-ui.txt');
      await fs.writeFile(file, 'ok\n');

      const checkPath = mockFn<CheckPathFn>();
      checkPath.mockReturnValue({
        allowed: false,
        requiresPrompt: true,
        reason: 'Prompt before read',
      });
      await expect(
        resolveVariables({ input: [`data=file:${file}`] }, tmpDir, {
          evaluator: { checkPath } as unknown as PolicyEvaluator,
        }),
      ).rejects.toThrow('Prompt before read');
    });
  });

  describe('collectEnvBridgeVars (via resolveVariables)', () => {
    let originalRdInputEnv = new Map<string, string | undefined>();

    beforeEach(() => {
      originalRdInputEnv = new Map(
        Object.entries(process.env).filter(([key]) => key.startsWith('RD_INPUT_')),
      );
    });

    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('RD_INPUT_') && !originalRdInputEnv.has(key)) {
          delete process.env[key];
        }
      }

      for (const [key, value] of originalRdInputEnv) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });

    it('collects RD_INPUT_foo=bar as variable foo with value bar', async () => {
      process.env.RD_INPUT_foo = 'bar';

      const result = await resolveVariables({}, tmpDir);

      expect(result.vars.foo).toBe('bar');
    });

    it('does not collect environment variables without the RD_INPUT_ prefix', async () => {
      const previous = process.env.NOT_RD_INPUT_secret;
      process.env.NOT_RD_INPUT_secret = 'leak';

      try {
        const result = await resolveVariables({}, tmpDir);

        expect(result.vars.secret).toBeUndefined();
        expect(result.vars.NOT_RD_INPUT_secret).toBeUndefined();
        expect(result.providedKeys.has('secret')).toBe(false);
        expect(result.providedKeys.has('NOT_RD_INPUT_secret')).toBe(false);
      } finally {
        if (previous === undefined) {
          delete process.env.NOT_RD_INPUT_secret;
        } else {
          process.env.NOT_RD_INPUT_secret = previous;
        }
      }
    });

    it('ignores RD_INPUT_ with invalid identifier suffix and produces warning', async () => {
      process.env.RD_INPUT_1bad = 'value';

      const result = await resolveVariables({}, tmpDir);

      expect(result.vars['1bad']).toBeUndefined();
      expect(result.warnings.some((w) => w.includes('1bad'))).toBe(true);
    });

    it('reports the exact invalid identifier warning for RD_INPUT_* keys', async () => {
      process.env.RD_INPUT_1bad = 'value';

      const result = await resolveVariables({}, tmpDir);

      expect(result.vars['1bad']).toBeUndefined();
      expect(result.providedKeys.has('1bad')).toBe(false);
      expect(result.warnings).toContain(
        'Ignoring env RD_INPUT_1bad: "1bad" is not a valid identifier',
      );
    });

    it('ignores RD_INPUT_step and produces warning instead of throwing', async () => {
      process.env.RD_INPUT_step = 'from-env';

      const result = await resolveVariables({}, tmpDir);

      expect(result.vars.step).toBeUndefined();
      expect(
        result.warnings.some((w) => w.includes('RD_INPUT_step') && w.includes('reserved')),
      ).toBe(true);
    });

    it('reports the exact reserved variable warning for RD_INPUT_* keys', async () => {
      process.env.RD_INPUT_step = 'from-env';

      const result = await resolveVariables({}, tmpDir);

      expect(result.vars.step).toBeUndefined();
      expect(result.providedKeys.has('step')).toBe(false);
      expect(result.warnings).toContain(
        'Ignoring env RD_INPUT_step: "step" is a reserved runtime variable',
      );
    });

    it('ignores reserved names case-insensitively in RD_INPUT_* bridge', async () => {
      process.env.RD_INPUT_Step = 'from-env';

      const result = await resolveVariables({}, tmpDir);

      expect(result.vars.Step).toBeUndefined();
      expect(
        result.warnings.some((w) => w.includes('RD_INPUT_Step') && w.includes('reserved')),
      ).toBe(true);
    });

    it('--input-file overrides RD_INPUT_* for same key', async () => {
      process.env.RD_INPUT_message = 'from-env';
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'message: from-file\n');

      const result = await resolveVariables({ inputFile: ['vars.yaml'] }, tmpDir);

      expect(result.vars.message).toBe('from-file');
    });

    it('RD_INPUT_* overrides config discovery for same key', async () => {
      process.env.RD_INPUT_greeting = 'from-env';
      const configDir = path.join(tmpDir, RUNDOWN_DIR);
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, 'config.yaml'), 'greeting: from-config\n');

      const result = await resolveVariables({}, tmpDir);

      expect(result.vars.greeting).toBe('from-env');
    });

    it('--input flag overrides RD_INPUT_* for same key', async () => {
      process.env.RD_INPUT_message = 'from-env';

      const result = await resolveVariables({ input: ['message=from-flag'] }, tmpDir);

      expect(result.vars.message).toBe('from-flag');
    });
  });

  describe('repeatable --input-file', () => {
    it('merges multiple files with non-overlapping keys', async () => {
      const fileA = path.join(tmpDir, 'a.yaml');
      const fileB = path.join(tmpDir, 'b.yaml');
      await fs.writeFile(fileA, 'alpha: one\n');
      await fs.writeFile(fileB, 'beta: two\n');

      const result = await resolveVariables({ inputFile: ['a.yaml', 'b.yaml'] }, tmpDir);

      expect(result.vars.alpha).toBe('one');
      expect(result.vars.beta).toBe('two');
    });

    it('later file wins for overlapping keys', async () => {
      const fileA = path.join(tmpDir, 'a.yaml');
      const fileB = path.join(tmpDir, 'b.yaml');
      await fs.writeFile(fileA, 'shared: from-a\n');
      await fs.writeFile(fileB, 'shared: from-b\n');

      const result = await resolveVariables({ inputFile: ['a.yaml', 'b.yaml'] }, tmpDir);

      expect(result.vars.shared).toBe('from-b');
    });

    it('single file in array works (backward compatibility)', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'greeting: hello\n');

      const result = await resolveVariables({ inputFile: ['vars.yaml'] }, tmpDir);

      expect(result.vars.greeting).toBe('hello');
    });

    it('empty array produces no file vars', async () => {
      const result = await resolveVariables({ inputFile: [] }, tmpDir);

      // Only built-in vars should be present
      expect(result.vars).toHaveProperty('Date');
      expect(result.vars).not.toHaveProperty('any_file_var');
    });
  });

  describe('providedKeys provenance', () => {
    it('tracks user-provided layers and excludes builtins', async () => {
      const previous = process.env.RD_INPUT_envProvided;
      process.env.RD_INPUT_envProvided = 'from-env';
      const configDir = path.join(tmpDir, RUNDOWN_DIR);
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, 'config.yaml'), 'configProvided: from-config\n');

      try {
        const result = await resolveVariables(
          {
            inheritedVars: { inheritedProvided: 'from-parent' },
            input: ['cliProvided=from-cli'],
          },
          tmpDir,
        );

        expect(result.providedKeys.has('configProvided')).toBe(true);
        expect(result.providedKeys.has('inheritedProvided')).toBe(true);
        expect(result.providedKeys.has('envProvided')).toBe(true);
        expect(result.providedKeys.has('cliProvided')).toBe(true);
        expect(result.providedKeys.has('Date')).toBe(false);
        expect(result.providedKeys.has('ContextId')).toBe(false);
      } finally {
        if (previous === undefined) {
          delete process.env.RD_INPUT_envProvided;
        } else {
          process.env.RD_INPUT_envProvided = previous;
        }
      }
    });
  });

  describe('--input-json', () => {
    it('array value stored as JsonArray in vars', async () => {
      const result = await resolveVariables({ inputJson: ['items=["a","b","c"]'] }, tmpDir);

      expect(result.vars.items).toEqual(['a', 'b', 'c']);
    });

    it('object value is preserved as JsonObject', async () => {
      const result = await resolveVariables({ inputJson: ['config={"host":"localhost"}'] }, tmpDir);

      expect(result.vars.config).toEqual({ host: 'localhost' });
      expect(result.warnings).toHaveLength(0);
    });

    it('number value is preserved as number', async () => {
      const result = await resolveVariables({ inputJson: ['count=42'] }, tmpDir);

      expect(result.vars.count).toBe(42);
    });

    it('boolean value produces string var', async () => {
      const result = await resolveVariables({ inputJson: ['debug=true'] }, tmpDir);

      expect(result.vars.debug).toBe('true');
    });

    it('string value produces string var', async () => {
      const result = await resolveVariables({ inputJson: ['name="hello"'] }, tmpDir);

      expect(result.vars.name).toBe('hello');
    });

    it('--input-json overrides --input for same key', async () => {
      const result = await resolveVariables(
        { input: ['count=10'], inputJson: ['count=99'] },
        tmpDir,
      );

      // inputJson is processed after input in collectRawLayers, so it wins
      expect(result.vars.count).toBe(99);
    });

    it('empty object is preserved', async () => {
      const result = await resolveVariables({ inputJson: ['config={}'] }, tmpDir);

      expect(result.vars.config).toEqual({});
      expect(result.warnings).toHaveLength(0);
    });

    it('deeply nested object is preserved', async () => {
      const result = await resolveVariables({ inputJson: ['config={"a":{"b":{"c":1}}}'] }, tmpDir);

      expect(result.vars.config).toEqual({ a: { b: { c: 1 } } });
    });

    it('object with array field is preserved', async () => {
      const result = await resolveVariables({ inputJson: ['config={"items":["a","b"]}'] }, tmpDir);

      expect(result.vars.config).toEqual({ items: ['a', 'b'] });
    });

    it('null value is stringified', async () => {
      const result = await resolveVariables({ inputJson: ['val=null'] }, tmpDir);

      expect(result.vars.val).toBe('null');
    });

    it('does not route crafted json-array-stream shape as JsonArrayStream (brand check)', async () => {
      // Attack: --var-json 'items={"kind":"json-array-stream","path":"/etc/passwd"}'
      // routeVariable stores it as JsonObject (no file: prefix path validation runs).
      // isJsonArrayStream must return false — no Symbol brand present.
      const result = await resolveVariables(
        { inputJson: ['items={"kind":"json-array-stream","path":"/etc/passwd"}'] },
        tmpDir,
      );
      const value = result.vars.items;
      expect(value).toBeDefined();
      expect(isJsonArrayStream(value)).toBe(false);
    });

    it('full attack path: FOR loop throws type-mismatch, never reads the file', async () => {
      // End-to-end: the crafted value enters vars as JsonObject. resolveForValue calls
      // the isJsonArrayStream guard in resolveForValue's 'variable' case, which returns
      // false (no brand Symbol), and execution falls to the type-mismatch throw before
      // resolveFromJsonArrayStream is entered — the file is never opened.
      const result = await resolveVariables(
        { inputJson: ['items={"kind":"json-array-stream","path":"/etc/passwd"}'] },
        tmpDir,
      );
      expect(result.vars.items).toBeDefined();
      const forCtx: ForContext = {
        stepId: '1',
        iteration: 1,
        start: 1,
        implicit: false,
        source: { kind: 'variable', name: 'items' },
      };
      // Must reject with the type-mismatch error, never reach file-read dispatch
      await expect(
        resolveForValue(forCtx, brandEffectiveVarsForTest(result.vars)),
      ).rejects.toMatchObject({
        code: 'type-mismatch',
      });
    });

    it('non-finite numbers are stringified with warning', async () => {
      // YAML .inf/-.inf/.nan produce non-finite JS numbers that break JSON.stringify
      const configPath = path.join(tmpDir, RUNDOWN_DIR, 'config.yaml');
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, 'timeout: .inf\nretries: .nan\n');

      const result = await resolveVariables({}, tmpDir);

      expect(result.vars.timeout).toBe('Infinity');
      expect(result.vars.retries).toBe('NaN');
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('non-finite'),
          expect.stringContaining('non-finite'),
        ]),
      );
    });
  });
});

describe('routeExtraVars', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'route-extra-vars-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('routes arrays to vars as JsonArray', async () => {
    const result = await routeExtraVars({ items: ['a', 'b', 'c'] }, tmpDir);
    expect(result.vars.items).toEqual(['a', 'b', 'c']);
    expect(result.warnings).toHaveLength(0);
  });

  it('preserves object values as JsonObject', async () => {
    const result = await routeExtraVars({ config: { nested: true } }, tmpDir);
    expect(result.vars.config).toEqual({ nested: true });
    expect(result.warnings).toHaveLength(0);
  });

  it('preserves numbers and stringifies booleans', async () => {
    const result = await routeExtraVars({ port: 8080, debug: true, name: 'test' }, tmpDir);
    expect(result.vars.port).toBe(8080);
    expect(result.vars.debug).toBe('true');
    expect(result.vars.name).toBe('test');
    expect(result.warnings).toHaveLength(0);
  });

  it('warns and skips reserved runtime variables', async () => {
    const result = await routeExtraVars({ step: '5', env: 'prod' }, tmpDir);
    expect(result.vars.step).toBeUndefined();
    expect(result.vars.env).toBe('prod');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('reserved');
  });

  it('routes file:.jsonl values to vars as JsonArrayStream', async () => {
    const dataFile = path.join(tmpDir, 'data.jsonl');
    await fs.writeFile(dataFile, '{"a":1}\n{"b":2}\n');

    const result = await routeExtraVars({ items: `file:${dataFile}` }, tmpDir);
    expect(isJsonArrayStream(result.vars.items)).toBe(true);
    expect(result.vars.items).toMatchObject({
      kind: 'json-array-stream',
      path: expect.any(String),
    });
    expect(result.warnings).toHaveLength(0);
  });

  it('routes YAML file array values through routeExtraVars as JsonArray', async () => {
    const varFile = path.join(tmpDir, 'vars.yaml');
    await fs.writeFile(varFile, 'items:\n  - x\n  - "y"\n  - z\n');

    const loaded = await loadVariablesFromFile(varFile, { normalize: false });
    const result = await routeExtraVars(loaded, tmpDir);

    expect(result.vars.items).toEqual(['x', 'y', 'z']);
    expect(result.warnings).toHaveLength(0);
  });

  it.each([
    '__proto__',
    'constructor',
    'prototype',
  ])('drops poisoned key %s with warning', async (key) => {
    const result = await routeExtraVars({ [key]: 'injected' }, tmpDir);
    expect(Object.hasOwn(result.vars, key)).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('invalid key');
  });
});

describe('collectCliFlags', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'collect-cli-flags-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('collects --input flags', async () => {
    const result = await collectCliFlags({ input: ['env=staging', 'port=3000'] }, tmpDir);
    expect(result).toEqual({ env: 'staging', port: '3000' });
  });

  it('collects --input-json flags', async () => {
    const result = await collectCliFlags({ inputJson: ['items=["a","b"]'] }, tmpDir);
    expect(result).toEqual({ items: ['a', 'b'] });
  });

  it('collects --input-file contents', async () => {
    const varFile = path.join(tmpDir, 'vars.yaml');
    await fs.writeFile(varFile, 'greeting: hello\ncount: 42\n');

    const result = await collectCliFlags({ inputFile: ['vars.yaml'] }, tmpDir);
    expect(result).toEqual({ greeting: 'hello', count: 42 });
  });

  it('collects project-relative --input-file contents', async () => {
    const varFile = path.join(tmpDir, 'vars.yaml');
    await fs.writeFile(varFile, 'greeting: hello\n');

    const result = await collectCliFlags({ inputFile: ['vars.yaml'] }, tmpDir);
    expect(result).toEqual({ greeting: 'hello' });
  });

  it('rejects absolute --input-file paths outside the project root', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'collect-cli-flags-outside-'));
    const outsideFile = path.join(outsideDir, 'vars.yaml');
    await fs.writeFile(outsideFile, 'secret: leaked\n');

    try {
      await expect(collectCliFlags({ inputFile: [outsideFile] }, tmpDir)).rejects.toThrow(
        /--input-file path must be relative to the project directory/,
      );
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects absolute --input-file paths inside the project root', async () => {
    const varFile = path.join(tmpDir, 'vars.yaml');
    await fs.writeFile(varFile, 'greeting: hello\n');

    await expect(collectCliFlags({ inputFile: [varFile] }, tmpDir)).rejects.toThrow(
      /--input-file path must be relative to the project directory/,
    );
  });

  it('rejects relative --input-file traversal outside the project root', async () => {
    const parentFile = path.join(path.dirname(tmpDir), 'vars.yaml');
    await fs.writeFile(parentFile, 'secret: leaked\n');

    try {
      await expect(collectCliFlags({ inputFile: ['../vars.yaml'] }, tmpDir)).rejects.toThrow(
        /--input-file path escapes project directory/,
      );
    } finally {
      await fs.rm(parentFile, { force: true });
    }
  });

  it('rejects symlinked --input-file paths that resolve outside the project root', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'collect-cli-flags-outside-'));
    const outsideFile = path.join(outsideDir, 'vars.yaml');
    const linkPath = path.join(tmpDir, 'linked-vars.yaml');
    await fs.writeFile(outsideFile, 'secret: leaked\n');
    await fs.symlink(outsideFile, linkPath);

    try {
      await expect(collectCliFlags({ inputFile: ['linked-vars.yaml'] }, tmpDir)).rejects.toThrow(
        /--input-file path escapes project directory/,
      );
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects missing --input-file paths', async () => {
    await expect(collectCliFlags({ inputFile: ['missing.yaml'] }, tmpDir)).rejects.toThrow(
      /ENOENT/,
    );
  });

  it('preserves nested project-relative path when --input-file is missing', async () => {
    await expect(collectCliFlags({ inputFile: ['missing/vars.yaml'] }, tmpDir)).rejects.toThrow(
      /missing\/vars\.yaml/,
    );
  });

  it('rejects invalid --input entries that bypass option parsing', async () => {
    await expect(collectCliFlags({ input: ['not-key-value'] }, tmpDir)).rejects.toThrow(
      'Unexpected invalid --input entry: not-key-value',
    );
  });

  it('rejects invalid --input-json keys that bypass option parsing', async () => {
    await expect(collectCliFlags({ inputJson: ['1bad=42'] }, tmpDir)).rejects.toThrow(
      'Unexpected invalid --input-json key: 1bad',
    );
  });

  it('preserves precedence: input-json > input > input-file', async () => {
    const varFile = path.join(tmpDir, 'vars.yaml');
    await fs.writeFile(varFile, 'key: from-file\n');

    const result = await collectCliFlags(
      { inputFile: ['vars.yaml'], input: ['key=from-var'], inputJson: ['key="from-json"'] },
      tmpDir,
    );
    expect(result.key).toBe('from-json');
  });

  it('returns empty object when no flags provided', async () => {
    const result = await collectCliFlags({}, tmpDir);
    expect(result).toEqual({});
  });
});
