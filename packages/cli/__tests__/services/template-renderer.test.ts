import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parseRunbookDocument, readArtifactManifest } from '@rundown-org/core';
import type {
  Runbook,
  Step,
  BaseStep,
  StepWithFor,
  ResolvedStepWithFor,
  ResolvedStepWithPromptedFor,
  ParsedForClause,
  Transitions,
  Substep,
} from '@rundown-org/parser';
import { RunbookSyntaxError } from '@rundown-org/parser';
import {
  expandLoopVariables,
  shellEscapeValue,
  substituteText,
  substituteRunbookVariables,
  expandLoopVariablesForCommand,
  resolveForBounds,
  collectUnresolvedVariables,
  warnUnresolvedRunbookVariables,
} from '../../src/services/template-renderer.js';
import { setHelperRegistry, resetHelperRegistry } from '../../src/services/helper-registry.js';
import { resetHelperInvokeWarnings } from '@rundown-org/core';
import type { StepVariables } from '../../src/services/execution-vars.js';
import {
  assertResolvedStepHasSubsteps,
  assertResolvedStepWithFor,
  assertStepWithCommand,
  parseResolvedRunbook,
} from '../helpers/parse-helpers.js';

const RUN_ID = 'rd_0123456789abcdef0123456789abcdef';
const RUNBOOK_REF = {
  source: 'plugin',
  path: 'planning/review/review-plan-risk-safety.runbook.md',
} as const;

describe('expandLoopVariables', () => {
  it('should expand named loop variable', () => {
    expect(expandLoopVariables('Handle {{batch}}', { batch: '2' })).toBe('Handle 2');
  });

  it('should expand Index built-in', () => {
    expect(expandLoopVariables('Iteration {{Index}}', { Index: '3' })).toBe('Iteration 3');
  });

  it('should expand both named variable and Index', () => {
    expect(expandLoopVariables('{{batch}} of {{Index}}', { batch: '2', Index: '2' })).toBe(
      '2 of 2',
    );
  });

  it('should preserve unmatched variables', () => {
    expect(expandLoopVariables('{{batch}} and {{other}}', { batch: '1' })).toBe('1 and {{other}}');
  });

  it('should return text unchanged when no variables match', () => {
    expect(expandLoopVariables('No variables here', { batch: '1' })).toBe('No variables here');
  });

  it('should handle variable with spaces around braces', () => {
    expect(expandLoopVariables('{{ batch }}', { batch: '5' })).toBe('5');
  });

  it('should expand multiple occurrences of same variable', () => {
    expect(expandLoopVariables('{{i}} then {{i}}', { i: '3' })).toBe('3 then 3');
  });

  it('should expand Step variable', () => {
    expect(expandLoopVariables('At step {{Step}}', { Step: '3.1' })).toBe('At step 3.1');
  });

  it('should expand Step for named step', () => {
    expect(expandLoopVariables('At {{Step}}', { Step: 'ErrorHandler' })).toBe('At ErrorHandler');
  });
});

describe('shellEscapeValue', () => {
  it('should return safe alphanumeric values unquoted', () => {
    expect(shellEscapeValue('main')).toBe('main');
    expect(shellEscapeValue('feature/branch')).toBe('feature/branch');
    expect(shellEscapeValue('v1.2.3')).toBe('v1.2.3');
    expect(shellEscapeValue('file_name')).toBe('file_name');
    expect(shellEscapeValue('path/to/file.txt')).toBe('path/to/file.txt');
  });

  it('should return numeric values unquoted', () => {
    expect(shellEscapeValue('42')).toBe('42');
    expect(shellEscapeValue('3.14')).toBe('3.14');
  });

  it('should wrap empty string in single quotes', () => {
    expect(shellEscapeValue('')).toBe("''");
  });

  it('should wrap values with spaces in single quotes', () => {
    expect(shellEscapeValue('hello world')).toBe("'hello world'");
  });

  it('should wrap values with semicolons in single quotes', () => {
    expect(shellEscapeValue('main; rm -rf /')).toBe("'main; rm -rf /'");
  });

  it('should wrap values with pipes in single quotes', () => {
    expect(shellEscapeValue('data | evil')).toBe("'data | evil'");
  });

  it('should escape internal single quotes', () => {
    expect(shellEscapeValue("it's")).toBe("'it'\\''s'");
  });

  it('should handle values with backticks', () => {
    expect(shellEscapeValue('echo `whoami`')).toBe("'echo `whoami`'");
  });

  it('should handle values with dollar signs', () => {
    expect(shellEscapeValue('$HOME')).toBe("'$HOME'");
  });

  it('should handle values with double quotes', () => {
    expect(shellEscapeValue('say "hello"')).toBe('\'say "hello"\'');
  });

  it('should handle values with newlines', () => {
    expect(shellEscapeValue('line1\nline2')).toBe("'line1\nline2'");
  });

  it('should quote values starting with a dash (flag injection)', () => {
    expect(shellEscapeValue('-flag')).toBe("'-flag'");
    expect(shellEscapeValue('--verbose')).toBe("'--verbose'");
  });

  it('should quote values containing directory traversal (..)', () => {
    expect(shellEscapeValue('../etc/passwd')).toBe("'../etc/passwd'");
    expect(shellEscapeValue('foo/../bar')).toBe("'foo/../bar'");
  });

  it('should still return safe paths unquoted (regression)', () => {
    expect(shellEscapeValue('foo/bar')).toBe('foo/bar');
  });
});

describe('substituteText', () => {
  it('should substitute defined variables', () => {
    expect(substituteText('Hello {{name}}', { name: 'World' })).toBe('Hello World');
  });

  it('should preserve undefined variables as literal text', () => {
    expect(substituteText('Hello {{name}}', {})).toBe('Hello {{name}}');
  });

  it('should apply escape function when provided', () => {
    const escapeFn = (v: string) => `[${v}]`;
    expect(substituteText('cmd {{arg}}', { arg: 'value' }, escapeFn)).toBe('cmd [value]');
  });

  it('should handle multiple occurrences', () => {
    expect(substituteText('{{x}} and {{x}}', { x: 'A' })).toBe('A and A');
  });

  it('should handle multiple different variables', () => {
    expect(substituteText('{{a}} {{b}}', { a: '1', b: '2' })).toBe('1 2');
  });

  it('should handle spaces in braces', () => {
    expect(substituteText('{{ name }}', { name: 'test' })).toBe('test');
  });

  it('should resolve dotted access on object values', () => {
    expect(substituteText('{{config.host}}', { config: { host: 'localhost' } })).toBe('localhost');
  });

  it('should serialize object to JSON when accessed directly', () => {
    expect(substituteText('{{config}}', { config: { host: 'localhost' } })).toBe(
      '{"host":"localhost"}',
    );
  });

  it('should resolve deeply nested dotted access', () => {
    expect(substituteText('{{config.db.host}}', { config: { db: { host: 'localhost' } } })).toBe(
      'localhost',
    );
  });

  it('should resolve number values from objects', () => {
    expect(substituteText('port={{config.port}}', { config: { port: 3000 } })).toBe('port=3000');
  });

  it('should resolve null-in-object as "null"', () => {
    expect(substituteText('{{config.host}}', { config: { host: null } })).toBe('null');
  });

  it('should preserve literal for nonexistent dotted path', () => {
    expect(substituteText('{{config.nonexistent}}', { config: { host: 'localhost' } })).toBe(
      '{{config.nonexistent}}',
    );
  });

  it('should handle number template variable values', () => {
    expect(substituteText('port={{port}}', { port: 42 })).toBe('port=42');
  });
});

