import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  discoverVariables,
  FileSourcePolicyError,
  findConfigFile,
  parseVarFlag,
  loadVariablesFromFile,
  getBuiltinVariables,
  resolveVariables,
} from '../../src/services/variable-discovery.js';
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

  it('should return WorkPath as .work', () => {
    const builtins = getBuiltinVariables();

    expect(builtins.WorkPath).toBe('.work');
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
      expect(result.sources.env).toBeUndefined();
    });
  });

  describe('frontmatter vars', () => {
    it('uses pre-extracted frontmatterVars', async () => {
      const result = await resolveVariables(
        { frontmatterVars: { greeting: 'Hello', count: 42 } },
        tmpDir,
      );
      expect(result.vars.greeting).toBe('Hello');
      expect(result.vars.count).toBe('42');
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
    it('rejects reserved keys case-insensitively', async () => {
      const result = await resolveVariables(
        { var: ['Step=shadow', 'INDEX=9', 'ConText=shadow', 'env=staging'] },
        tmpDir,
      );

      expect(result.vars.Step).toBeUndefined();
      expect(result.vars.INDEX).toBeUndefined();
      expect(result.vars.ConText).toBeUndefined();
      expect(result.vars.env).toBe('staging');
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
        items: ['line1', 'line2', 'line3', ''],
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
    it('routes frontmatter scalar to vars only', async () => {
      const result = await resolveVariables({ frontmatterVars: { env: 'staging' } }, tmpDir);
      expect(result.vars.env).toBe('staging');
      expect(result.sources.env).toBeUndefined();
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

    it('deterministic outcome: var-file scalar clears config array source', async () => {
      const varFile = path.join(tmpDir, 'vars.yaml');
      await fs.writeFile(varFile, 'items: override\n');

      const configDir = path.join(tmpDir, '.rundown');
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, 'config.yaml'), 'items:\n  - x\n  - "y"\n');

      const result = await resolveVariables({ varFile }, tmpDir);
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
      const file = path.join(tmpDir, 'prompted.txt');
      await fs.writeFile(file, 'ok\n');
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
      expect(result.sources.data).toEqual({
        kind: 'file',
        path: await fs.realpath(file),
        format: 'text',
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
});
