import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { discoverVariables, parseVarFlag, mergeVariables, loadVariablesFromFile, collectVariables, extractVarsFromMarkdown, getBuiltinVariables } from '../../src/services/variable-discovery.js';
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
    const discovered = { a: '1', b: '2' };
    const fromFile = { b: '3', c: '4' };
    const fromFlags = { c: '5' };

    const result = mergeVariables(builtins, discovered, fromFile, fromFlags);

    expect(result).toEqual({ a: '1', b: '3', c: '5' });
  });

  it('should apply precedence: flags > file > discovered > builtins', () => {
    const builtins = { shared: 'builtin', only_builtin: 'b' };
    const discovered = { shared: 'discovered', only_discovered: 'd' };
    const fromFile = { shared: 'file', only_file: 'f' };
    const fromFlags = { shared: 'flag', only_flag: 'g' };

    const result = mergeVariables(builtins, discovered, fromFile, fromFlags);

    expect(result).toEqual({
      shared: 'flag',
      only_builtin: 'b',
      only_discovered: 'd',
      only_file: 'f',
      only_flag: 'g',
    });
  });

  it('should allow builtins to be overridden by discovered', () => {
    const builtins = { Date: '2000-01-01', WorkPath: '.work' };
    const discovered = { Date: '2024-06-15' };
    const fromFile = {};
    const fromFlags = {};

    const result = mergeVariables(builtins, discovered, fromFile, fromFlags);

    expect(result.Date).toBe('2024-06-15');
    expect(result.WorkPath).toBe('.work');
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
    await fs.writeFile(
      filePath,
      'test_command: npm test\nlint_command: npm run lint\nport: 3000'
    );

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
    await fs.writeFile(
      filePath,
      'invalid: yaml: content:\n  - missing\n  proper: indentation'
    );

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
    await fs.writeFile(
      filePath,
      'port: 3000\nmax_connections: 100\npi: 3.14'
    );

    const result = await loadVariablesFromFile(filePath);

    expect(result).toEqual({
      port: '3000',
      max_connections: '100',
      pi: '3.14',
    });
  });

  it('should convert non-string values to strings (booleans)', async () => {
    const filePath = path.join(tmpDir, 'booleans.yaml');
    await fs.writeFile(
      filePath,
      'debug: true\nenabled: false'
    );

    const result = await loadVariablesFromFile(filePath);

    expect(result).toEqual({
      debug: 'true',
      enabled: 'false',
    });
  });

  it('should convert mixed value types to strings', async () => {
    const filePath = path.join(tmpDir, 'mixed.yaml');
    await fs.writeFile(
      filePath,
      'name: my-app\nport: 8080\ndebug: true\nversion: 1.2.3'
    );

    const result = await loadVariablesFromFile(filePath);

    expect(result).toEqual({
      name: 'my-app',
      port: '8080',
      debug: 'true',
      version: '1.2.3',
    });
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
      'test_command: npm test\nlint_command: npm run lint'
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
    await fs.writeFile(
      path.join(parentRundownDir, 'config.yaml'),
      'should_not_find: this value'
    );

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

describe('collectVariables', () => {
  let tmpDir: string;
  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'collect-var-test-'));
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(jest.fn());
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    warnSpy.mockRestore();
  });

  it('should include built-in variables when no other sources provided', async () => {
    const result = await collectVariables({}, tmpDir);

    // Should contain all built-in variables
    expect(result).toHaveProperty('Date');
    expect(result).toHaveProperty('DateTime');
    expect(result).toHaveProperty('Year');
    expect(result).toHaveProperty('Month');
    expect(result).toHaveProperty('Day');
    expect(result).toHaveProperty('WorkPath');
    expect(result.WorkPath).toBe('.work');
  });

  it('should collect from --var flags and include builtins', async () => {
    const result = await collectVariables(
      {
        var: ['key1=value1', 'key2=value2'],
      },
      tmpDir
    );

    // User variables
    expect(result.key1).toBe('value1');
    expect(result.key2).toBe('value2');

    // Built-ins still present
    expect(result).toHaveProperty('Date');
    expect(result).toHaveProperty('WorkPath');
  });

  it('should collect from --var-file and include builtins', async () => {
    const varFilePath = path.join(tmpDir, 'vars.yaml');
    await fs.writeFile(varFilePath, 'file_key1: file_value1\nfile_key2: file_value2');

    const result = await collectVariables(
      {
        varFile: varFilePath,
      },
      tmpDir
    );

    // File variables
    expect(result.file_key1).toBe('file_value1');
    expect(result.file_key2).toBe('file_value2');

    // Built-ins still present
    expect(result).toHaveProperty('Date');
    expect(result).toHaveProperty('WorkPath');
  });

  it('should collect from discovered config and include builtins', async () => {
    const rundownDir = path.join(tmpDir, '.rundown');
    await fs.mkdir(rundownDir, { recursive: true });
    await fs.writeFile(
      path.join(rundownDir, 'config.yaml'),
      'discovered_key1: discovered_value1\ndiscovered_key2: discovered_value2'
    );

    const result = await collectVariables({}, tmpDir);

    // Discovered variables
    expect(result.discovered_key1).toBe('discovered_value1');
    expect(result.discovered_key2).toBe('discovered_value2');

    // Built-ins still present
    expect(result).toHaveProperty('Date');
    expect(result).toHaveProperty('WorkPath');
  });

  it('should merge all sources with correct precedence (flags > file > discovered > builtins)', async () => {
    // Setup discovered config
    const rundownDir = path.join(tmpDir, '.rundown');
    await fs.mkdir(rundownDir, { recursive: true });
    await fs.writeFile(
      path.join(rundownDir, 'config.yaml'),
      'shared: from_discovered\nkey_discovered: value_discovered'
    );

    // Setup var file
    const varFilePath = path.join(tmpDir, 'vars.yaml');
    await fs.writeFile(varFilePath, 'shared: from_file\nkey_file: value_file');

    const result = await collectVariables(
      {
        varFile: varFilePath,
        var: ['shared=from_flag', 'key_flag=value_flag'],
      },
      tmpDir
    );

    // Verify precedence: flags > file > discovered
    expect(result.shared).toBe('from_flag');
    expect(result.key_discovered).toBe('value_discovered');
    expect(result.key_file).toBe('value_file');
    expect(result.key_flag).toBe('value_flag');

    // Built-ins still present
    expect(result).toHaveProperty('Date');
    expect(result).toHaveProperty('WorkPath');
  });

  it('should allow --var flag to override built-in variables', async () => {
    const result = await collectVariables(
      {
        var: ['WorkPath=custom-path', 'Date=2000-01-01'],
      },
      tmpDir
    );

    expect(result.WorkPath).toBe('custom-path');
    expect(result.Date).toBe('2000-01-01');
  });

  it('should allow --var-file to override built-in variables', async () => {
    const varFilePath = path.join(tmpDir, 'vars.yaml');
    // Use quoted string to prevent YAML from parsing as date
    await fs.writeFile(varFilePath, 'WorkPath: from-file\nDate: "2020-06-15"');

    const result = await collectVariables(
      {
        varFile: varFilePath,
      },
      tmpDir
    );

    expect(result.WorkPath).toBe('from-file');
    expect(result.Date).toBe('2020-06-15');
  });

  it('should allow discovered config to override built-in variables', async () => {
    const rundownDir = path.join(tmpDir, '.rundown');
    await fs.mkdir(rundownDir, { recursive: true });
    await fs.writeFile(
      path.join(rundownDir, 'config.yaml'),
      'WorkPath: discovered-path\nYear: 1999'
    );

    const result = await collectVariables({}, tmpDir);

    expect(result.WorkPath).toBe('discovered-path');
    expect(result.Year).toBe('1999');
  });

  it('should warn on console for invalid --var flag format', async () => {
    const result = await collectVariables(
      {
        var: ['valid=value', 'invalid-without-equals', 'also-invalid-key=value'],
      },
      tmpDir
    );

    expect(result.valid).toBe('value');

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith('Warning: Ignoring invalid --var flag: invalid-without-equals');
    expect(warnSpy).toHaveBeenCalledWith('Warning: Ignoring invalid --var flag: also-invalid-key=value');
  });

  it('should handle relative path for --var-file', async () => {
    // Create a var file in tmpDir
    await fs.writeFile(path.join(tmpDir, 'relative-vars.yaml'), 'rel_key: rel_value');

    const result = await collectVariables(
      {
        varFile: 'relative-vars.yaml',
      },
      tmpDir
    );

    expect(result.rel_key).toBe('rel_value');
  });

  it('should handle absolute path for --var-file', async () => {
    const absolutePath = path.join(tmpDir, 'absolute-vars.yaml');
    await fs.writeFile(absolutePath, 'abs_key: abs_value');

    const result = await collectVariables(
      {
        varFile: absolutePath,
      },
      tmpDir
    );

    expect(result.abs_key).toBe('abs_value');
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

    expect(warnSpy).toHaveBeenCalledWith('Warning: Ignoring frontmatter var with invalid key: invalid-key');
    expect(warnSpy).toHaveBeenCalledWith('Warning: Ignoring frontmatter var with invalid key: 123invalid');

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

    expect(warnSpy).toHaveBeenCalledWith('Warning: Ignoring frontmatter var "complex" with complex value');

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