describe('substituteRunbookVariables', () => {
  it('should substitute description without escaping', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy {{environment}}\n\nDeploy to {{environment}}.';
    const runbook = parseResolvedRunbook(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { environment: 'staging & prod' });
    expect(result.steps[0].description).toBe('Deploy staging & prod');
  });

  it('should substitute prompt without escaping', () => {
    const rawMarkdown = '# Test\n\n## 1. Check\n\n> Is {{service}} running?\n';
    const runbook = parseResolvedRunbook(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { service: 'my service' });
    expect(result.steps[0].prompt).toContain('my service');
  });

  it('should shell-escape command.code values', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\n```bash\ngit checkout {{BRANCH}}\n```';
    const runbook = parseResolvedRunbook(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { BRANCH: 'main; rm -rf /' });
    const step = result.steps[0];
    assertStepWithCommand(step);
    expect(step.command.code).toBe("git checkout 'main; rm -rf /'");
  });

  it('should pass through safe values unquoted in commands', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\n```bash\ngit checkout {{BRANCH}}\n```';
    const runbook = parseResolvedRunbook(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { BRANCH: 'main' });
    const step = result.steps[0];
    assertStepWithCommand(step);
    expect(step.command.code).toBe('git checkout main');
  });

  it('should preserve undefined variables', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\n```bash\ngit checkout {{BRANCH}}\n```';
    const runbook = parseResolvedRunbook(rawMarkdown);
    const result = substituteRunbookVariables(runbook, {});
    const step = result.steps[0];
    assertStepWithCommand(step);
    expect(step.command.code).toBe('git checkout {{BRANCH}}');
  });

  it('renders literal path helper in command text without mutating the manifest', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'rd-template-'));
    try {
      const runbook = parseResolvedRunbook(
        "# Test\n\n## 1. Produce\n\n```bash\nprintf '{}' > '{{ path \"review.json\" }}'\n```",
      );
      const variables = {
        WorkPath: '.rundown/work',
        ContextId: 'ctx1',
        RunId: 'rd_0123456789abcdef0123456789abcdef',
        RunbookRef: {
          source: 'plugin',
          path: 'planning/review/review-plan-risk-safety.runbook.md',
        },
      };

      const result = substituteRunbookVariables(runbook, variables, { cwd });
      const step = result.steps[0];
      assertStepWithCommand(step);
      const expectedPath = path.join(
        cwd,
        '.rundown/work/.rd-ctx1/runs/rd_0123456789abcdef0123456789abcdef/review.json',
      );
      expect(step.command.code).toBe(`printf '{}' > '${expectedPath}'`);

      // Phase 3: template helpers are pure render-only projections (spec §313).
      const records = await readArtifactManifest({ cwd, workPath: variables.WorkPath }, 'ctx1');
      expect(records).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('renders literal path helper in prompt text without mutating the manifest', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'rd-template-'));
    try {
      const runbook = parseResolvedRunbook(
        '# Test\n\n## 1. Confirm\n\n> Review {{ path "review.json" }}\n',
      );
      const variables = {
        WorkPath: '.rundown/work',
        ContextId: 'ctx1',
        RunId: 'rd_0123456789abcdef0123456789abcdef',
        RunbookRef: {
          source: 'plugin',
          path: 'planning/review/review-plan-risk-safety.runbook.md',
        },
      };

      const result = substituteRunbookVariables(runbook, variables, { cwd });
      const expectedPath = path.join(
        cwd,
        '.rundown/work/.rd-ctx1/runs/rd_0123456789abcdef0123456789abcdef/review.json',
      );
      expect(result.steps[0].prompt).toContain(expectedPath);

      const records = await readArtifactManifest({ cwd, workPath: variables.WorkPath }, 'ctx1');
      expect(records).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects literal {{ artifact "key" }} form in prompt text (spec §327)', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'rd-template-'));
    try {
      const runbook = parseResolvedRunbook(
        '# Test\n\n## 1. Report\n\n> Artifact {{ artifact "review.json" }}\n',
      );
      const variables = {
        WorkPath: '.rundown/work',
        ContextId: 'ctx1',
        RunId: 'rd_0123456789abcdef0123456789abcdef',
        RunbookRef: {
          source: 'plugin',
          path: 'planning/review/review-plan-risk-safety.runbook.md',
        },
      };

      expect(() => substituteRunbookVariables(runbook, variables, { cwd })).toThrow(/literal key/);

      const records = await readArtifactManifest({ cwd, workPath: variables.WorkPath }, 'ctx1');
      expect(records).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves the helper placeholder when helperOptions is omitted (startup AST walk)', () => {
    const runbook = parseResolvedRunbook(
      '# Test\n\n## 1. Confirm\n\n> Review {{ path "review.json" }}\n',
    );
    const result = substituteRunbookVariables(runbook, {
      WorkPath: '.rundown/work',
      ContextId: 'ctx1',
      RunId: RUN_ID,
      RunbookRef: RUNBOOK_REF,
    });
    expect(result.steps[0].prompt).toContain('{{ path "review.json" }}');
  });

  it('propagates helper resolution failures when helperOptions is provided', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'rd-template-'));
    try {
      const runbook = parseResolvedRunbook(
        '# Test\n\n## 1. Confirm\n\n> Review {{ path "../escape" }}\n',
      );
      expect(() =>
        substituteRunbookVariables(
          runbook,
          {
            WorkPath: '.rundown/work',
            ContextId: 'ctx1',
            RunId: RUN_ID,
            RunbookRef: RUNBOOK_REF,
          },
          { cwd },
        ),
      ).toThrow(/Invalid ArtifactKey/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('should substitute runbook title', () => {
    const rawMarkdown = '# {{project}} Runbook\n\n## 1. Start\n\nGo.';
    const runbook = parseResolvedRunbook(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { project: 'MyApp' });
    expect(result.title).toBe('MyApp Runbook');
  });

  it('should substitute runbook description', () => {
    const rawMarkdown = '# Test\n\nDeploy {{app}} to production.\n\n## 1. Start\n\nGo.';
    const runbook = parseResolvedRunbook(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { app: 'MyApp' });
    expect(result.description).toContain('MyApp');
  });

  it('should handle substep commands with escaping', () => {
    const rawMarkdown = [
      '# Test',
      '',
      '## 1. Main step',
      '',
      '### 1.1 Check {{service}}',
      '',
      '```bash',
      'curl {{url}}',
      '```',
      '',
    ].join('\n');
    const runbook = parseResolvedRunbook(rawMarkdown);
    const result = substituteRunbookVariables(runbook, {
      service: 'web server',
      url: 'http://example.com/path?q=1&x=2',
    });
    const parent = result.steps[0];
    assertResolvedStepHasSubsteps(parent);
    const sub = parent.substeps[0];
    expect(sub.description).toBe('Check web server');
    // URL contains special chars (? and &) so gets quoted
    expect(sub.command?.code).toContain("'http://example.com/path?q=1&x=2'");
  });

  it('prevents shell injection via variable substitution', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\n```bash\ngit checkout {{BRANCH}}\n```';
    const runbook = parseResolvedRunbook(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { BRANCH: 'main; rm -rf /' });
    const step = result.steps[0];
    assertStepWithCommand(step);
    // The injected command should be safely quoted
    expect(step.command.code).toBe("git checkout 'main; rm -rf /'");
    // Should NOT contain the unescaped injection
    expect(step.command.code).not.toBe('git checkout main; rm -rf /');
  });

  it('prevents backtick injection', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\n```bash\necho {{MSG}}\n```';
    const runbook = parseResolvedRunbook(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { MSG: '`whoami`' });
    const step = result.steps[0];
    assertStepWithCommand(step);
    expect(step.command.code).toBe("echo '`whoami`'");
  });

  it('prevents dollar-sign injection', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\n```bash\necho {{MSG}}\n```';
    const runbook = parseResolvedRunbook(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { MSG: '$(cat /etc/passwd)' });
    const step = result.steps[0];
    assertStepWithCommand(step);
    expect(step.command.code).toBe("echo '$(cat /etc/passwd)'");
  });
});

