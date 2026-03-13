import { describe, it, expect } from '@jest/globals';
import { parseRunbookDocument } from '@rundown-org/core';
import {
  expandLoopVariables,
  shellEscapeValue,
  substituteText,
  substituteRunbookVariables,
  expandLoopVariablesForCommand,
  expandForClauseVariables,
  collectUnresolvedVariables,
  warnUnresolvedRunbookVariables,
} from '../../src/services/template-renderer.js';

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
});

describe('substituteRunbookVariables', () => {
  it('should substitute description without escaping', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy {{environment}}\n\nDeploy to {{environment}}.';
    const runbook = parseRunbookDocument(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { environment: 'staging & prod' });
    expect(result.steps[0].description).toBe('Deploy staging & prod');
  });

  it('should substitute prompt without escaping', () => {
    const rawMarkdown = '# Test\n\n## 1. Check\n\n> Is {{service}} running?\n';
    const runbook = parseRunbookDocument(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { service: 'my service' });
    expect(result.steps[0].prompt).toContain('my service');
  });

  it('should shell-escape command.code values', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\n```bash\ngit checkout {{BRANCH}}\n```';
    const runbook = parseRunbookDocument(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { BRANCH: 'main; rm -rf /' });
    expect(result.steps[0].command).toBeDefined();
    expect(result.steps[0].command!.code).toBe("git checkout 'main; rm -rf /'");
  });

  it('should pass through safe values unquoted in commands', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\n```bash\ngit checkout {{BRANCH}}\n```';
    const runbook = parseRunbookDocument(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { BRANCH: 'main' });
    expect(result.steps[0].command).toBeDefined();
    expect(result.steps[0].command!.code).toBe('git checkout main');
  });

  it('should preserve undefined variables', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\n```bash\ngit checkout {{BRANCH}}\n```';
    const runbook = parseRunbookDocument(rawMarkdown);
    const result = substituteRunbookVariables(runbook, {});
    expect(result.steps[0].command).toBeDefined();
    expect(result.steps[0].command!.code).toBe('git checkout {{BRANCH}}');
  });

  it('should substitute runbook title', () => {
    const rawMarkdown = '# {{project}} Runbook\n\n## 1. Start\n\nGo.';
    const runbook = parseRunbookDocument(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { project: 'MyApp' });
    expect(result.title).toBe('MyApp Runbook');
  });

  it('should substitute runbook description', () => {
    const rawMarkdown = '# Test\n\nDeploy {{app}} to production.\n\n## 1. Start\n\nGo.';
    const runbook = parseRunbookDocument(rawMarkdown);
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
    const runbook = parseRunbookDocument(rawMarkdown);
    const result = substituteRunbookVariables(runbook, {
      service: 'web server',
      url: 'http://example.com/path?q=1&x=2',
    });
    expect(result.steps[0].substeps?.[0].description).toBe('Check web server');
    // URL contains special chars (? and &) so gets quoted
    expect(result.steps[0].substeps?.[0].command?.code).toContain(
      "'http://example.com/path?q=1&x=2'",
    );
  });

  it('prevents shell injection via variable substitution', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\n```bash\ngit checkout {{BRANCH}}\n```';
    const runbook = parseRunbookDocument(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { BRANCH: 'main; rm -rf /' });
    // The injected command should be safely quoted
    expect(result.steps[0].command?.code).toBe("git checkout 'main; rm -rf /'");
    // Should NOT contain the unescaped injection
    expect(result.steps[0].command?.code).not.toBe('git checkout main; rm -rf /');
  });

  it('prevents backtick injection', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\n```bash\necho {{MSG}}\n```';
    const runbook = parseRunbookDocument(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { MSG: '`whoami`' });
    expect(result.steps[0].command?.code).toBe("echo '`whoami`'");
  });

  it('prevents dollar-sign injection', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\n```bash\necho {{MSG}}\n```';
    const runbook = parseRunbookDocument(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { MSG: '$(cat /etc/passwd)' });
    expect(result.steps[0].command?.code).toBe("echo '$(cat /etc/passwd)'");
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
    const variables: Record<string, unknown> = {
      item: { name: 'server-a', region: 'us-west' },
      Index: '1',
    };
    expect(expandLoopVariables('Server {{item.name}}', variables)).toBe('Server server-a');
  });

  it('resolves deep dotted paths in objects', () => {
    const variables: Record<string, unknown> = {
      item: { meta: { region: 'us-west', tier: 'prod' } },
    };
    expect(expandLoopVariables('{{item.meta.region}}', variables)).toBe('us-west');
  });

  it('renders object as compact JSON string', () => {
    const variables: Record<string, unknown> = {
      item: { host: 'server-a', count: 1 },
    };
    expect(expandLoopVariables('Config: {{item}}', variables)).toContain('{');
    expect(expandLoopVariables('Config: {{item}}', variables)).toContain('}');
  });

  it('renders null as JSON string "null"', () => {
    const variables: Record<string, unknown> = {
      value: null,
    };
    expect(expandLoopVariables('Result: {{value}}', variables)).toBe('Result: null');
  });

  it('renders number as JSON string', () => {
    const variables: Record<string, unknown> = {
      count: 42,
    };
    expect(expandLoopVariables('Count: {{count}}', variables)).toBe('Count: 42');
  });

  it('renders boolean as JSON string', () => {
    const variables: Record<string, unknown> = {
      enabled: true,
      active: false,
    };
    expect(expandLoopVariables('Enabled: {{enabled}}, Active: {{active}}', variables)).toBe(
      'Enabled: true, Active: false',
    );
  });

  it('renders string as-is without extra quoting', () => {
    const variables: Record<string, unknown> = {
      msg: 'hello',
    };
    expect(expandLoopVariables('Message: {{msg}}', variables)).toBe('Message: hello');
  });

  it('preserves placeholder for missing dotted paths', () => {
    const variables: Record<string, unknown> = {
      item: { name: 'server-a' },
    };
    expect(expandLoopVariables('Region: {{item.nonexistent}}', variables)).toBe(
      'Region: {{item.nonexistent}}',
    );
  });

  it('resolves falsy leaf values correctly (zero)', () => {
    const variables: Record<string, unknown> = {
      config: { count: 0 },
    };
    expect(expandLoopVariables('Count: {{config.count}}', variables)).toBe('Count: 0');
  });

  it('resolves falsy leaf values correctly (false)', () => {
    const variables: Record<string, unknown> = {
      config: { active: false },
    };
    expect(expandLoopVariables('Active: {{config.active}}', variables)).toBe('Active: false');
  });

  it('resolves falsy leaf values correctly (empty string)', () => {
    const variables: Record<string, unknown> = {
      config: { label: '' },
    };
    expect(expandLoopVariables('Label: "{{config.label}}"', variables)).toBe('Label: ""');
  });

  it('does not traverse prototype chain', () => {
    const obj: any = { name: 'test' };
    const variables: Record<string, unknown> = {
      item: obj,
    };
    expect(expandLoopVariables('{{item.constructor}}', variables)).toBe('{{item.constructor}}');
  });

  it('shell-escapes serialized JSON in command context', () => {
    const variables: Record<string, unknown> = {
      config: { cmd: 'rm -rf /' },
    };
    expect(expandLoopVariablesForCommand('process {{config}}', variables)).toContain('rm -rf');
    expect(expandLoopVariablesForCommand('process {{config}}', variables)).toMatch(/'/);
  });

  it('continues to work with string variables unchanged', () => {
    const variables: Record<string, unknown> = {
      Step: '3.1',
      Index: '2',
      server: 'alpha',
    };
    expect(expandLoopVariables('At {{Step}}, iteration {{Index}} for {{server}}', variables)).toBe(
      'At 3.1, iteration 2 for alpha',
    );
  });

  it('handles nullish path segment gracefully', () => {
    const variables: Record<string, unknown> = {
      item: { meta: null },
    };
    expect(expandLoopVariables('{{item.meta.region}}', variables)).toBe('{{item.meta.region}}');
  });

  it('handles undefined path segment gracefully', () => {
    const variables: Record<string, unknown> = {
      item: { meta: { nested: { value: 42 } } },
    };
    expect(expandLoopVariables('{{item.missing.value}}', variables)).toBe('{{item.missing.value}}');
  });

  it('renders array as JSON string', () => {
    const variables: Record<string, unknown> = {
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
    const variables: Record<string, unknown> = {
      context: { parent: { index: '2' } },
      'context.parent.index': '7',
    };
    expect(expandLoopVariables('Index={{context.parent.index}}', variables)).toBe('Index=7');
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
    const runbook = parseRunbookDocument(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toContain('Undefined variable "{{environment}}" preserved as literal text');
  });

  it('should warn for unresolved variables in command code', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\n```bash\ngit checkout {{BRANCH}}\n```';
    const runbook = parseRunbookDocument(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toContain('Undefined variable "{{BRANCH}}" preserved as literal text');
  });

  it('should deduplicate warnings for same variable', () => {
    const rawMarkdown =
      '# Test\n\n## 1. Deploy {{env}}\n\nDeploy to {{env}}.\n\n## 2. Verify {{env}}\n\nCheck {{env}}.';
    const runbook = parseRunbookDocument(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toHaveLength(1);
  });

  it('should not warn when all variables are resolved', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\nDeploy to {{environment}}.';
    const runbook = parseRunbookDocument(rawMarkdown);
    const substituted = substituteRunbookVariables(runbook, { environment: 'staging' });
    const warnings = warnUnresolvedRunbookVariables(substituted);
    expect(warnings).toHaveLength(0);
  });

  it('should warn for unresolved variables in title', () => {
    const rawMarkdown = '# {{project}} Runbook\n\n## 1. Start\n\nGo.';
    const runbook = parseRunbookDocument(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toContain('Undefined variable "{{project}}" preserved as literal text');
  });

  it('should warn for unresolved variables in prompt', () => {
    const rawMarkdown = '# Test\n\n## 1. Check\n\n> Is {{service}} running?\n';
    const runbook = parseRunbookDocument(rawMarkdown);
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
    const runbook = parseRunbookDocument(rawMarkdown);
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
    const runbook = parseRunbookDocument(rawMarkdown);
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
    const runbook = parseRunbookDocument(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toHaveLength(1);
    expect(warnings).toContain('Undefined variable "{{item}}" preserved as literal text');
  });

  it('should suppress Index/index everywhere (runtime variable)', () => {
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
    const runbook = parseRunbookDocument(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toHaveLength(0);
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
    const runbook = parseRunbookDocument(rawMarkdown);
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
    const runbook = parseRunbookDocument(rawMarkdown);
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
    const runbook = parseRunbookDocument(rawMarkdown);
    const warnings = warnUnresolvedRunbookVariables(runbook);
    expect(warnings).toHaveLength(0);
  });
});

describe('expandForClauseVariables', () => {
  it('pre-expands FOR clause then substitutes command variables', () => {
    const rawMarkdown = [
      '---',
      'name: test',
      '---',
      '# Test Runbook',
      '',
      '## 1. Deploy',
      '- FOR env IN 1 TO {{Max}}',
      '',
      '### 1.1 Run deploy',
      '',
      '```bash',
      'deploy {{ENV}}',
      '```',
      '',
      '## 2. Done',
      '- PASS COMPLETE',
    ].join('\n');

    const expanded = expandForClauseVariables(rawMarkdown, { Max: '3' });
    const runbook = parseRunbookDocument(expanded);
    const result = substituteRunbookVariables(runbook, { ENV: 'staging' });

    expect(result.steps[0].forClause).toEqual({ variable: 'env', start: 1, end: 3 });
    expect(result.steps[0].substeps).toHaveLength(1);
    expect(result.steps[0].substeps?.[0].command?.code).toBe('deploy staging');
  });

  it('preserves source reference when sourceKeys is provided', () => {
    const markdown = '- FOR server IN {{ servers }}';
    const result = expandForClauseVariables(
      markdown,
      { servers: 'prod,staging' },
      new Set(['servers']),
    );
    expect(result).toBe('- FOR server IN {{ servers }}');
  });

  it('expands non-source vars while preserving source references', () => {
    const markdown = '- FOR item IN 1 TO {{ Max }} OF {{ items }}';
    const result = expandForClauseVariables(
      markdown,
      { Max: '10', items: 'data' },
      new Set(['items']),
    );
    expect(result).toBe('- FOR item IN 1 TO 10 OF {{ items }}');
  });

  it('expands all FOR vars when sourceKeys is undefined', () => {
    const markdown = '- FOR item IN {{ items }}';
    const result = expandForClauseVariables(markdown, { items: 'a,b,c' });
    expect(result).toBe('- FOR item IN a,b,c');
  });

  it('only expands variables on FOR clause lines', () => {
    const lines = [
      '- FOR server IN {{ servers }}',
      '',
      'Some text with {{ Max }} in it',
      '',
      '```bash',
      'echo {{ Max }}',
      '```',
    ];
    const markdown = lines.join('\n');
    const result = expandForClauseVariables(markdown, { servers: 'a', Max: '5' });
    const expected = [
      '- FOR server IN a',
      '',
      'Some text with {{ Max }} in it',
      '',
      '```bash',
      'echo {{ Max }}',
      '```',
    ].join('\n');
    expect(result).toBe(expected);
  });
});
