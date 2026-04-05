import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  discoverVariables,
  FileSourcePolicyError,
  findConfigFile,
  parseVarFlag,
  loadVariablesFromFile,
  getBuiltinVariables,
  resolveVariables,
  routeExtraVars,
  collectCliFlags,
  sanitizeBranchName,
  setExecFileSyncImpl,
} from '../../src/services/variable-discovery.js';
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

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
    expect(builtins).toHaveProperty('RunId');
    expect(builtins).toHaveProperty('ContextId');
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

  it('should return WorkPath starting with .work', () => {
    const builtins = getBuiltinVariables();

    expect(builtins.WorkPath).toMatch(/^\.work/);
  });

  it('should return Branch property', () => {
    const builtins = getBuiltinVariables();

    expect(builtins).toHaveProperty('Branch');
  });

  it('should include sanitized branch in WorkPath when in git repo', () => {
    setExecFileSyncImpl((() => 'feature/my-branch\n') as typeof nodeExecFileSync);

    const builtins = getBuiltinVariables();
    expect(builtins.WorkPath).toBe('.work/feature-my-branch');
    expect(builtins.Branch).toBe('feature/my-branch');
  });

  it('should fall back to .work when not in git', () => {
    setExecFileSyncImpl((() => {
      throw new Error('not a git repo');
    }) as typeof nodeExecFileSync);

    const builtins = getBuiltinVariables();
    expect(builtins.WorkPath).toBe('.work');
    expect(builtins.Branch).toBe('');
  });

  it('should fall back to .work on detached HEAD', () => {
    setExecFileSyncImpl((() => 'HEAD\n') as typeof nodeExecFileSync);

    const builtins = getBuiltinVariables();
    expect(builtins.WorkPath).toBe('.work');
    expect(builtins.Branch).toBe('');
  });

  it('should return RunId as alphanumeric string', () => {
    const builtins = getBuiltinVariables();

    expect(builtins).toHaveProperty('RunId');
    expect(builtins.RunId).toMatch(/^[a-f0-9]+$/);
    expect(builtins.RunId).toHaveLength(8);
  });

  it('should return unique RunId across calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => getBuiltinVariables().RunId));
    expect(ids.size).toBeGreaterThan(90);
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
    const rundownDir = path.join(tmpDir, '.rundown');
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
    const rundownDir = path.join(tmpDir, '.rundown');
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
    const parentRundownDir = path.join(tmpDir, '.rundown');
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
    const rundownDir = path.join(tmpDir, '.rundown');
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
    const rundownDir = path.join(tmpDir, '.rundown');
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
    const parentRundownDir = path.join(parentDir, '.rundown');
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

  describe('scalar routing', () => {
    it('routes --var scalar to vars only', async () => {
      const result = await resolveVariables({ var: ['env=staging'] }, tmpDir);
      expect(result.vars.env).toBe('staging');
    });
  });

  describe('frontmatter vars', () => {
    it('uses pre-extracted frontmatterVars', async () => {
      const result = await resolveVariables(
        { frontmatterVars: { greeting: 'Hello', count: 42 } },
        tmpDir,
      );
      expect(result.vars.greeting).toBe('Hello');
      expect(result.vars.count).toBe(42);
    });

    it('returns no frontmatter vars when frontmatterVars is undefined', async () => {
      const result = await resolveVariables({}, tmpDir);
      // Only built-in vars should be present
      expect(result.vars.greeting).toBeUndefined();
    });

    it('CLI --var overrides frontmatter vars', async () => {
      const result = await resolveVariables(
        { frontmatterVars: { env: 'development' }, var: ['env=production'] },
        tmpDir,
      );
      expect(result.vars.env).toBe('production');
    });
  });

  describe('reserved runtime keys', () => {
    it('rejects reserved keys with an error', async () => {
      await expect(resolveVariables({ var: ['Step=shadow'] }, tmpDir)).rejects.toThrow(
        /reserved runtime variable/i,
      );
    });

    it('rejects reserved keys case-insensitively', async () => {
      await expect(resolveVariables({ var: ['INDEX=9'] }, tmpDir)).rejects.toThrow(
        /reserved runtime variable/i,
      );
    });

    it('reports all reserved key violations in a single error', async () => {
      const error = await resolveVariables({ var: ['Step=a', 'Index=b'] }, tmpDir).catch(
        (e: unknown) => e,
      );
      expect(error.message).toMatch(/reserved runtime variables/i);
      expect(error.message).toContain('"Step"');
      expect(error.message).toContain('"Index"');
    });

    it('does not route non-reserved keys when layer contains a reserved violation', async () => {
      await expect(
        resolveVariables({ var: ['safe=value', 'Step=shadow'] }, tmpDir),
      ).rejects.toThrow(/reserved runtime variable/i);
    });

    it('allows non-reserved variables', async () => {
      const result = await resolveVariables({ var: ['env=staging'] }, tmpDir);
      expect(result.vars.env).toBe('staging');
    });
  });

  describe('file: prefix routing', () => {
    it('routes --var file:.json to vars as JsonObject', async () => {
      const file = path.join(tmpDir, 'servers.json');
      await fs.writeFile(file, '{"host":"server-a","port":3000}');

      const result = await resolveVariables({ var: [`servers=file:${file}`] }, tmpDir);
      expect(result.vars.servers).toEqual({ host: 'server-a', port: 3000 });
    });

    it('routes --var file:.json array to vars as JsonArray', async () => {
      const file = path.join(tmpDir, 'items.json');
      await fs.writeFile(file, '["a","b","c"]');

      const result = await resolveVariables({ var: [`items=file:${file}`] }, tmpDir);
      expect(result.vars.items).toEqual(['a', 'b', 'c']);
    });

    it('routes --var file:.jsonl to vars as JsonArrayStream', async () => {
      const file = path.join(tmpDir, 'data.jsonl');
      await fs.writeFile(file, '{"a":1}\n');

      const result = await resolveVariables({ var: [`data=file:${file}`] }, tmpDir);
      expect(result.vars.data).toEqual({
        kind: 'json-array-stream',
        path: await fs.realpath(file),
      });
    });

    it('resolves relative file: paths against cwd', async () => {
      const file = path.join(tmpDir, 'hosts.json');
      await fs.writeFile(file, '["h1"]');

      const result = await resolveVariables({ var: ['hosts=file:hosts.json'] }, tmpDir);
      expect(result.vars.hosts).toEqual(['h1']);
    });

    it('rejects unsupported file extensions', async () => {
      const file = path.join(tmpDir, 'data.txt');
      await fs.writeFile(file, 'content');

      await expect(resolveVariables({ var: [`data=file:${file}`] }, tmpDir)).rejects.toThrow(
        /Unsupported file extension/,
      );
    });
  });

  describe('YAML array routing', () => {
    it('routes YAML array to vars as JsonArray (type-preserving)', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'servers:\n  - alpha\n  - beta\n  - gamma\n');

      const result = await resolveVariables({ varFile: [varFile] }, tmpDir);
      expect(result.vars.servers).toEqual(['alpha', 'beta', 'gamma']);
    });
  });

  describe('YAML multiline string routing', () => {
    it('routes YAML multiline string to vars as plain string', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'log: |\n  line1\n  line2\n  line3\n');

      const result = await resolveVariables({ varFile: [varFile] }, tmpDir);
      // YAML block scalar with trailing newline stripped by YAML parser produces "line1\nline2\nline3\n"
      expect(typeof result.vars.log).toBe('string');
      expect((result.vars.log as string).includes('\n')).toBe(true);
    });
  });

  describe('YAML object routing', () => {
    it('preserves object values from --var-file', async () => {
      const tmpFile = path.join(tmpDir, 'objects.yaml');
      await fs.writeFile(tmpFile, 'config:\n  host: localhost\n  port: 3000\n');

      const result = await resolveVariables({ varFile: [tmpFile] }, tmpDir);

      expect(result.vars.config).toEqual({ host: 'localhost', port: 3000 });
    });

    it('stringifies YAML object with Date value and warns', async () => {
      const tmpFile = path.join(tmpDir, 'date-obj.yaml');
      // YAML parses unquoted timestamps as Date objects
      await fs.writeFile(tmpFile, 'event:\n  name: launch\n  date: 2026-03-20\n');

      const result = await resolveVariables({ varFile: [tmpFile] }, tmpDir);

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

      const result = await resolveVariables({ varFile: [tmpFile] }, tmpDir);

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

      const result = await resolveVariables({ varFile: [varFile] }, tmpDir);
      expect(result.vars.items).toEqual({
        kind: 'json-array-stream',
        path: await fs.realpath(dataFile),
      });
    });
  });

  describe('frontmatter routing', () => {
    // Frontmatter vars are typed Record<string, string | number | boolean> by the
    // parser's Zod schema — arrays are intentionally excluded. Array routing is
    // tested via config/var-file layers in the YAML array/multiline tests above.
    it('routes frontmatter scalar to vars only', async () => {
      const result = await resolveVariables({ frontmatterVars: { env: 'staging' } }, tmpDir);
      expect(result.vars.env).toBe('staging');
    });
  });

  describe('inherited vars', () => {
    it('inherited vars override builtins', async () => {
      const result = await resolveVariables({ inheritedVars: { ContextId: 'parent123' } }, tmpDir);
      expect(result.vars.ContextId).toBe('parent123');
    });

    it('frontmatter overrides inherited vars', async () => {
      const result = await resolveVariables(
        {
          inheritedVars: { myVar: 'inherited' },
          frontmatterVars: { myVar: 'frontmatter' },
        },
        tmpDir,
      );
      expect(result.vars.myVar).toBe('frontmatter');
    });

    it('inherited ContextId survives when child has no override', async () => {
      const result = await resolveVariables(
        {
          inheritedVars: { ContextId: 'parent123' },
          frontmatterVars: { otherVar: 'value' },
        },
        tmpDir,
      );
      expect(result.vars.ContextId).toBe('parent123');
    });
  });

  describe('precedence', () => {
    it('flag file sources override var-file file sources', async () => {
      const fileA = path.join(tmpDir, 'a.jsonl');
      const fileB = path.join(tmpDir, 'b.jsonl');
      await fs.writeFile(fileA, '{"from":"a"}\n');
      await fs.writeFile(fileB, '{"from":"b"}\n');

      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, `items: "file:${fileA}"\n`);

      const result = await resolveVariables(
        { varFile: [varFile], var: [`items=file:${fileB}`] },
        tmpDir,
      );
      expect(result.vars.items).toEqual({
        kind: 'json-array-stream',
        path: await fs.realpath(fileB),
      });
    });
  });

  describe('cross-source conflicts', () => {
    it('flag scalar overrides var-file array source', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'servers:\n  - alpha\n  - beta\n');

      const result = await resolveVariables({ varFile: [varFile], var: ['servers=prod'] }, tmpDir);
      expect(result.vars.servers).toBe('prod');
    });

    it('flag file: source overrides var-file array source', async () => {
      const dataFile = path.join(tmpDir, 'data.jsonl');
      await fs.writeFile(dataFile, '{"x":1}\n');
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'items:\n  - x\n  - y\n');

      const result = await resolveVariables(
        { varFile: [varFile], var: [`items=file:${dataFile}`] },
        tmpDir,
      );
      expect(result.vars.items).toEqual({
        kind: 'json-array-stream',
        path: await fs.realpath(dataFile),
      });
    });

    it('var-file array overrides frontmatter scalar', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'servers:\n  - a\n  - b\n');

      const result = await resolveVariables(
        { frontmatterVars: { servers: 'single' }, varFile: [varFile] },
        tmpDir,
      );
      expect(result.vars.servers).toEqual(['a', 'b']);
    });

    it('deterministic outcome: var-file scalar clears config array source', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'items: override\n');

      const configDir = path.join(tmpDir, '.rundown');
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, 'config.yaml'), 'items:\n  - x\n  - "y"\n');

      const result = await resolveVariables({ varFile: [varFile] }, tmpDir);
      expect(result.vars.items).toBe('override');
    });

    it('flag scalar overrides var-file multiline source', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'log: |\n  line1\n  line2\n');

      const result = await resolveVariables({ varFile: [varFile], var: ['log=override'] }, tmpDir);
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

      const result = await resolveVariables({ var: [`data=file:${siblingFile}`] }, cwd);
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

      const result = await resolveVariables({ var: [`data=file:${file}`] }, tmpDir);
      expect(result.vars.data).toEqual(['ok']);
    });

    it('rejects path traversal via ../', async () => {
      const nested = path.join(tmpDir, 'project');
      await fs.mkdir(nested, { recursive: true });

      const result = await resolveVariables({ var: ['data=file:../escape.txt'] }, nested);
      expect(result.vars).not.toHaveProperty('data');
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining('path escapes project directory')]),
      );
    });

    it('accepts directory whose name starts with double-dot', async () => {
      const dotDir = path.join(tmpDir, '..cache');
      await fs.mkdir(dotDir, { recursive: true });
      const file = path.join(dotDir, 'data.json');
      await fs.writeFile(file, '["ok"]');

      const result = await resolveVariables({ var: [`data=file:${file}`] }, tmpDir);
      expect(result.vars.data).toEqual(['ok']);
    });

    it('throws when policy denies a file-backed source', async () => {
      const file = path.join(tmpDir, '.env');
      await fs.writeFile(file, 'SECRET=value\n');

      await expect(
        resolveVariables({ var: [`data=file:${file}`] }, tmpDir, {
          evaluator: {
            checkPath: jest.fn().mockReturnValue({
              allowed: false,
              requiresPrompt: false,
              reason: 'Path blocked by policy',
            }),
          } as any,
        }),
      ).rejects.toBeInstanceOf(FileSourcePolicyError);
    });

    it('prompts for file-backed sources when policy requires confirmation', async () => {
      const file = path.join(tmpDir, 'prompted.jsonl');
      await fs.writeFile(file, '{"ok":true}\n');
      const evaluator = {
        checkPath: jest.fn().mockReturnValue({
          allowed: false,
          requiresPrompt: true,
          reason: 'Prompt before read',
        }),
      };
      const prompter = {
        requestPermission: jest.fn().mockResolvedValue({ granted: true, persist: false }),
      };

      const result = await resolveVariables({ var: [`data=file:${file}`] }, tmpDir, {
        evaluator: evaluator as any,
        prompter: prompter as any,
      });

      expect(prompter.requestPermission).toHaveBeenCalledWith(
        'read',
        await fs.realpath(file),
        'Prompt before read',
      );
      expect(result.vars.data).toEqual({
        kind: 'json-array-stream',
        path: await fs.realpath(file),
      });
    });

    it('fails cleanly when a promptable file-backed source has no prompter', async () => {
      const file = path.join(tmpDir, 'prompted-no-ui.txt');
      await fs.writeFile(file, 'ok\n');

      await expect(
        resolveVariables({ var: [`data=file:${file}`] }, tmpDir, {
          evaluator: {
            checkPath: jest.fn().mockReturnValue({
              allowed: false,
              requiresPrompt: true,
              reason: 'Prompt before read',
            }),
          } as any,
        }),
      ).rejects.toThrow('Prompt before read');
    });
  });

  describe('collectEnvBridgeVars (via resolveVariables)', () => {
    afterEach(() => {
      // Clean up any RD_VAR_* env vars set during tests
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('RD_VAR_')) {
          delete process.env[key];
        }
      }
    });

    it('collects RD_VAR_foo=bar as variable foo with value bar', async () => {
      process.env.RD_VAR_foo = 'bar';

      const result = await resolveVariables({}, tmpDir);

      expect(result.vars.foo).toBe('bar');
    });

    it('ignores RD_VAR_ with invalid identifier suffix and produces warning', async () => {
      process.env.RD_VAR_1bad = 'value';

      const result = await resolveVariables({}, tmpDir);

      expect(result.vars['1bad']).toBeUndefined();
      expect(result.warnings.some((w) => w.includes('1bad'))).toBe(true);
    });

    it('ignores RD_VAR_step and produces warning instead of throwing', async () => {
      process.env.RD_VAR_step = 'from-env';

      const result = await resolveVariables({}, tmpDir);

      expect(result.vars.step).toBeUndefined();
      expect(result.warnings.some((w) => w.includes('RD_VAR_step') && w.includes('reserved'))).toBe(
        true,
      );
    });

    it('ignores reserved names case-insensitively in RD_VAR_* bridge', async () => {
      process.env.RD_VAR_Step = 'from-env';

      const result = await resolveVariables({}, tmpDir);

      expect(result.vars.Step).toBeUndefined();
      expect(result.warnings.some((w) => w.includes('RD_VAR_Step') && w.includes('reserved'))).toBe(
        true,
      );
    });

    it('--var-file overrides RD_VAR_* for same key', async () => {
      process.env.RD_VAR_message = 'from-env';
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'message: from-file\n');

      const result = await resolveVariables({ varFile: [varFile] }, tmpDir);

      expect(result.vars.message).toBe('from-file');
    });

    it('RD_VAR_* overrides config discovery for same key', async () => {
      process.env.RD_VAR_greeting = 'from-env';
      const configDir = path.join(tmpDir, '.rundown');
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, 'config.yaml'), 'greeting: from-config\n');

      const result = await resolveVariables({}, tmpDir);

      expect(result.vars.greeting).toBe('from-env');
    });

    it('--var flag overrides RD_VAR_* for same key', async () => {
      process.env.RD_VAR_message = 'from-env';

      const result = await resolveVariables({ var: ['message=from-flag'] }, tmpDir);

      expect(result.vars.message).toBe('from-flag');
    });
  });

  describe('repeatable --var-file', () => {
    it('merges multiple files with non-overlapping keys', async () => {
      const fileA = path.join(tmpDir, 'a.yaml');
      const fileB = path.join(tmpDir, 'b.yaml');
      await fs.writeFile(fileA, 'alpha: one\n');
      await fs.writeFile(fileB, 'beta: two\n');

      const result = await resolveVariables({ varFile: [fileA, fileB] }, tmpDir);

      expect(result.vars.alpha).toBe('one');
      expect(result.vars.beta).toBe('two');
    });

    it('later file wins for overlapping keys', async () => {
      const fileA = path.join(tmpDir, 'a.yaml');
      const fileB = path.join(tmpDir, 'b.yaml');
      await fs.writeFile(fileA, 'shared: from-a\n');
      await fs.writeFile(fileB, 'shared: from-b\n');

      const result = await resolveVariables({ varFile: [fileA, fileB] }, tmpDir);

      expect(result.vars.shared).toBe('from-b');
    });

    it('single file in array works (backward compatibility)', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'greeting: hello\n');

      const result = await resolveVariables({ varFile: [varFile] }, tmpDir);

      expect(result.vars.greeting).toBe('hello');
    });

    it('empty array produces no file vars', async () => {
      const result = await resolveVariables({ varFile: [] }, tmpDir);

      // Only built-in vars should be present
      expect(result.vars).toHaveProperty('Date');
      expect(result.vars).not.toHaveProperty('any_file_var');
    });
  });

  describe('--var-json', () => {
    it('array value stored as JsonArray in vars', async () => {
      const result = await resolveVariables({ varJson: ['items=["a","b","c"]'] }, tmpDir);

      expect(result.vars.items).toEqual(['a', 'b', 'c']);
    });

    it('object value is preserved as JsonObject', async () => {
      const result = await resolveVariables({ varJson: ['config={"host":"localhost"}'] }, tmpDir);

      expect(result.vars.config).toEqual({ host: 'localhost' });
      expect(result.warnings).toHaveLength(0);
    });

    it('number value is preserved as number', async () => {
      const result = await resolveVariables({ varJson: ['count=42'] }, tmpDir);

      expect(result.vars.count).toBe(42);
    });

    it('boolean value produces string var', async () => {
      const result = await resolveVariables({ varJson: ['debug=true'] }, tmpDir);

      expect(result.vars.debug).toBe('true');
    });

    it('string value produces string var', async () => {
      const result = await resolveVariables({ varJson: ['name="hello"'] }, tmpDir);

      expect(result.vars.name).toBe('hello');
    });

    it('--var-json overrides --var for same key', async () => {
      const result = await resolveVariables({ var: ['count=10'], varJson: ['count=99'] }, tmpDir);

      // varJson is processed after var in collectRawLayers, so it wins
      expect(result.vars.count).toBe(99);
    });

    it('empty object is preserved', async () => {
      const result = await resolveVariables({ varJson: ['config={}'] }, tmpDir);

      expect(result.vars.config).toEqual({});
      expect(result.warnings).toHaveLength(0);
    });

    it('deeply nested object is preserved', async () => {
      const result = await resolveVariables({ varJson: ['config={"a":{"b":{"c":1}}}'] }, tmpDir);

      expect(result.vars.config).toEqual({ a: { b: { c: 1 } } });
    });

    it('object with array field is preserved', async () => {
      const result = await resolveVariables({ varJson: ['config={"items":["a","b"]}'] }, tmpDir);

      expect(result.vars.config).toEqual({ items: ['a', 'b'] });
    });

    it('null value is stringified', async () => {
      const result = await resolveVariables({ varJson: ['val=null'] }, tmpDir);

      expect(result.vars.val).toBe('null');
    });

    it('non-finite numbers are stringified with warning', async () => {
      // YAML .inf/-.inf/.nan produce non-finite JS numbers that break JSON.stringify
      const configPath = path.join(tmpDir, '.rundown', 'config.yaml');
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
    expect(result.vars.items).toEqual({
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

  it('collects --var flags', async () => {
    const result = await collectCliFlags({ var: ['env=staging', 'port=3000'] }, tmpDir);
    expect(result).toEqual({ env: 'staging', port: '3000' });
  });

  it('collects --var-json flags', async () => {
    const result = await collectCliFlags({ varJson: ['items=["a","b"]'] }, tmpDir);
    expect(result).toEqual({ items: ['a', 'b'] });
  });

  it('collects --var-file contents', async () => {
    const varFile = path.join(tmpDir, 'vars.yaml');
    await fs.writeFile(varFile, 'greeting: hello\ncount: 42\n');

    const result = await collectCliFlags({ varFile: [varFile] }, tmpDir);
    expect(result).toEqual({ greeting: 'hello', count: 42 });
  });

  it('preserves precedence: var-json > var > var-file', async () => {
    const varFile = path.join(tmpDir, 'vars.yaml');
    await fs.writeFile(varFile, 'key: from-file\n');

    const result = await collectCliFlags(
      { varFile: [varFile], var: ['key=from-var'], varJson: ['key="from-json"'] },
      tmpDir,
    );
    expect(result.key).toBe('from-json');
  });

  it('returns empty object when no flags provided', async () => {
    const result = await collectCliFlags({}, tmpDir);
    expect(result).toEqual({});
  });
});

describe('sanitizeBranchName', () => {
  it('should return empty string for empty input', () => {
    expect(sanitizeBranchName('')).toBe('');
  });

  it('should pass through simple names unchanged', () => {
    expect(sanitizeBranchName('main')).toBe('main');
    expect(sanitizeBranchName('develop')).toBe('develop');
  });

  it('should replace slashes with hyphens', () => {
    expect(sanitizeBranchName('feature/add-login')).toBe('feature-add-login');
    expect(sanitizeBranchName('fix/bug/nested')).toBe('fix-bug-nested');
  });

  it('should strip invalid characters and append hash when lossy', () => {
    const result = sanitizeBranchName('feature@branch!');
    expect(result).toMatch(/^featurebranch-[a-f0-9]{8}$/);
  });

  it('should preserve dots in branch names', () => {
    expect(sanitizeBranchName('my..branch')).toBe('my..branch');
    expect(sanitizeBranchName('release/1.2.3')).toBe('release-1.2.3');
  });

  it('should collapse consecutive hyphens', () => {
    expect(sanitizeBranchName('a//b')).toBe('a-b');
    expect(sanitizeBranchName('a---b')).toBe('a-b');
  });

  it('should trim leading and trailing hyphens', () => {
    expect(sanitizeBranchName('-leading')).toBe('leading');
    expect(sanitizeBranchName('trailing-')).toBe('trailing');
    expect(sanitizeBranchName('/scoped/')).toBe('scoped');
  });

  it('should produce distinct results for branches that previously collided', () => {
    const a = sanitizeBranchName('release/1.2');
    const b = sanitizeBranchName('release/12');
    expect(a).not.toBe(b);
    expect(a).toBe('release-1.2');
    expect(b).toBe('release-12');
  });

  it('should return hash-only for non-ASCII-only branches', () => {
    const a = sanitizeBranchName('功能');
    const b = sanitizeBranchName('特性');
    expect(a).toMatch(/^[a-f0-9]{8}$/);
    expect(b).toMatch(/^[a-f0-9]{8}$/);
    expect(a).not.toBe(b);
  });

  it('should produce deterministic output', () => {
    expect(sanitizeBranchName('feature@branch')).toBe(sanitizeBranchName('feature@branch'));
    expect(sanitizeBranchName('功能')).toBe(sanitizeBranchName('功能'));
  });
});