describe('expandLoopVariablesForCommand', () => {
  it('should shell-escape values', () => {
    expect(expandLoopVariablesForCommand('echo {{msg}}', { msg: 'hello world' })).toBe(
      "echo 'hello world'",
    );
  });

  it('should pass through safe numeric values unquoted', () => {
    expect(expandLoopVariablesForCommand('echo {{Index}}', { Index: '3' })).toBe('echo 3');
  });

  it('should preserve unmatched variables', () => {
    expect(expandLoopVariablesForCommand('{{batch}} and {{other}}', { batch: '1' })).toBe(
      '1 and {{other}}',
    );
  });

  it('should shell-escape values with special characters', () => {
    expect(expandLoopVariablesForCommand('deploy {{target}}', { target: 'prod; drop db' })).toBe(
      "deploy 'prod; drop db'",
    );
  });

  // Task 4: JSONL object semantics tests
  it('resolves nested object fields via dotted path', () => {
    const variables: StepVariables = {
      item: { name: 'server-a', region: 'us-west' },
      Index: '1',
    };
    expect(expandLoopVariables('Server {{item.name}}', variables)).toBe('Server server-a');
  });

  it('resolves deep dotted paths in objects', () => {
    const variables: StepVariables = {
      item: { meta: { region: 'us-west', tier: 'prod' } },
    };
    expect(expandLoopVariables('{{item.meta.region}}', variables)).toBe('us-west');
  });

  it('renders object as compact JSON string', () => {
    const variables: StepVariables = {
      item: { host: 'server-a', count: 1 },
    };
    expect(expandLoopVariables('Config: {{item}}', variables)).toContain('{');
    expect(expandLoopVariables('Config: {{item}}', variables)).toContain('}');
  });

  it('renders null as JSON string "null"', () => {
    const variables: StepVariables = {
      value: null,
    };
    expect(expandLoopVariables('Result: {{value}}', variables)).toBe('Result: null');
  });

  it('renders number as JSON string', () => {
    const variables: StepVariables = {
      count: 42,
    };
    expect(expandLoopVariables('Count: {{count}}', variables)).toBe('Count: 42');
  });

  it('renders boolean as JSON string', () => {
    const variables: StepVariables = {
      enabled: true,
      active: false,
    };
    expect(expandLoopVariables('Enabled: {{enabled}}, Active: {{active}}', variables)).toBe(
      'Enabled: true, Active: false',
    );
  });

  it('renders string as-is without extra quoting', () => {
    const variables: StepVariables = {
      msg: 'hello',
    };
    expect(expandLoopVariables('Message: {{msg}}', variables)).toBe('Message: hello');
  });

  it('preserves placeholder for missing dotted paths', () => {
    const variables: StepVariables = {
      item: { name: 'server-a' },
    };
    expect(expandLoopVariables('Region: {{item.nonexistent}}', variables)).toBe(
      'Region: {{item.nonexistent}}',
    );
  });

  it('resolves falsy leaf values correctly (zero)', () => {
    const variables: StepVariables = {
      config: { count: 0 },
    };
    expect(expandLoopVariables('Count: {{config.count}}', variables)).toBe('Count: 0');
  });

  it('resolves falsy leaf values correctly (false)', () => {
    const variables: StepVariables = {
      config: { active: false },
    };
    expect(expandLoopVariables('Active: {{config.active}}', variables)).toBe('Active: false');
  });

  it('resolves falsy leaf values correctly (empty string)', () => {
    const variables: StepVariables = {
      config: { label: '' },
    };
    expect(expandLoopVariables('Label: "{{config.label}}"', variables)).toBe('Label: ""');
  });

  it('does not traverse prototype chain', () => {
    const obj: Record<string, string> = { name: 'test' };
    const variables: StepVariables = {
      item: obj,
    };
    expect(expandLoopVariables('{{item.constructor}}', variables)).toBe('{{item.constructor}}');
  });

  it('shell-escapes serialized JSON in command context', () => {
    const variables: StepVariables = {
      config: { cmd: 'rm -rf /' },
    };
    expect(expandLoopVariablesForCommand('process {{config}}', variables)).toContain('rm -rf');
    expect(expandLoopVariablesForCommand('process {{config}}', variables)).toMatch(/'/);
  });

  it('continues to work with string variables unchanged', () => {
    const variables: StepVariables = {
      Step: '3.1',
      Index: '2',
      server: 'alpha',
    };
    expect(expandLoopVariables('At {{Step}}, iteration {{Index}} for {{server}}', variables)).toBe(
      'At 3.1, iteration 2 for alpha',
    );
  });

  it('handles nullish path segment gracefully', () => {
    const variables: StepVariables = {
      item: { meta: null },
    };
    expect(expandLoopVariables('{{item.meta.region}}', variables)).toBe('{{item.meta.region}}');
  });

  it('handles undefined path segment gracefully', () => {
    const variables: StepVariables = {
      item: { meta: { nested: { value: 42 } } },
    };
    expect(expandLoopVariables('{{item.missing.value}}', variables)).toBe('{{item.missing.value}}');
  });

  it('renders array as JSON string', () => {
    const variables: StepVariables = {
      items: [1, 2, 3],
    };
    const result = expandLoopVariables('Items: {{items}}', variables);
    expect(result).toContain('[');
    expect(result).toContain(']');
  });

  it('resolves numeric index paths on arrays', () => {
    const result = expandLoopVariables('val={{item.0}}', { item: ['a', 'b', 'c'] });
    expect(result).toBe('val=a');
  });

  it('prefers exact flattened key over dotted traversal for same placeholder', () => {
    const variables: StepVariables = {
      context: { parent: { index: '2' } },
      'context.parent.index': '7',
    };
    expect(expandLoopVariables('Index={{context.parent.index}}', variables)).toBe('Index=7');
  });

  // Progressive prefix matching: flattened dotted keys with object values
  it('resolves dotted path through flattened key holding an object', () => {
    const variables: StepVariables = {
      'context.vars.config': { host: 'localhost', port: 5432 },
    };
    expect(expandLoopVariables('Host: {{context.vars.config.host}}', variables)).toBe(
      'Host: localhost',
    );
  });

  it('resolves deep path through flattened key holding nested object', () => {
    const variables: StepVariables = {
      'context.vars.config': { db: { host: 'pg.local', port: 5432 } },
    };
    expect(expandLoopVariables('DB: {{context.vars.config.db.host}}', variables)).toBe(
      'DB: pg.local',
    );
  });

  it('resolves context.parent.vars through flattened key', () => {
    const variables: StepVariables = {
      'context.parent.vars.config': { host: 'parent-host' },
    };
    expect(expandLoopVariables('Parent: {{context.parent.vars.config.host}}', variables)).toBe(
      'Parent: parent-host',
    );
  });

  it('prefers exact key over progressive prefix match', () => {
    const variables: StepVariables = {
      'context.vars.config.host': 'exact-match',
      'context.vars.config': { host: 'from-object' },
    };
    expect(expandLoopVariables('{{context.vars.config.host}}', variables)).toBe('exact-match');
  });

  it('renders flattened object key as JSON when no remainder path', () => {
    const variables: StepVariables = {
      'context.vars.config': { host: 'localhost' },
    };
    expect(expandLoopVariables('{{context.vars.config}}', variables)).toBe('{"host":"localhost"}');
  });

  it('preserves placeholder when flattened key value lacks the remainder path', () => {
    const variables: StepVariables = {
      'context.vars.config': { host: 'localhost' },
    };
    expect(expandLoopVariables('{{context.vars.config.missing}}', variables)).toBe(
      '{{context.vars.config.missing}}',
    );
  });
});

describe('collectUnresolvedVariables', () => {
  it('should return variable names from unresolved placeholders', () => {
    expect(collectUnresolvedVariables('Hello {{name}} and {{age}}')).toEqual(['name', 'age']);
  });

  it('should return empty array when no placeholders', () => {
    expect(collectUnresolvedVariables('No variables here')).toEqual([]);
  });

  it('should handle dotted paths', () => {
    expect(collectUnresolvedVariables('{{item.name}} and {{config.port}}')).toEqual([
      'item.name',
      'config.port',
    ]);
  });

  it('should handle spaces in braces', () => {
    expect(collectUnresolvedVariables('{{ name }}')).toEqual(['name']);
  });

  it('should return duplicates when same variable appears multiple times', () => {
    expect(collectUnresolvedVariables('{{x}} and {{x}}')).toEqual(['x', 'x']);
  });
});

describe('warnUnresolvedRunbookVariables', () => {
  it('should warn for unresolved variables in description', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\nDeploy to {{environment}}.';
    const runbook = parseResolvedRunbook(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toContain('Undefined variable "{{environment}}" preserved as literal text');
  });

  it('should warn for unresolved variables in command code', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\n```bash\ngit checkout {{BRANCH}}\n```';
    const runbook = parseResolvedRunbook(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toContain('Undefined variable "{{BRANCH}}" preserved as literal text');
  });

  it('should deduplicate warnings for same variable', () => {
    const rawMarkdown =
      '# Test\n\n## 1. Deploy {{env}}\n\nDeploy to {{env}}.\n\n## 2. Verify {{env}}\n\nCheck {{env}}.';
    const runbook = parseResolvedRunbook(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toHaveLength(1);
  });

  it('should not warn when all variables are resolved', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\nDeploy to {{environment}}.';
    const runbook = parseResolvedRunbook(rawMarkdown);
    const substituted = substituteRunbookVariables(runbook, { environment: 'staging' });
    const warnings = warnUnresolvedRunbookVariables(substituted);
    expect(warnings).toHaveLength(0);
  });

  it('should warn for unresolved variables in title', () => {
    const rawMarkdown = '# {{project}} Runbook\n\n## 1. Start\n\nGo.';
    const runbook = parseResolvedRunbook(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toContain('Undefined variable "{{project}}" preserved as literal text');
  });

  it('should warn for unresolved variables in prompt', () => {
    const rawMarkdown = '# Test\n\n## 1. Check\n\n> Is {{service}} running?\n';
    const runbook = parseResolvedRunbook(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toContain('Undefined variable "{{service}}" preserved as literal text');
  });

  it('should warn for unresolved variables in substep runbook paths', () => {
    const rawMarkdown = [
      '# Test',
      '',
      '## 1. Main step',
      '',
      '### 1.1 Sub',
      '',
      '- deploy-{{region}}.runbook.md',
    ].join('\n');
    const runbook = parseResolvedRunbook(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toContain('Undefined variable "{{region}}" preserved as literal text');
  });

  it('should suppress FOR variable inside own substeps', () => {
    const rawMarkdown = [
      '# Test',
      '',
      '## 1. Deploy',
      '- FOR item IN 1 TO 3',
      '',
      '### 1.1 Process',
      '',
      'Handle {{item}}.',
    ].join('\n');
    const runbook = parseResolvedRunbook(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toHaveLength(0);
  });

  it('should warn for FOR variable referenced outside FOR scope', () => {
    const rawMarkdown = [
      '# Test',
      '',
      '## 1. Before',
      '',
      'Use {{item}} here.',
      '',
      '## 2. Loop',
      '- FOR item IN 1 TO 3',
      '',
      '### 2.1 Process',
      '',
      'Handle {{item}}.',
    ].join('\n');
    const runbook = parseResolvedRunbook(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toHaveLength(1);
    expect(warnings).toContain('Undefined variable "{{item}}" preserved as literal text');
  });

  it('should scope Index/index suppression to FOR substeps only', () => {
    const rawMarkdown = [
      '# Test',
      '',
      '## 1. Before',
      '',
      'At {{Index}} position.',
      '',
      '## 2. Loop',
      '- FOR item IN 1 TO 3',
      '',
      '### 2.1 Process',
      '',
      'Iteration {{Index}}.',
    ].join('\n');
    const runbook = parseResolvedRunbook(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toHaveLength(1);
    expect(warnings).toContain('Undefined variable "{{Index}}" preserved as literal text');
  });

  it('should warn for FOR variable in FOR step own description', () => {
    const rawMarkdown = [
      '# Test',
      '',
      '## 1. Process {{item}}',
      '- FOR item IN 1 TO 3',
      '',
      '### 1.1 Sub',
      '',
      'Handle {{item}}.',
    ].join('\n');
    const runbook = parseResolvedRunbook(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toHaveLength(1);
    expect(warnings).toContain('Undefined variable "{{item}}" preserved as literal text');
  });

  it('should scope multiple FOR steps independently', () => {
    const rawMarkdown = [
      '# Test',
      '',
      '## 1. Servers',
      '- FOR server IN 1 TO 2',
      '',
      '### 1.1 Deploy',
      '',
      'Deploy to {{server}}.',
      '',
      '## 2. Environments',
      '- FOR env IN 1 TO 2',
      '',
      '### 2.1 Check',
      '',
      'Check {{server}} in {{env}}.',
    ].join('\n');
    const runbook = parseResolvedRunbook(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toHaveLength(1);
    expect(warnings).toContain('Undefined variable "{{server}}" preserved as literal text');
  });

  it('should suppress dotted FOR variable paths inside FOR scope', () => {
    const rawMarkdown = [
      '# Test',
      '',
      '## 1. Deploy',
      '- FOR item IN 1 TO 3',
      '',
      '### 1.1 Process',
      '',
      'Name: {{item.name}}, Region: {{item.region}}.',
    ].join('\n');
    const runbook = parseResolvedRunbook(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toHaveLength(0);
  });

  it('should suppress FOR variable inside prompted-for substeps', () => {
    const rawMarkdown = [
      '# Test',
      '',
      '## 1. Deploy',
      '- FOR item IN 1 TO {{N}}',
      '',
      '### 1.1 Process',
      '',
      'Handle {{item}}.',
    ].join('\n');
    const { runbook } = parseRunbookDocument(rawMarkdown);
    const resolved = resolveForBounds(runbook, {});
    const warnings = warnUnresolvedRunbookVariables(resolved.runbook);
    // {{item}} should be suppressed, {{N}} is in the FOR line (prompt text)
    expect(warnings).toHaveLength(0);
  });

  it('should suppress Index inside prompted-for substeps', () => {
    const rawMarkdown = [
      '# Test',
      '',
      '## 1. Deploy',
      '- FOR item IN 1 TO {{N}}',
      '',
      '### 1.1 Process',
      '',
      'Iteration {{Index}} of {{item}}.',
    ].join('\n');
    const { runbook } = parseRunbookDocument(rawMarkdown);
    const resolved = resolveForBounds(runbook, {});
    const warnings = warnUnresolvedRunbookVariables(resolved.runbook);
    expect(warnings).toHaveLength(0);
  });

  it('should suppress dotted FOR variable paths inside prompted-for scope', () => {
    const rawMarkdown = [
      '# Test',
      '',
      '## 1. Deploy',
      '- FOR item IN 1 TO {{N}}',
      '',
      '### 1.1 Process',
      '',
      'Name: {{item.name}}, Region: {{item.region}}.',
    ].join('\n');
    const { runbook } = parseRunbookDocument(rawMarkdown);
    const resolved = resolveForBounds(runbook, {});
    const warnings = warnUnresolvedRunbookVariables(resolved.runbook);
    expect(warnings).toHaveLength(0);
  });

  it('should suppress unresolved name when same name is declared in a later step OUTPUTS', () => {
    const rawMarkdown = [
      '# Test',
      '',
      '## 1. Produce',
      '- OUTPUTS',
      '  - Message',
      '',
      '## 2. Consume',
      '',
      'The message is: {{Message}}',
    ].join('\n');
    const runbook = parseResolvedRunbook(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toHaveLength(0);
  });

  it('should still warn for unresolved names not published by any OUTPUTS', () => {
    const rawMarkdown = [
      '# Test',
      '',
      '## 1. Produce',
      '- OUTPUTS',
      '  - Message',
      '',
      '## 2. Consume',
      '',
      'Env: {{environment}} Msg: {{Message}}',
    ].join('\n');
    const runbook = parseResolvedRunbook(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toHaveLength(1);
    expect(warnings).toContain('Undefined variable "{{environment}}" preserved as literal text');
  });

  it('should suppress substep-published OUTPUTS names', () => {
    const rawMarkdown = [
      '# Test',
      '',
      '## 1. Parent',
      '',
      '### 1.1 Produce',
      '- OUTPUTS',
      '  - Tag',
      '',
      '### 1.2 Consume',
      '',
      'Release {{Tag}}.',
    ].join('\n');
    const runbook = parseResolvedRunbook(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toHaveLength(0);
  });

  it('should not suppress when OUTPUTS exists but uses a different name', () => {
    const rawMarkdown = [
      '# Test',
      '',
      '## 1. Produce',
      '- OUTPUTS',
      '  - Tag',
      '',
      '## 2. Consume',
      '',
      'Release {{Version}}.',
    ].join('\n');
    const runbook = parseResolvedRunbook(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toHaveLength(1);
    expect(warnings).toContain('Undefined variable "{{Version}}" preserved as literal text');
  });
});

describe('resolveForBounds', () => {
  /** Default transitions matching parser output: PASS CONTINUE, FAIL STOP. */
  const DEFAULT_TRANSITIONS: Transitions = {
    pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
    fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
  };

  /** Default DEFER transitions for substeps with runbook delegation. */
  const DEFER_TRANSITIONS: Transitions = {
    pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
    fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
  };

  /** Build a minimal Runbook with given steps. */
  function makeRunbook(steps: Step[]): Runbook {
    return { steps };
  }

  /** Build a base (non-FOR) step. */
  function makeBaseStep(name = '1'): BaseStep {
    return { kind: 'base', name, description: 'A step', transitions: DEFAULT_TRANSITIONS };
  }

  /** Build a FOR step with a given forClause. */
  function makeForStep(forClause: ParsedForClause, name = '1'): StepWithFor {
    return {
      kind: 'for',
      name,
      description: 'Loop step',
      transitions: DEFAULT_TRANSITIONS,
      forClause,
      substeps: [{ id: '1', description: 'Sub', transitions: DEFER_TRANSITIONS }],
    };
  }

  it('passes through runbook with no FOR steps', () => {
    const runbook = makeRunbook([makeBaseStep()]);
    const { runbook: result, warnings } = resolveForBounds(runbook, {});
    expect(result.steps).toEqual(runbook.steps);
    expect(warnings).toEqual([]);
  });

  it('passes through already-resolved FOR clause', () => {
    const resolved: ParsedForClause = { variable: 'item', start: 1, end: 10 };
    const runbook = makeRunbook([makeForStep(resolved)]);
    const { runbook: result } = resolveForBounds(runbook, {});
    const step = result.steps[0];
    assertResolvedStepWithFor(step);
    expect(step.forClause).toEqual(resolved);
  });

  it('resolves single BoundRef (end)', () => {
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'batch',
      start: 1,
      end: { ref: 'Max' },
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    const { runbook: result } = resolveForBounds(runbook, { Max: '5' });
    const step = result.steps[0];
    assertResolvedStepWithFor(step);
    expect(step.forClause).toEqual({ variable: 'batch', start: 1, end: 5 });
  });

  it('resolves both bounds as BoundRef', () => {
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'item',
      start: { ref: 'Min' },
      end: { ref: 'Max' },
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    const { runbook: result } = resolveForBounds(runbook, { Min: '2', Max: '8' });
    const step = result.steps[0];
    assertResolvedStepWithFor(step);
    expect(step.forClause).toEqual({ variable: 'item', start: 2, end: 8 });
  });

  it('resolves windowed source with BoundRef', () => {
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'x',
      start: 1,
      end: { ref: 'N' },
      source: 'items',
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    const { runbook: result } = resolveForBounds(runbook, { N: '5' });
    const step = result.steps[0];
    assertResolvedStepWithFor(step);
    expect(step.forClause).toEqual({ variable: 'x', start: 1, end: 5, source: 'items' });
  });

  it('falls back to prompted FOR for undefined variable', () => {
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'item',
      start: 1,
      end: { ref: 'Missing' },
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    const { runbook: result, warnings } = resolveForBounds(runbook, {});
    const step = result.steps[0] as ResolvedStepWithPromptedFor;
    expect(step.kind).toBe('prompted-for');
    expect('forClause' in step).toBe(false);
    expect(step.prompt).toContain('FOR item IN 1 TO {{Missing}}');
    expect(step.substeps).toBeDefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('prompted');
  });

  it('falls back to prompted FOR when one bound defined and other undefined', () => {
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'item',
      start: { ref: 'Min' },
      end: { ref: 'Max' },
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    const { runbook: result, warnings } = resolveForBounds(runbook, { Min: '2' });
    const step = result.steps[0] as ResolvedStepWithPromptedFor;
    expect(step.kind).toBe('prompted-for');
    expect(step.prompt).toContain('FOR item IN {{Min}} TO {{Max}}');
    expect(warnings).toHaveLength(1);
  });

  it('throws for non-integer value', () => {
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'item',
      start: 1,
      end: { ref: 'Bad' },
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    expect(() => resolveForBounds(runbook, { Bad: 'hello' })).toThrow('must be a positive integer');
  });

  it('throws for zero value', () => {
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'item',
      start: 1,
      end: { ref: 'Zero' },
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    expect(() => resolveForBounds(runbook, { Zero: '0' })).toThrow('must be a positive integer');
  });

  it('throws for value exceeding MAX_FOR_BOUND', () => {
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'item',
      start: 1,
      end: { ref: 'Huge' },
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    expect(() => resolveForBounds(runbook, { Huge: '10001' })).toThrow('10000');
  });

  it('preserves transitions on resolved clause', () => {
    const transitions: Transitions = {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
      fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
    };
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'item',
      start: 1,
      end: { ref: 'N' },
      transitions,
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    const { runbook: result } = resolveForBounds(runbook, { N: '3' });
    const step = result.steps[0];
    assertResolvedStepWithFor(step);
    expect(step.forClause).toEqual({
      variable: 'item',
      start: 1,
      end: 3,
      transitions,
    });
  });

  it('resolves unnamed numeric range (no variable)', () => {
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      start: 1,
      end: { ref: 'Count' },
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    const { runbook: result } = resolveForBounds(runbook, { Count: '5' });
    const step = result.steps[0];
    assertResolvedStepWithFor(step);
    expect(step.forClause).toEqual({ start: 1, end: 5 });
  });

  it('throws for leading-zero value', () => {
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'item',
      start: 1,
      end: { ref: 'Padded' },
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    expect(() => resolveForBounds(runbook, { Padded: '05' })).toThrow('must be a positive integer');
  });

  it('throws for negative integer value', () => {
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'item',
      start: 1,
      end: { ref: 'Neg' },
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    expect(() => resolveForBounds(runbook, { Neg: '-5' })).toThrow('must be a positive integer');
  });

  it('resolves windowed source with both BoundRefs', () => {
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'item',
      start: { ref: 'Begin' },
      end: { ref: 'End' },
      source: 'items',
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    const { runbook: result } = resolveForBounds(runbook, { Begin: '3', End: '7' });
    const step = result.steps[0];
    assertResolvedStepWithFor(step);
    expect(step.forClause).toEqual({
      variable: 'item',
      start: 3,
      end: 7,
      source: 'items',
    });
  });

  it('falls back windowed source with undefined BoundRef to prompted FOR', () => {
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'x',
      start: 1,
      end: { ref: 'N' },
      source: 'items',
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    const { runbook: result, warnings } = resolveForBounds(runbook, {});
    const step = result.steps[0] as ResolvedStepWithPromptedFor;
    expect(step.kind).toBe('prompted-for');
    expect('forClause' in step).toBe(false);
    expect(step.prompt).toContain('FOR x IN 1 TO {{N}} OF items');
    expect(warnings).toHaveLength(1);
  });

  it('fallback source ref is not treated as a template variable', () => {
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'x',
      start: 1,
      end: { ref: 'N' },
      source: 'items',
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    const { runbook: resolved } = resolveForBounds(runbook, {});
    const substituted = substituteRunbookVariables(resolved, { items: 'a,b,c' });
    const step = substituted.steps[0] as ResolvedStepWithPromptedFor;
    expect(step.prompt).toContain('OF items');
    expect(step.prompt).not.toContain('a,b,c');
  });

  it('fallback source ref does not trigger unresolved variable warning', () => {
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'x',
      start: 1,
      end: { ref: 'N' },
      source: 'myData',
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    const { runbook: resolved } = resolveForBounds(runbook, {});
    const substituted = substituteRunbookVariables(resolved, {});
    const warnings = warnUnresolvedRunbookVariables(substituted);
    const sourceWarning = warnings.find((w) => w.includes('myData'));
    expect(sourceWarning).toBeUndefined();
  });

  it('preserves iteration transitions in fallback prompt text and forClause', () => {
    const transitions: Transitions = {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
      fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
    };
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'item',
      start: 1,
      end: { ref: 'Missing' },
      transitions,
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    const { runbook: result } = resolveForBounds(runbook, {});
    const step = result.steps[0] as ResolvedStepWithPromptedFor;
    expect(step.kind).toBe('prompted-for');
    expect('forClause' in step).toBe(false);
    expect(step.prompt).toContain('FOR item IN 1 TO {{Missing}}');
    expect(step.prompt).toContain('- PASS CONTINUE');
    expect(step.prompt).toContain('- FAIL STOP');
  });

  it('preserves transitions with aggregation modifiers in fallback', () => {
    const transitions: Transitions = {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
      fail: { kind: 'fail' as const, retry: 0, action: { type: 'BREAK' as const } },
    };
    const aggregation = { strategy: 'ALL' as const };
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'item',
      start: 1,
      end: { ref: 'N' },
      transitions,
      aggregation,
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    const { runbook: result } = resolveForBounds(runbook, {});
    const step = result.steps[0] as ResolvedStepWithPromptedFor;
    expect(step.kind).toBe('prompted-for');
    expect('forClause' in step).toBe(false);
    expect(step.prompt).toContain('- PASS ALL DEFER');
    expect(step.prompt).toContain('- FAIL ANY BREAK');
  });

  it('preserves transitions with retry in fallback', () => {
    const transitions: Transitions = {
      pass: { kind: 'pass' as const, retry: 3, action: { type: 'CONTINUE' as const } },
      fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
    };
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'item',
      start: 1,
      end: { ref: 'N' },
      transitions,
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    const { runbook: result } = resolveForBounds(runbook, {});
    const step = result.steps[0] as ResolvedStepWithPromptedFor;
    expect(step.kind).toBe('prompted-for');
    expect('forClause' in step).toBe(false);
    expect(step.prompt).toContain('- PASS RETRY 3 CONTINUE');
    expect(step.prompt).toContain('- FAIL STOP');
  });

  it('does not add transition lines when forClause has no transitions', () => {
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'item',
      start: 1,
      end: { ref: 'Missing' },
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    const { runbook: result } = resolveForBounds(runbook, {});
    const step = result.steps[0] as ResolvedStepWithPromptedFor;
    expect(step.kind).toBe('prompted-for');
    expect('forClause' in step).toBe(false);
    expect(step.prompt).toBe('FOR item IN 1 TO {{Missing}}');
    expect(step.prompt).not.toContain('PASS');
    expect(step.prompt).not.toContain('FAIL');
  });

  it('preserves transitions on windowed source fallback', () => {
    const transitions: Transitions = {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'NEXT' as const } },
      fail: { kind: 'fail' as const, retry: 0, action: { type: 'COMPLETE' as const } },
    };
    const aggregation = { strategy: 'ANY' as const };
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'x',
      start: 1,
      end: { ref: 'N' },
      source: 'items',
      transitions,
      aggregation,
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    const { runbook: result } = resolveForBounds(runbook, {});
    const step = result.steps[0] as ResolvedStepWithPromptedFor;
    expect(step.kind).toBe('prompted-for');
    expect('forClause' in step).toBe(false);
    expect(step.prompt).toContain('FOR x IN 1 TO {{N}} OF items');
    expect(step.prompt).toContain('- PASS ANY NEXT');
    expect(step.prompt).toContain('- FAIL ALL COMPLETE');
  });

  it('prompted FOR has kind prompted-for without forClause', () => {
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'server',
      start: 1,
      end: { ref: 'Count' },
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    const { runbook: result } = resolveForBounds(runbook, {});
    const step = result.steps[0] as ResolvedStepWithPromptedFor;
    expect(step.kind).toBe('prompted-for');
    expect('forClause' in step).toBe(false);
  });

  it('normal resolved FOR step has kind for', () => {
    const unresolved: ParsedForClause = {
      unresolved: true as const,
      variable: 'item',
      start: 1,
      end: { ref: 'N' },
    };
    const runbook = makeRunbook([makeForStep(unresolved)]);
    const { runbook: result } = resolveForBounds(runbook, { N: '5' });
    const step = result.steps[0] as ResolvedStepWithFor;
    expect(step.kind).toBe('for');
  });

  describe('post-resolution validation of prompted FOR steps', () => {
    /** Build a FOR step with substeps that have transitions. */
    function makeForStepWithSubstepTransitions(
      forClause: ParsedForClause,
      substeps: Substep[],
      name = '1',
    ): StepWithFor {
      return {
        kind: 'for',
        name,
        description: 'Loop step',
        transitions: DEFAULT_TRANSITIONS,
        forClause,
        substeps,
      };
    }

    it('throws when GOTO AT targets a step with prompted FOR clause', () => {
      // Step 1 is a FOR step with unresolved bounds (will be prompted)
      const unresolvedFor: ParsedForClause = {
        unresolved: true as const,
        variable: 'item',
        start: 1,
        end: { ref: 'Missing' },
      };
      const forStep = makeForStep(unresolvedFor, '1');

      // Step 2 has GOTO 1 AT 3 — targets step 1 which will be prompted
      const gotoStep: BaseStep = {
        kind: 'base',
        name: '2',
        description: 'Jump back',
        transitions: {
          pass: {
            kind: 'pass' as const,
            retry: 0,
            action: { type: 'GOTO' as const, target: { step: '1', at: 3 } },
          },
          fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
        },
      };

      const runbook = makeRunbook([forStep, gotoStep]);
      expect(() => resolveForBounds(runbook, {})).toThrow(RunbookSyntaxError);
      expect(() => resolveForBounds(runbook, {})).toThrow(
        'GOTO AT targets step "1" which has a prompted FOR clause',
      );
    });

    it('throws when NEXT is in substep of a step with prompted FOR clause', () => {
      const unresolvedFor: ParsedForClause = {
        unresolved: true as const,
        variable: 'item',
        start: 1,
        end: { ref: 'Missing' },
      };
      const substeps: Substep[] = [
        {
          id: '1',
          description: 'Sub',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'NEXT' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
        },
      ];
      const forStep = makeForStepWithSubstepTransitions(unresolvedFor, substeps, '1');
      const runbook = makeRunbook([forStep]);
      expect(() => resolveForBounds(runbook, {})).toThrow(RunbookSyntaxError);
      expect(() => resolveForBounds(runbook, {})).toThrow(
        'NEXT in step "1" requires a FOR loop, but the FOR clause is prompted',
      );
    });

    it('throws when BREAK is in substep of a step with prompted FOR clause', () => {
      const unresolvedFor: ParsedForClause = {
        unresolved: true as const,
        variable: 'item',
        start: 1,
        end: { ref: 'Missing' },
      };
      const substeps: Substep[] = [
        {
          id: '1',
          description: 'Sub',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'BREAK' as const } },
          },
        },
      ];
      const forStep = makeForStepWithSubstepTransitions(unresolvedFor, substeps, '1');
      const runbook = makeRunbook([forStep]);
      expect(() => resolveForBounds(runbook, {})).toThrow(RunbookSyntaxError);
      expect(() => resolveForBounds(runbook, {})).toThrow(
        'BREAK in step "1" requires a FOR loop, but the FOR clause is prompted',
      );
    });

    it('does not throw for GOTO (without AT) to a prompted step', () => {
      const unresolvedFor: ParsedForClause = {
        unresolved: true as const,
        variable: 'item',
        start: 1,
        end: { ref: 'Missing' },
      };
      const forStep = makeForStep(unresolvedFor, '1');

      // Step 2 has GOTO 1 (no AT) — this is valid even for prompted steps
      const gotoStep: BaseStep = {
        kind: 'base',
        name: '2',
        description: 'Jump back',
        transitions: {
          pass: {
            kind: 'pass' as const,
            retry: 0,
            action: { type: 'GOTO' as const, target: { step: '1' } },
          },
          fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
        },
      };

      const runbook = makeRunbook([forStep, gotoStep]);
      const { warnings } = resolveForBounds(runbook, {});
      // Should succeed with just the fallback warning
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('prompted');
    });

    it('throws when forClause.transitions contain GOTO AT targeting a prompted step', () => {
      // Step 1 is a FOR step with unresolved bounds (will be prompted)
      const unresolvedFor: ParsedForClause = {
        unresolved: true as const,
        variable: 'item',
        start: 1,
        end: { ref: 'Missing' },
      };
      const promptedStep = makeForStep(unresolvedFor, '1');

      // Step 2 is a resolved FOR step whose forClause.transitions has GOTO 1 AT 3
      const resolvedFor: ParsedForClause = {
        variable: 'x',
        start: 1,
        end: 5,
        transitions: {
          pass: {
            kind: 'pass' as const,
            retry: 0,
            action: { type: 'GOTO' as const, target: { step: '1', at: 3 } },
          },
          fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
        },
      };
      const resolvedStep = makeForStep(resolvedFor, '2');

      const runbook = makeRunbook([promptedStep, resolvedStep]);
      expect(() => resolveForBounds(runbook, {})).toThrow(RunbookSyntaxError);
      expect(() => resolveForBounds(runbook, {})).toThrow(
        'GOTO AT targets step "1" which has a prompted FOR clause',
      );
    });

    it('reports all validation errors when multiple loop controls reference prompted steps', () => {
      const unresolvedFor: ParsedForClause = {
        unresolved: true as const,
        variable: 'item',
        start: 1,
        end: { ref: 'Missing' },
      };
      // Substep with both NEXT and BREAK referencing a prompted FOR step
      const substeps: Substep[] = [
        {
          id: '1',
          description: 'Sub with NEXT',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'NEXT' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'BREAK' as const } },
          },
        },
      ];
      const forStep = makeForStepWithSubstepTransitions(unresolvedFor, substeps, '1');
      const runbook = makeRunbook([forStep]);
      expect(() => resolveForBounds(runbook, {})).toThrow(RunbookSyntaxError);
      // Both NEXT and BREAK errors should be reported
      expect(() => resolveForBounds(runbook, {})).toThrow(/NEXT.*prompted.*; .*BREAK.*prompted/);
    });

    it('does not throw for NEXT/BREAK in substep of a successfully resolved FOR step', () => {
      const resolvedFor: ParsedForClause = {
        unresolved: true as const,
        variable: 'item',
        start: 1,
        end: { ref: 'Max' },
      };
      const substeps: Substep[] = [
        {
          id: '1',
          description: 'Sub',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'NEXT' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'BREAK' as const } },
          },
        },
      ];
      const forStep = makeForStepWithSubstepTransitions(resolvedFor, substeps, '1');
      const runbook = makeRunbook([forStep]);
      // Provide the variable so the FOR clause resolves successfully
      const { runbook: result, warnings } = resolveForBounds(runbook, { Max: '5' });
      expect(warnings).toHaveLength(0);
      expect(result.steps[0].kind).toBe('for');
    });
  });

  describe('RunbookRef resolution', () => {
    it('resolves RunbookRef to literal path in substep-bearing step', () => {
      const step: Step = {
        kind: 'substeps',
        name: '1',
        description: 'Execute',
        transitions: DEFAULT_TRANSITIONS,
        substeps: [
          {
            id: '1',
            description: 'Sub',
            transitions: DEFER_TRANSITIONS,
            runbooks: [{ ref: 'Target' }],
          },
        ],
      };
      const runbook = makeRunbook([step]);
      const { runbook: result, warnings } = resolveForBounds(runbook, {
        Target: 'deploy.runbook.md',
      });
      expect(warnings).toEqual([]);
      const resolved = result.steps[0];
      expect(resolved.kind).toBe('substeps');
      assertResolvedStepHasSubsteps(resolved);
      expect(resolved.substeps[0].runbooks).toEqual(['deploy.runbook.md']);
    });

    it('preserves undefined RunbookRef as literal text', () => {
      const step: Step = {
        kind: 'substeps',
        name: '1',
        description: 'Execute',
        transitions: DEFAULT_TRANSITIONS,
        substeps: [
          {
            id: '1',
            description: 'Sub',
            transitions: DEFER_TRANSITIONS,
            runbooks: [{ ref: 'Missing' }],
          },
        ],
      };
      const runbook = makeRunbook([step]);
      const { runbook: result, warnings } = resolveForBounds(runbook, {});
      expect(warnings).toEqual([]);
      const resolved = result.steps[0];
      assertResolvedStepHasSubsteps(resolved);
      expect(resolved.substeps[0].runbooks).toEqual(['{{ Missing }}']);
    });

    it('resolves RunbookRef to any value (no suffix validation)', () => {
      const step: Step = {
        kind: 'substeps',
        name: '1',
        description: 'Execute',
        transitions: DEFAULT_TRANSITIONS,
        substeps: [
          {
            id: '1',
            description: 'Sub',
            transitions: DEFER_TRANSITIONS,
            runbooks: [{ ref: 'Target' }],
          },
        ],
      };
      const runbook = makeRunbook([step]);
      const { runbook: result, warnings } = resolveForBounds(runbook, {
        Target: 'rundown:write-plan',
      });
      expect(warnings).toEqual([]);
      const resolved = result.steps[0];
      assertResolvedStepHasSubsteps(resolved);
      expect(resolved.substeps[0].runbooks).toEqual(['rundown:write-plan']);
    });

    it('passes through literal string runbook paths unchanged', () => {
      const step: Step = {
        kind: 'substeps',
        name: '1',
        description: 'Execute',
        transitions: DEFAULT_TRANSITIONS,
        substeps: [
          {
            id: '1',
            description: 'Sub',
            transitions: DEFER_TRANSITIONS,
            runbooks: ['deploy.runbook.md'],
          },
        ],
      };
      const runbook = makeRunbook([step]);
      const { runbook: result, warnings } = resolveForBounds(runbook, {});
      expect(warnings).toEqual([]);
      const resolved = result.steps[0];
      assertResolvedStepHasSubsteps(resolved);
      expect(resolved.substeps[0].runbooks).toEqual(['deploy.runbook.md']);
    });

    it('resolves RunbookRef in FOR step substeps', () => {
      const step: StepWithFor = {
        kind: 'for',
        name: '1',
        description: 'Loop',
        transitions: DEFAULT_TRANSITIONS,
        forClause: { variable: 'item', start: 1, end: 3 },
        substeps: [
          {
            id: '1',
            description: 'Sub',
            transitions: DEFER_TRANSITIONS,
            runbooks: [{ ref: 'Workflow' }],
          },
        ],
      };
      const runbook = makeRunbook([step]);
      const { runbook: result, warnings } = resolveForBounds(runbook, {
        Workflow: 'deploy.runbook.md',
      });
      expect(warnings).toEqual([]);
      const resolved = result.steps[0];
      expect(resolved.kind).toBe('for');
      assertResolvedStepHasSubsteps(resolved);
      expect(resolved.substeps[0].runbooks).toEqual(['deploy.runbook.md']);
    });

    it('handles mixed literal and RunbookRef entries', () => {
      const step: Step = {
        kind: 'substeps',
        name: '1',
        description: 'Execute',
        transitions: DEFAULT_TRANSITIONS,
        substeps: [
          {
            id: '1',
            description: 'Sub',
            transitions: DEFER_TRANSITIONS,
            runbooks: ['setup.runbook.md', { ref: 'Target' }, 'cleanup.runbook.md'],
          },
        ],
      };
      const runbook = makeRunbook([step]);
      const { runbook: result, warnings } = resolveForBounds(runbook, {
        Target: 'deploy.runbook.md',
      });
      expect(warnings).toEqual([]);
      const resolved = result.steps[0];
      assertResolvedStepHasSubsteps(resolved);
      expect(resolved.substeps[0].runbooks).toEqual([
        'setup.runbook.md',
        'deploy.runbook.md',
        'cleanup.runbook.md',
      ]);
    });

    it('preserves FOR-scoped RunbookRef as placeholder text', () => {
      const step: StepWithFor = {
        kind: 'for',
        name: '1',
        description: 'Deploy',
        transitions: DEFAULT_TRANSITIONS,
        forClause: { variable: 'server', source: 'servers', start: 1 },
        substeps: [
          {
            id: '1',
            description: 'Sub',
            transitions: DEFER_TRANSITIONS,
            runbooks: [{ ref: 'server.runbook' }],
          },
        ],
      };
      const runbook = makeRunbook([step]);
      const { runbook: result, warnings } = resolveForBounds(runbook, {});
      // No warning — the ref is FOR-scoped, not truly missing
      expect(warnings).toEqual([]);
      const resolved = result.steps[0];
      expect(resolved.kind).toBe('for');
      // Preserved as placeholder text for runtime expansion
      assertResolvedStepHasSubsteps(resolved);
      expect(resolved.substeps[0].runbooks).toEqual(['{{ server.runbook }}']);
    });

    it('preserves non-FOR-scoped undefined ref as literal text inside FOR step', () => {
      const step: StepWithFor = {
        kind: 'for',
        name: '1',
        description: 'Deploy',
        transitions: DEFAULT_TRANSITIONS,
        forClause: { variable: 'server', source: 'servers', start: 1 },
        substeps: [
          {
            id: '1',
            description: 'Sub',
            transitions: DEFER_TRANSITIONS,
            runbooks: [{ ref: 'Unknown' }],
          },
        ],
      };
      const runbook = makeRunbook([step]);
      const { runbook: result, warnings } = resolveForBounds(runbook, {});
      expect(warnings).toEqual([]);
      const resolved = result.steps[0];
      assertResolvedStepHasSubsteps(resolved);
      expect(resolved.substeps[0].runbooks).toEqual(['{{ Unknown }}']);
    });

    it('preserves FOR-scoped ref even when outer-scope variable exists', () => {
      const step: StepWithFor = {
        kind: 'for',
        name: '1',
        description: 'Deploy',
        transitions: DEFAULT_TRANSITIONS,
        forClause: { variable: 'server', source: 'servers', start: 1 },
        substeps: [
          {
            id: '1',
            description: 'Sub',
            transitions: DEFER_TRANSITIONS,
            runbooks: [{ ref: 'server.runbook' }],
          },
        ],
      };
      const runbook = makeRunbook([step]);
      // Outer-scope 'server' variable exists — must NOT shadow the loop variable
      const { runbook: result, warnings } = resolveForBounds(runbook, {
        server: { runbook: 'WRONG-outer.runbook.md' },
      });
      expect(warnings).toEqual([]);
      // Preserved for runtime, not resolved to outer value
      const resolved = result.steps[0];
      assertResolvedStepHasSubsteps(resolved);
      expect(resolved.substeps[0].runbooks).toEqual(['{{ server.runbook }}']);
    });

    it('resolves RunbookRef with numeric path segments', () => {
      const step: Step = {
        kind: 'substeps',
        name: '1',
        description: 'Execute',
        transitions: DEFAULT_TRANSITIONS,
        substeps: [
          {
            id: '1',
            description: 'Sub',
            transitions: DEFER_TRANSITIONS,
            runbooks: [{ ref: 'context.ancestors.0.runbook' }],
          },
        ],
      };
      const runbook = makeRunbook([step]);
      const { runbook: result, warnings } = resolveForBounds(runbook, {
        context: { ancestors: [{ runbook: 'parent.runbook.md' }] },
      });
      expect(warnings).toEqual([]);
      const resolved = result.steps[0];
      assertResolvedStepHasSubsteps(resolved);
      expect(resolved.substeps[0].runbooks).toEqual(['parent.runbook.md']);
    });
  });
});

describe('DELEGATE field propagation through resolution', () => {
  /**
   * Regression guard: `toResolvedSubstep` must propagate `delegate: true` from
   * ParsedSubstep to Substep, otherwise the auto-issue logic in
   * `runExecutionLoop` (which reads `substep.delegate` on resolved substeps)
   * can never observe the annotation at runtime.
   *
   * All earlier DELEGATE tests (parser-level + delegate-inference-level) use
   * hand-constructed Substep objects, so the parse→resolve→execute seam was
   * not covered end-to-end before this test was added.
   */
  it('preserves delegate: true on every substep through resolveForBounds', () => {
    const rawMarkdown = [
      '# Test',
      '',
      '## 1. Parallel',
      '',
      '### 1.1 A',
      '- DELEGATE',
      '- child-a.runbook.md',
      '',
      '### 1.2 B',
      '- DELEGATE',
      '- child-b.runbook.md',
      '',
    ].join('\n');
    const { runbook } = parseRunbookDocument(rawMarkdown);

    // Sanity: parser sets delegate on both substeps
    const parsedStep = runbook.steps[0];
    expect(parsedStep.kind).toBe('substeps');
    if (parsedStep.kind !== 'substeps') return;
    expect(parsedStep.substeps.map((s) => s.delegate)).toEqual([true, true]);

    const { runbook: resolved } = resolveForBounds(runbook, {});
    const resolvedStep = resolved.steps[0];
    expect(resolvedStep.kind).toBe('substeps');
    if (resolvedStep.kind !== 'substeps') return;

    // Primary assertion: delegate survives toResolvedSubstep — required for
    // execution.ts:604 `currentStep.substeps.some((sub) => sub.delegate)`.
    expect(resolvedStep.substeps.map((s) => s.delegate)).toEqual([true, true]);
    // Runbooks still resolved (regression guard against collateral damage).
    expect(resolvedStep.substeps.map((s) => s.runbooks)).toEqual([
      ['child-a.runbook.md'],
      ['child-b.runbook.md'],
    ]);
  });

  it('preserves delegate: true after substituteRunbookVariables', () => {
    const rawMarkdown = [
      '# Test',
      '',
      '## 1. Parallel',
      '',
      '### 1.1 Go',
      '- DELEGATE',
      '- child.runbook.md',
      '',
    ].join('\n');
    const { runbook } = parseRunbookDocument(rawMarkdown);
    const { runbook: resolved } = resolveForBounds(runbook, {});
    const substituted = substituteRunbookVariables(resolved, {});
    const step = substituted.steps[0];
    expect(step.kind).toBe('substeps');
    if (step.kind !== 'substeps') return;
    expect(step.substeps[0].delegate).toBe(true);
  });

  it('preserves step-level DELEGATE propagated to every substep end-to-end', () => {
    // Step-level `- DELEGATE` is shorthand for DELEGATE on all substeps
    // (see parser `propagateDelegateToSubsteps`). It must survive resolution.
    const rawMarkdown = [
      '# Test',
      '',
      '## 1. Fan-out',
      '- DELEGATE',
      '- PASS ALL CONTINUE',
      '- FAIL ANY CONTINUE',
      '',
      '### 1.1 A',
      '- child-a.runbook.md',
      '',
      '### 1.2 B',
      '- child-b.runbook.md',
      '',
    ].join('\n');
    const { runbook } = parseRunbookDocument(rawMarkdown);
    const { runbook: resolved } = resolveForBounds(runbook, {});
    const step = resolved.steps[0];
    expect(step.kind).toBe('substeps');
    if (step.kind !== 'substeps') return;
    expect(step.substeps.map((s) => s.delegate)).toEqual([true, true]);
  });

  it('leaves delegate undefined on substeps without DELEGATE annotation', () => {
    const rawMarkdown = [
      '# Test',
      '',
      '## 1. Mixed',
      '- PASS ALL CONTINUE',
      '- FAIL ANY CONTINUE',
      '',
      '### 1.1 Delegated',
      '- DELEGATE',
      '- child.runbook.md',
      '',
      '### 1.2 Local',
      '',
      'Do it inline.',
      '',
    ].join('\n');
    const { runbook } = parseRunbookDocument(rawMarkdown);
    const { runbook: resolved } = resolveForBounds(runbook, {});
    const step = resolved.steps[0];
    expect(step.kind).toBe('substeps');
    if (step.kind !== 'substeps') return;
    expect(step.substeps[0].delegate).toBe(true);
    expect(step.substeps[1].delegate).toBeUndefined();
  });
});

describe('substituteText with HelperRegistry', () => {
  beforeEach(() => {
    setHelperRegistry(
      new Map([
        ['upper', (v: string) => v.toUpperCase()],
        ['slug', (v: string) => v.toLowerCase().replace(/\s+/g, '-')],
      ]),
    );
  });

  afterEach(() => {
    resetHelperRegistry();
  });

  it('calls helper with variable reference argument', () => {
    expect(substituteText('{{ upper name }}', { name: 'hello world' })).toBe('HELLO WORLD');
  });

  it('calls helper with string literal argument', () => {
    expect(substituteText('{{ upper "hello world" }}', {})).toBe('HELLO WORLD');
  });

  it('renders built-in path helper with default context', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'rd-template-renderer-'));
    try {
      expect(
        substituteText(
          'Artifact: {{ path "review.json" }}',
          {
            WorkPath: '.rundown/work/demo',
            ContextId: 'ctx-123',
            RunId: RUN_ID,
            RunbookRef: RUNBOOK_REF,
          },
          undefined,
          { cwd },
        ),
      ).toContain(`.rundown/work/demo/.rd-ctx-123/runs/${RUN_ID}/review.json`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves built-in path helper when required variables are missing', () => {
    expect(substituteText('{{ path "review.json" }}', {})).toBe('{{ path "review.json" }}');
    expect(substituteText('{{ path "review.json" }}', { WorkPath: '.rundown/work/demo' })).toBe(
      '{{ path "review.json" }}',
    );
  });

  it('preserves legacy path helper ctx template override as literal text', () => {
    expect(
      substituteText('{{ path "review.json" ctx={{ childCtx }} }}', {
        WorkPath: '.rundown/work/demo',
        ContextId: 'parent',
        childCtx: 'child-123',
      }),
    ).toBe('{{ path "review.json" ctx=child-123 }}');
  });

  it('preserves legacy path helper bare ctx override as literal text', () => {
    expect(
      substituteText('{{ path "review.json" ctx=alt-ctx }}', {
        WorkPath: '.rundown/work/demo',
        ContextId: 'parent',
      }),
    ).toBe('{{ path "review.json" ctx=alt-ctx }}');
  });

  it('calls helper with dotted variable path argument', () => {
    expect(substituteText('{{ slug item.title }}', { item: { title: 'Hello World' } })).toBe(
      'hello-world',
    );
  });

  it('preserves unknown helper as literal text', () => {
    expect(substituteText('{{ unknown name }}', { name: 'foo' })).toBe('{{ unknown name }}');
  });

  it('preserves literal when helper throws', () => {
    setHelperRegistry(
      new Map([
        [
          'thrower',
          (_v: string) => {
            throw new Error('boom');
          },
        ],
      ]),
    );
    expect(substituteText('{{ thrower name }}', { name: 'x' })).toBe('{{ thrower name }}');
  });

  it('{{ ./VarName }} bypasses helper registry and resolves variable directly', () => {
    expect(substituteText('{{ ./upper }}', { upper: 'plain value' })).toBe('plain value');
  });

  it('{{ ./path }} bypasses built-in path helper and resolves variable directly', () => {
    expect(substituteText('{{ ./path }}', { path: 'plain value' })).toBe('plain value');
  });

  it('{{ ./VarName }} preserves literal when variable not defined', () => {
    expect(substituteText('{{ ./missing }}', {})).toBe('{{ ./missing }}');
  });

  it('applies escapeFn to helper result', () => {
    const escapeFn = (v: string) => `[${v}]`;
    expect(substituteText('{{ upper name }}', { name: 'hello' }, escapeFn)).toBe('[HELLO]');
  });

  it('applies escapeFn to ./VarName result', () => {
    const escapeFn = (v: string) => `[${v}]`;
    expect(substituteText('{{ ./name }}', { name: 'hello' }, escapeFn)).toBe('[hello]');
  });

  // Helper-arg path preserves the original placeholder when the variable
  // referenced as the argument is not defined in the frame. Mirrors the
  // `{{ ./VarName }}` and bare `{{ identifier }}` paths: silently passing
  // `''` into the helper would corrupt downstream output and hide the
  // missing-variable bug at the call site (see "No silent mapping" in CLAUDE.md).
  it('preserves placeholder when helper variable argument is undefined', () => {
    expect(substituteText('{{ upper missing }}', {})).toBe('{{ upper missing }}');
  });

  it('preserves placeholder when only one of multiple helper args is undefined', () => {
    expect(substituteText('{{ upper name }} - {{ upper missing }}', { name: 'hi' })).toBe(
      'HI - {{ upper missing }}',
    );
  });

  it('passes plain {{ name }} through normal substitution unaffected', () => {
    expect(substituteText('{{ name }}', { name: 'world' })).toBe('world');
  });

  it('helper call in command context applies shell escaping to result', () => {
    setHelperRegistry(new Map([['loud', (v: string) => `${v} world; rm -rf /`]]));
    // substituteText with shellEscapeValue as escapeFn (mimics command path)
    expect(substituteText('echo {{ loud name }}', { name: 'hello' }, shellEscapeValue)).toBe(
      "echo 'hello world; rm -rf /'",
    );
  });

  it('expandLoopVariables dispatches helper calls', () => {
    expect(expandLoopVariables('{{ upper batch }}', { batch: 'hello' })).toBe('HELLO');
  });

  it('expandLoopVariables dispatches built-in path helper calls', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'rd-template-renderer-'));
    try {
      expect(
        expandLoopVariables(
          '{{ path "review.json" }}',
          {
            WorkPath: '.rundown/work/demo',
            ContextId: 'ctx-123',
            RunId: RUN_ID,
            RunbookRef: RUNBOOK_REF,
          },
          { cwd },
        ),
      ).toContain(`.rundown/work/demo/.rd-ctx-123/runs/${RUN_ID}/review.json`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('expandLoopVariablesForCommand dispatches helper calls with shell escaping', () => {
    setHelperRegistry(new Map([['loud', (v: string) => `${v} world; rm -rf /`]]));
    expect(expandLoopVariablesForCommand('echo {{ loud batch }}', { batch: 'hello' })).toBe(
      "echo 'hello world; rm -rf /'",
    );
  });

  it('expandLoopVariablesForCommand dispatches built-in path helper calls with shell escaping', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'rd-template-renderer-'));
    try {
      expect(
        expandLoopVariablesForCommand(
          'cat {{ path "review.json" }}',
          {
            WorkPath: '.rundown/work/demo path',
            ContextId: 'ctx-123',
            RunId: RUN_ID,
            RunbookRef: RUNBOOK_REF,
          },
          { cwd },
        ),
      ).toContain(`.rundown/work/demo path/.rd-ctx-123/runs/${RUN_ID}/review.json`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('substituteText call-time helper validation', () => {
  // Mirrors the OUTPUTS evaluator coverage in `output-evaluator.test.ts`:
  // pre-PR-235, the registry probed each helper at load time. After Item 10,
  // sync-but-Promise-returning helpers and helpers that return non-strings
  // are caught at the call site by `invokeHelperSafely` instead. The renderer
  // surfaces validation failures the same way it surfaces a thrown helper:
  // the original `{{ ... }}` match text is preserved.

  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    resetHelperInvokeWarnings();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    resetHelperRegistry();
    warnSpy.mockRestore();
  });

  it('preserves literal when a helper returns a Promise and warns once', () => {
    setHelperRegistry(
      new Map([
        ['asyncReturn', ((v: string) => Promise.resolve(v)) as unknown as (v: string) => string],
      ]),
    );
    expect(substituteText('{{ asyncReturn name }}', { name: 'val' })).toBe(
      '{{ asyncReturn name }}',
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Promise'));
  });

  it('preserves literal when a helper returns a non-string and warns once', () => {
    setHelperRegistry(
      new Map([['weird', ((_v: string) => ({ x: 1 })) as unknown as (v: string) => string]]),
    );
    expect(substituteText('{{ weird name }}', { name: 'val' })).toBe('{{ weird name }}');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // typeof {} === 'object'
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('object'));
  });

  it('emits at most one warning across multiple invocations in a single render', () => {
    setHelperRegistry(
      new Map([
        ['asyncReturn', ((v: string) => Promise.resolve(v)) as unknown as (v: string) => string],
      ]),
    );
    // Two `{{ asyncReturn ... }}` calls in one substitution pass — only one warning.
    substituteText('{{ asyncReturn name }} {{ asyncReturn "literal" }}', { name: 'val' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

import type { ArtifactRecord, RenderArtifactOptions } from '@rundown-org/core';

const ARTIFACT_RUN_ID = 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ARTIFACT_CONTEXT = 'ctx1';
const ARTIFACT_RUNBOOK = { source: 'project' as const, path: 'planning/write-plan.runbook.md' };

const PLAN: ArtifactRecord = {
  uri: `rd://artifacts/${ARTIFACT_CONTEXT}/runs/${ARTIFACT_RUN_ID}/plan.json`,
  runId: ARTIFACT_RUN_ID,
  contextId: ARTIFACT_CONTEXT,
  runbook: ARTIFACT_RUNBOOK,
  key: 'plan.json',
  timestamp: '2026-05-07T00:00:00.000Z',
};

const REVIEW_A: ArtifactRecord = {
  uri: `rd://artifacts/${ARTIFACT_CONTEXT}/runs/${ARTIFACT_RUN_ID}/review-plan-a.json`,
  runId: ARTIFACT_RUN_ID,
  contextId: ARTIFACT_CONTEXT,
  runbook: ARTIFACT_RUNBOOK,
  key: 'review-plan-a.json',
  timestamp: '2026-05-07T00:00:00.000Z',
};

const ARTIFACT_HELPER_OPTIONS: RenderArtifactOptions = {
  cwd: '/tmp/project',
  workPath: '.rundown/work',
  contextId: ARTIFACT_CONTEXT,
  runId: ARTIFACT_RUN_ID,
};

describe('substituteText with ArtifactRecord values', () => {
  it('renders {{ PlanPath }} as the artifact URI when value is an ArtifactRecord', () => {
    const out = substituteText(
      'Plan at {{ PlanPath }}',
      { PlanPath: PLAN },
      undefined,
      ARTIFACT_HELPER_OPTIONS,
    );
    expect(out).toBe(`Plan at ${PLAN.uri}`);
  });

  it('renders {{ Reviews }} as a JSON array of URIs when value is ArtifactRecord[]', () => {
    const out = substituteText(
      'Reviews: {{ Reviews }}',
      { Reviews: [REVIEW_A] },
      undefined,
      ARTIFACT_HELPER_OPTIONS,
    );
    expect(out).toBe(`Reviews: ${JSON.stringify([REVIEW_A.uri])}`);
  });

  it('renders {{ Reviews }} as "[]" when value is empty ArtifactRecord[]', () => {
    const out = substituteText(
      'Reviews: {{ Reviews }}',
      { Reviews: [] },
      undefined,
      ARTIFACT_HELPER_OPTIONS,
    );
    expect(out).toBe('Reviews: []');
  });

  it('does not flatten an ArtifactRecord through JSON.stringify', () => {
    const out = substituteText(
      '{{ PlanPath }}',
      { PlanPath: PLAN },
      undefined,
      ARTIFACT_HELPER_OPTIONS,
    );
    expect(out.startsWith('rd://')).toBe(true);
    expect(out.startsWith('{')).toBe(false);
  });
});

describe('substituteText with path helper', () => {
  it('renders {{ path PlanPath }} as the local path for an ArtifactRecord', () => {
    const out = substituteText(
      'Plan: {{ path PlanPath }}',
      { PlanPath: PLAN, WorkPath: '.rundown/work' },
      undefined,
      ARTIFACT_HELPER_OPTIONS,
    );
    expect(out).toContain(`.rd-${ARTIFACT_CONTEXT}`);
    expect(out).toContain(ARTIFACT_RUN_ID);
    expect(out.endsWith('plan.json')).toBe(true);
  });

  it('renders {{ path Reviews }} as a JSON array of local paths', () => {
    const out = substituteText(
      'Reviews: {{ path Reviews }}',
      { Reviews: [REVIEW_A], WorkPath: '.rundown/work' },
      undefined,
      ARTIFACT_HELPER_OPTIONS,
    );
    const prefix = 'Reviews: ';
    expect(out.startsWith(prefix)).toBe(true);
    const parsed = JSON.parse(out.slice(prefix.length)) as string[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].endsWith('review-plan-a.json')).toBe(true);
  });

  it('renders {{ path Reviews }} as "[]" for an empty ArtifactRecord[]', () => {
    const out = substituteText(
      'Reviews: {{ path Reviews }}',
      { Reviews: [], WorkPath: '.rundown/work' },
      undefined,
      ARTIFACT_HELPER_OPTIONS,
    );
    expect(out).toBe('Reviews: []');
  });

  it('renders literal {{ path "plan.json" }} as the current-run local path', () => {
    const out = substituteText(
      'Plan: {{ path "plan.json" }}',
      {
        WorkPath: '.rundown/work',
        ContextId: ARTIFACT_CONTEXT,
        RunId: ARTIFACT_RUN_ID,
      },
      undefined,
      ARTIFACT_HELPER_OPTIONS,
    );
    expect(out).toContain(`.rd-${ARTIFACT_CONTEXT}`);
    expect(out).toContain(ARTIFACT_RUN_ID);
    expect(out.endsWith('plan.json')).toBe(true);
  });
});

describe('substituteText with artifact helper', () => {
  it('renders {{ artifact PlanPath }} as full record JSON', () => {
    const out = substituteText(
      '{{ artifact PlanPath }}',
      { PlanPath: PLAN, WorkPath: '.rundown/work' },
      undefined,
      ARTIFACT_HELPER_OPTIONS,
    );
    expect(JSON.parse(out)).toEqual(PLAN);
  });

  it('renders {{ artifact Reviews }} as a JSON array of records', () => {
    const out = substituteText(
      '{{ artifact Reviews }}',
      { Reviews: [REVIEW_A], WorkPath: '.rundown/work' },
      undefined,
      ARTIFACT_HELPER_OPTIONS,
    );
    expect(JSON.parse(out)).toEqual([REVIEW_A]);
  });

  it('renders {{ artifact Reviews }} as "[]" for an empty ArtifactRecord[]', () => {
    const out = substituteText(
      '{{ artifact Reviews }}',
      { Reviews: [], WorkPath: '.rundown/work' },
      undefined,
      ARTIFACT_HELPER_OPTIONS,
    );
    expect(out).toBe('[]');
  });

  it('rejects literal {{ artifact "plan.json" }} as a hard error', () => {
    expect(() =>
      substituteText(
        '{{ artifact "plan.json" }}',
        { WorkPath: '.rundown/work' },
        undefined,
        ARTIFACT_HELPER_OPTIONS,
      ),
    ).toThrow(/literal key/);
  });

  it('throws when {{ path Var }} variable is not an ArtifactRecord/ArtifactRecord[]', () => {
    expect(() =>
      substituteText(
        '{{ path PlanPath }}',
        { PlanPath: 'not-a-record', WorkPath: '.rundown/work' },
        undefined,
        ARTIFACT_HELPER_OPTIONS,
      ),
    ).toThrow(/ArtifactRecord/);
  });

  it('throws when {{ artifact Var }} variable is not an ArtifactRecord/ArtifactRecord[]', () => {
    expect(() =>
      substituteText(
        '{{ artifact PlanPath }}',
        { PlanPath: 42, WorkPath: '.rundown/work' },
        undefined,
        ARTIFACT_HELPER_OPTIONS,
      ),
    ).toThrow(/ArtifactRecord/);
  });
});
