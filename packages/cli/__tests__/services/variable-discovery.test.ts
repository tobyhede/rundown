import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  discoverVariables,
  findConfigFile,
  parseVarFlag,
  mergeVariables,
  loadVariablesFromFile,
  extractVarsFromMarkdown,
  getBuiltinVariables,
  resolveVariables,
} from '../../src/services/variable-discovery.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

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
});

describe('getBuiltinVariables', () => {
  it('should return all expected built-in variables', () => {
    const builtins = getBuiltinVariables();

    expect(builtins).toHaveProperty('Date');
    expect(builtins).toHaveProperty('DateTime');
    expect(builtins).toHaveProperty('Year');
    expect(builtins).toHaveProperty('Month');
    expect(builtins).toHaveProperty('Day');
    expect(builtins).toHaveProperty('WorkPath');
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

  it('should return WorkPath as .work', () => {
    const builtins = getBuiltinVariables();

    expect(builtins.WorkPath).toBe('.work');
  });

  it('should return consistent date components', () => {
    const builtins = getBuiltinVariables();

    // Date should match Year-Month-Day
    expect(builtins.Date).toBe(`${builtins.Year}-${builtins.Month}-${builtins.Day}`);
  });
});

describe('mergeVariables', () => {
  it('should merge with --var overriding --var-file', () => {
    const builtins = {};
    const frontmatter = {};
    const discovered = { a: '1', b: '2' };
    const fromFile = { b: '3', c: '4' };
    const fromFlags = { c: '5' };

    const result = mergeVariables(builtins, frontmatter, discovered, fromFile, fromFlags);

    expect(result).toEqual({ a: '1', b: '3', c: '5' });
  });

  it('should apply precedence: flags > file > discovered > frontmatter > builtins', () => {
    const builtins = { shared: 'builtin', only_builtin: 'b' };
    const frontmatter = { shared: 'frontmatter', only_frontmatter: 'fm' };
    const discovered = { shared: 'discovered', only_discovered: 'd' };
    const fromFile = { shared: 'file', only_file: 'f' };
    const fromFlags = { shared: 'flag', only_flag: 'g' };

    const result = mergeVariables(builtins, frontmatter, discovered, fromFile, fromFlags);

    expect(result).toEqual({
      shared: 'flag',
      only_builtin: 'b',
      only_frontmatter: 'fm',
      only_discovered: 'd',
      only_file: 'f',
      only_flag: 'g',
    });
  });

  it('should allow builtins to be overridden by frontmatter', () => {
    const builtins = { Date: '2000-01-01', WorkPath: '.work' };
    const frontmatter = { Date: '2024-06-15' };
    const discovered = {};
    const fromFile = {};
    const fromFlags = {};

    const result = mergeVariables(builtins, frontmatter, discovered, fromFile, fromFlags);

    expect(result.Date).toBe('2024-06-15');
    expect(result.WorkPath).toBe('.work');
  });

  it('should allow frontmatter to be overridden by discovered', () => {
    const builtins = { Date: '2000-01-01' };
    const frontmatter = { Date: '2024-01-01' };
    const discovered = { Date: '2024-06-15' };
    const fromFile = {};
    const fromFlags = {};

    const result = mergeVariables(builtins, frontmatter, discovered, fromFile, fromFlags);

    expect(result.Date).toBe('2024-06-15');
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

describe('extractVarsFromMarkdown', () => {
  it('should extract vars from valid frontmatter', () => {
    const markdown = `---
name: test-runbook
vars:
  greeting: Hello
  count: 42
  enabled: true
---
# Content`;

    const result = extractVarsFromMarkdown(markdown);

    expect(result).toEqual({
      greeting: 'Hello',
      count: '42',
      enabled: 'true',
    });
  });

  it('should return empty object when no frontmatter present', () => {
    const markdown = `# No Frontmatter
Just content here.`;

    const result = extractVarsFromMarkdown(markdown);

    expect(result).toEqual({});
  });

  it('should return empty object when frontmatter has no vars field', () => {
    const markdown = `---
name: test-runbook
description: A test runbook
---
# Content`;

    const result = extractVarsFromMarkdown(markdown);

    expect(result).toEqual({});
  });

  it('should return empty object when vars is null', () => {
    const markdown = `---
name: test-runbook
vars: null
---
# Content`;

    const result = extractVarsFromMarkdown(markdown);

    expect(result).toEqual({});
  });

  it('should convert null values to string "null"', () => {
    const markdown = `---
name: test-runbook
vars:
  nullable: null
---
# Content`;

    const result = extractVarsFromMarkdown(markdown);
    expect(result).toEqual({ nullable: 'null' });
  });

  it('should return empty object when vars is not an object', () => {
    const markdown = `---
name: test-runbook
vars: "not an object"
---
# Content`;

    const result = extractVarsFromMarkdown(markdown);

    expect(result).toEqual({});
  });

  it('should convert numbers to strings', () => {
    const markdown = `---
name: test-runbook
vars:
  port: 3000
  pi: 3.14159
---
# Content`;

    const result = extractVarsFromMarkdown(markdown);

    expect(result).toEqual({
      port: '3000',
      pi: '3.14159',
    });
  });

  it('should convert booleans to strings', () => {
    const markdown = `---
name: test-runbook
vars:
  debug: true
  production: false
---
# Content`;

    const result = extractVarsFromMarkdown(markdown);

    expect(result).toEqual({
      debug: 'true',
      production: 'false',
    });
  });

  it('should reject invalid identifier keys', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(jest.fn());

    const markdown = `---
name: test-runbook
vars:
  valid_key: value1
  invalid-key: value2
  123invalid: value3
  _valid: value4
---
# Content`;

    const result = extractVarsFromMarkdown(markdown);

    expect(result).toEqual({
      valid_key: 'value1',
      _valid: 'value4',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      'Warning: Ignoring frontmatter var with invalid key: invalid-key',
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'Warning: Ignoring frontmatter var with invalid key: 123invalid',
    );

    warnSpy.mockRestore();
  });

  it('should warn and skip complex values', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(jest.fn());

    const markdown = `---
name: test-runbook
vars:
  simple: value
  complex:
    nested: object
---
# Content`;

    const result = extractVarsFromMarkdown(markdown);

    // Complex values are skipped, not coerced to "[object Object]"
    expect(result).toEqual({
      simple: 'value',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      'Warning: Ignoring frontmatter var "complex" with complex value',
    );

    warnSpy.mockRestore();
  });

  it('should handle empty vars object', () => {
    const markdown = `---
name: test-runbook
vars: {}
---
# Content`;

    const result = extractVarsFromMarkdown(markdown);

    expect(result).toEqual({});
  });

  it('should handle frontmatter with only vars field', () => {
    // Note: This would fail schema validation in the parser,
    // but extractVarsFromMarkdown uses raw extraction without validation
    const markdown = `---
vars:
  key: value
---
# Content`;

    const result = extractVarsFromMarkdown(markdown);

    expect(result).toEqual({
      key: 'value',
    });
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
      expect(result.sources.env).toBeUndefined();
    });
  });

  describe('file: prefix routing', () => {
    it('routes --var file: to sources as file DataSource', async () => {
      const file = path.join(tmpDir, 'servers.txt');
      await fs.writeFile(file, 'host1\nhost2\n');

      const result = await resolveVariables({ var: [`servers=file:${file}`] }, tmpDir);
      expect(result.vars.servers).toBeUndefined();
      expect(result.sources.servers).toEqual({
        kind: 'file',
        path: await fs.realpath(file),
        format: 'text',
      });
    });

    it('infers jsonl format from .jsonl extension', async () => {
      const file = path.join(tmpDir, 'data.jsonl');
      await fs.writeFile(file, '{"a":1}\n');

      const result = await resolveVariables({ var: [`data=file:${file}`] }, tmpDir);
      expect(result.sources.data).toEqual({
        kind: 'file',
        path: await fs.realpath(file),
        format: 'jsonl',
      });
    });

    it('resolves relative file: paths against cwd', async () => {
      const file = path.join(tmpDir, 'hosts.txt');
      await fs.writeFile(file, 'h1\n');

      const result = await resolveVariables({ var: ['hosts=file:hosts.txt'] }, tmpDir);
      expect(result.sources.hosts).toEqual({
        kind: 'file',
        path: await fs.realpath(file),
        format: 'text',
      });
    });
  });

  describe('YAML array routing', () => {
    it('routes YAML array to both vars (comma-joined) and sources (array)', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'servers:\n  - alpha\n  - beta\n  - gamma\n');

      const result = await resolveVariables({ varFile }, tmpDir);
      expect(result.vars.servers).toBe('alpha, beta, gamma');
      expect(result.sources.servers).toEqual({
        kind: 'array',
        items: ['alpha', 'beta', 'gamma'],
      });
    });
  });

  describe('YAML multiline string routing', () => {
    it('routes YAML multiline string to both vars and sources', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'log: |\n  line1\n  line2\n  line3\n');

      const result = await resolveVariables({ varFile }, tmpDir);
      expect(result.vars.log).toBe('line1\nline2\nline3');
      expect(result.sources.log).toEqual({
        kind: 'array',
        items: ['line1', 'line2', 'line3'],
      });
    });
  });

  describe('YAML file: prefix routing', () => {
    it('routes YAML file: value to sources only', async () => {
      const dataFile = path.join(tmpDir, 'data.txt');
      await fs.writeFile(dataFile, 'x\n');
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, `items: "file:${dataFile}"\n`);

      const result = await resolveVariables({ varFile }, tmpDir);
      expect(result.vars.items).toBeUndefined();
      expect(result.sources.items).toEqual({
        kind: 'file',
        path: await fs.realpath(dataFile),
        format: 'text',
      });
    });
  });

  describe('frontmatter routing', () => {
    it('routes frontmatter array to both maps', async () => {
      const result = await resolveVariables({ frontmatterVars: { servers: ['a', 'b'] } }, tmpDir);
      // This tests that resolveVariables handles raw (pre-normalization) frontmatter
      expect(result.sources.servers).toEqual({ kind: 'array', items: ['a', 'b'] });
    });
  });

  describe('precedence', () => {
    it('flag sources override var-file sources', async () => {
      const fileA = path.join(tmpDir, 'a.txt');
      const fileB = path.join(tmpDir, 'b.txt');
      await fs.writeFile(fileA, 'from-a\n');
      await fs.writeFile(fileB, 'from-b\n');

      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, `items: "file:${fileA}"\n`);

      const result = await resolveVariables({ varFile, var: [`items=file:${fileB}`] }, tmpDir);
      expect(result.sources.items).toEqual({
        kind: 'file',
        path: await fs.realpath(fileB),
        format: 'text',
      });
    });
  });

  describe('cross-source conflicts', () => {
    it('flag scalar overrides var-file array source', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'servers:\n  - alpha\n  - beta\n');

      const result = await resolveVariables({ varFile, var: ['servers=prod'] }, tmpDir);
      expect(result.vars.servers).toBe('prod');
      expect(result.sources.servers).toBeUndefined();
    });

    it('flag file: source overrides var-file array source', async () => {
      const dataFile = path.join(tmpDir, 'data.txt');
      await fs.writeFile(dataFile, 'content');
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'items:\n  - x\n  - y\n');

      const result = await resolveVariables({ varFile, var: [`items=file:${dataFile}`] }, tmpDir);
      expect(result.sources.items).toEqual({
        kind: 'file',
        path: await fs.realpath(dataFile),
        format: 'text',
      });
    });

    it('var-file array overrides frontmatter scalar', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'servers:\n  - a\n  - b\n');

      const result = await resolveVariables(
        { frontmatterVars: { servers: 'single' }, varFile },
        tmpDir,
      );
      expect(result.sources.servers).toEqual({
        kind: 'array',
        items: ['a', 'b'],
      });
    });

    it('deterministic outcome: var-file scalar clears frontmatter array source', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'items: override\n');

      const result = await resolveVariables(
        { frontmatterVars: { items: ['x', 'y'] }, varFile },
        tmpDir,
      );
      expect(result.vars.items).toBe('override');
      expect(result.sources.items).toBeUndefined();
    });

    it('flag scalar overrides var-file multiline source', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'log: |\n  line1\n  line2\n');

      const result = await resolveVariables({ varFile, var: ['log=override'] }, tmpDir);
      expect(result.vars.log).toBe('override');
      expect(result.sources.log).toBeUndefined();
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
      // File source should be rejected — not in sources
      expect(result.sources.data).toBeUndefined();
    });

    it('accepts file within subdirectory', async () => {
      const sub = path.join(tmpDir, 'sub');
      await fs.mkdir(sub, { recursive: true });
      const file = path.join(sub, 'data.txt');
      await fs.writeFile(file, 'ok\n');

      const result = await resolveVariables({ var: [`data=file:${file}`] }, tmpDir);
      expect(result.sources.data).toEqual({
        kind: 'file',
        path: await fs.realpath(file),
        format: 'text',
      });
    });

    it('rejects path traversal via ../', async () => {
      const nested = path.join(tmpDir, 'project');
      await fs.mkdir(nested, { recursive: true });

      const result = await resolveVariables({ var: ['data=file:../escape.txt'] }, nested);
      expect(result.sources.data).toBeUndefined();
    });

    it('accepts directory whose name starts with double-dot', async () => {
      const dotDir = path.join(tmpDir, '..cache');
      await fs.mkdir(dotDir, { recursive: true });
      const file = path.join(dotDir, 'data.txt');
      await fs.writeFile(file, 'ok\n');

      const result = await resolveVariables({ var: [`data=file:${file}`] }, tmpDir);
      expect(result.sources.data).toEqual({
        kind: 'file',
        path: await fs.realpath(file),
        format: 'text',
      });
    });
  });
});
