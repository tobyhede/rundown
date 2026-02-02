import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { discoverVariables, parseVarFlag, mergeVariables, loadVariablesFromFile, collectVariables } from '../../src/services/variable-discovery.js';
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

describe('mergeVariables', () => {
  it('should merge with --var overriding --var-file', () => {
    const discovered = { a: '1', b: '2' };
    const fromFile = { b: '3', c: '4' };
    const fromFlags = { c: '5' };

    const result = mergeVariables(discovered, fromFile, fromFlags);

    expect(result).toEqual({ a: '1', b: '3', c: '5' });
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

  it('should map array YAML to numeric-keyed object', async () => {
    const filePath = path.join(tmpDir, 'array.yaml');
    await fs.writeFile(filePath, '- item1\n- item2\n- item3');

    const result = await loadVariablesFromFile(filePath);

    // Arrays are treated as objects with numeric keys by Object.entries()
    expect(result).toEqual({
      '0': 'item1',
      '1': 'item2',
      '2': 'item3',
    });
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

  it('should return empty object when no sources provided', async () => {
    const result = await collectVariables({}, tmpDir);
    expect(result).toEqual({});
  });

  it('should collect from --var flags only', async () => {
    const result = await collectVariables(
      {
        var: ['key1=value1', 'key2=value2'],
      },
      tmpDir
    );

    expect(result).toEqual({
      key1: 'value1',
      key2: 'value2',
    });
  });

  it('should collect from --var-file only', async () => {
    const varFilePath = path.join(tmpDir, 'vars.yaml');
    await fs.writeFile(varFilePath, 'file_key1: file_value1\nfile_key2: file_value2');

    const result = await collectVariables(
      {
        varFile: varFilePath,
      },
      tmpDir
    );

    expect(result).toEqual({
      file_key1: 'file_value1',
      file_key2: 'file_value2',
    });
  });

  it('should collect from discovered config only', async () => {
    const rundownDir = path.join(tmpDir, '.rundown');
    await fs.mkdir(rundownDir, { recursive: true });
    await fs.writeFile(
      path.join(rundownDir, 'config.yaml'),
      'discovered_key1: discovered_value1\ndiscovered_key2: discovered_value2'
    );

    const result = await collectVariables({}, tmpDir);

    expect(result).toEqual({
      discovered_key1: 'discovered_value1',
      discovered_key2: 'discovered_value2',
    });
  });

  it('should merge all three sources with correct precedence', async () => {
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
    expect(result).toEqual({
      shared: 'from_flag',
      key_discovered: 'value_discovered',
      key_file: 'value_file',
      key_flag: 'value_flag',
    });
  });

  it('should warn on console for invalid --var flag format', async () => {
    const result = await collectVariables(
      {
        var: ['valid=value', 'invalid-without-equals', 'also-invalid-key=value'],
      },
      tmpDir
    );

    expect(result).toEqual({
      valid: 'value',
    });

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

    expect(result).toEqual({
      rel_key: 'rel_value',
    });
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

    expect(result).toEqual({
      abs_key: 'abs_value',
    });
  });
});
