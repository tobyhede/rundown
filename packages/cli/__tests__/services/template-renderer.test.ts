import { describe, it, expect } from '@jest/globals';
import { parseRunbookDocument } from '@rundown-org/core';
import {
  renderTemplate,
  expandLoopVariables,
  shellEscapeValue,
  substituteText,
  substituteRunbookVariables,
  expandLoopVariablesForCommand,
} from '../../src/services/template-renderer.js';

/* eslint-disable @typescript-eslint/no-deprecated -- testing legacy renderTemplate function */
describe('renderTemplate', () => {
  it('should expand variables in markdown', () => {
    const markdown = '## 1. Run Tests\n\n```bash\n{{test_command}}\n```';
    const variables = { test_command: 'npm test' };

    const result = renderTemplate(markdown, variables);

    expect(result).toBe('## 1. Run Tests\n\n```bash\nnpm test\n```');
  });

  it('should preserve missing variables unchanged', () => {
    const markdown = '## 1. Run {{undefined_var}}';
    const variables = {};

    const result = renderTemplate(markdown, variables);

    expect(result).toBe('## 1. Run {{undefined_var}}');
  });

  it('should preserve missing variables with original spacing', () => {
    const markdown = '## 1. Run {{ undefined_var }}';
    const variables = {};

    const result = renderTemplate(markdown, variables);

    expect(result).toBe('## 1. Run {{ undefined_var }}');
  });

  it('should not escape markdown characters', () => {
    const markdown = '## 1. {{step_name}}';
    const variables = { step_name: 'Test & Verify <code>' };

    const result = renderTemplate(markdown, variables);

    expect(result).toBe('## 1. Test & Verify <code>');
  });

  it('should handle empty variables object', () => {
    const markdown = '## 1. Static Step';
    const variables = {};

    const result = renderTemplate(markdown, variables);

    expect(result).toBe('## 1. Static Step');
  });

  it('should preserve nested undefined variables', () => {
    const markdown = '{{outer}} and {{inner}}';
    const variables = { outer: 'defined' };

    const result = renderTemplate(markdown, variables);

    expect(result).toBe('defined and {{inner}}');
  });

  it('should preserve undefined variables in HTML-like content', () => {
    const markdown = '<div class="info">{{undefined_var}}</div>';
    const result = renderTemplate(markdown, {});
    expect(result).toBe('<div class="info">{{undefined_var}}</div>');
  });

  describe('special characters in variable values', () => {
    it('should handle backticks in values', () => {
      const markdown = '## 1. Run {{command}}';
      const variables = { command: 'echo `code`' };

      const result = renderTemplate(markdown, variables);

      expect(result).toBe('## 1. Run echo `code`');
    });

    it('should handle single quotes in values', () => {
      const markdown = '## 1. Run {{command}}';
      const variables = { command: "echo 'quoted'" };

      const result = renderTemplate(markdown, variables);

      expect(result).toBe("## 1. Run echo 'quoted'");
    });

    it('should handle double quotes in values', () => {
      const markdown = '## 1. Run {{command}}';
      const variables = { command: 'echo "quoted"' };

      const result = renderTemplate(markdown, variables);

      expect(result).toBe('## 1. Run echo "quoted"');
    });

    it('should handle dollar signs in values', () => {
      const markdown = '## 1. Run {{command}}';
      const variables = { command: 'echo $VAR and ${HOME}' };

      const result = renderTemplate(markdown, variables);

      expect(result).toBe('## 1. Run echo $VAR and ${HOME}');
    });

    it('should handle newlines in values', () => {
      const markdown = '## 1. Run {{command}}';
      const variables = { command: 'line1\nline2' };

      const result = renderTemplate(markdown, variables);

      expect(result).toBe('## 1. Run line1\nline2');
    });

    it('should handle backslashes in values', () => {
      const markdown = '## 1. Run {{command}}';
      const variables = { command: 'path\\to\\file' };

      const result = renderTemplate(markdown, variables);

      expect(result).toBe('## 1. Run path\\to\\file');
    });

    it('should handle mixed special characters', () => {
      const markdown = '## 1. Run {{command}}';
      const variables = { command: 'echo "Hello $USER" | grep \'test\'' };

      const result = renderTemplate(markdown, variables);

      expect(result).toBe('## 1. Run echo "Hello $USER" | grep \'test\'');
    });
  });

  describe('Handlebars syntax errors', () => {
    it('should throw on unclosed braces', () => {
      const markdown = '## 1. Run {{variable';
      const variables = {};

      expect(() => renderTemplate(markdown, variables)).toThrow(
        /Parse error on line 1/
      );
    });

    it('should throw on unclosed helper block', () => {
      const markdown = '{{#if condition}}content';
      const variables = { condition: true };

      expect(() => renderTemplate(markdown, variables)).toThrow(
        /Parse error on line 1/
      );
    });

    it('should throw on deeply nested braces', () => {
      const markdown = '{{{{var}}}}';
      const variables = { var: 'test' };

      expect(() => renderTemplate(markdown, variables)).toThrow(
        /Parse error on line 1/
      );
    });

    it('should throw on mismatched helper closing tags', () => {
      const markdown = '{{#if condition}}content{{/unless}}';
      const variables = { condition: true };

      expect(() => renderTemplate(markdown, variables)).toThrow(
        /if doesn't match unless/
      );
    });

    it('should throw on unclosed triple braces', () => {
      const markdown = '{{{variable';
      const variables = { variable: 'test' };

      expect(() => renderTemplate(markdown, variables)).toThrow(
        /Parse error on line 1/
      );
    });

    it('should throw on mismatched brace count', () => {
      const markdown = '{{variable}';
      const variables = { variable: 'test' };

      expect(() => renderTemplate(markdown, variables)).toThrow(
        /Parse error on line 1/
      );
    });

    it('should throw on unclosed nested helpers', () => {
      const markdown = '{{#if a}}{{#each b}}{{name}}{{/if}}';
      const variables = { a: true, b: [{ name: 'test' }] };

      expect(() => renderTemplate(markdown, variables)).toThrow(
        /each doesn't match if/
      );
    });

    it('should throw on only opening braces', () => {
      const markdown = 'Some text {{';
      const variables = {};

      expect(() => renderTemplate(markdown, variables)).toThrow(
        /Parse error on line 1/
      );
    });
  });
});
/* eslint-enable @typescript-eslint/no-deprecated */

describe('expandLoopVariables', () => {
  it('should expand named loop variable', () => {
    expect(expandLoopVariables('Handle {{batch}}', { batch: '2' }))
      .toBe('Handle 2');
  });

  it('should expand Index built-in', () => {
    expect(expandLoopVariables('Iteration {{Index}}', { Index: '3' }))
      .toBe('Iteration 3');
  });

  it('should expand both named variable and Index', () => {
    expect(expandLoopVariables('{{batch}} of {{Index}}', { batch: '2', Index: '2' }))
      .toBe('2 of 2');
  });

  it('should preserve unmatched variables', () => {
    expect(expandLoopVariables('{{batch}} and {{other}}', { batch: '1' }))
      .toBe('1 and {{other}}');
  });

  it('should return text unchanged when no variables match', () => {
    expect(expandLoopVariables('No variables here', { batch: '1' }))
      .toBe('No variables here');
  });

  it('should handle variable with spaces around braces', () => {
    expect(expandLoopVariables('{{ batch }}', { batch: '5' }))
      .toBe('5');
  });

  it('should expand multiple occurrences of same variable', () => {
    expect(expandLoopVariables('{{i}} then {{i}}', { i: '3' }))
      .toBe('3 then 3');
  });

  it('should expand Step variable', () => {
    expect(expandLoopVariables('At step {{Step}}', { Step: '3.1' }))
      .toBe('At step 3.1');
  });

  it('should expand Step for named step', () => {
    expect(expandLoopVariables('At {{Step}}', { Step: 'ErrorHandler' }))
      .toBe('At ErrorHandler');
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
    expect(shellEscapeValue('say "hello"')).toBe("'say \"hello\"'");
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
    expect(substituteText('Hello {{name}}', { name: 'World' }))
      .toBe('Hello World');
  });

  it('should preserve undefined variables as literal text', () => {
    expect(substituteText('Hello {{name}}', {}))
      .toBe('Hello {{name}}');
  });

  it('should apply escape function when provided', () => {
    const escapeFn = (v: string) => `[${v}]`;
    expect(substituteText('cmd {{arg}}', { arg: 'value' }, escapeFn))
      .toBe('cmd [value]');
  });

  it('should handle multiple occurrences', () => {
    expect(substituteText('{{x}} and {{x}}', { x: 'A' }))
      .toBe('A and A');
  });

  it('should handle multiple different variables', () => {
    expect(substituteText('{{a}} {{b}}', { a: '1', b: '2' }))
      .toBe('1 2');
  });

  it('should handle spaces in braces', () => {
    expect(substituteText('{{ name }}', { name: 'test' }))
      .toBe('test');
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
    expect(result.steps[0].command!.code).toBe("git checkout 'main; rm -rf /'");
  });

  it('should pass through safe values unquoted in commands', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\n```bash\ngit checkout {{BRANCH}}\n```';
    const runbook = parseRunbookDocument(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { BRANCH: 'main' });
    expect(result.steps[0].command!.code).toBe('git checkout main');
  });

  it('should preserve undefined variables', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\n```bash\ngit checkout {{BRANCH}}\n```';
    const runbook = parseRunbookDocument(rawMarkdown);
    const result = substituteRunbookVariables(runbook, {});
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
    expect(result.steps[0].substeps![0].description).toBe('Check web server');
    // URL contains special chars (? and &) so gets quoted
    expect(result.steps[0].substeps![0].command!.code).toContain("'http://example.com/path?q=1&x=2'");
  });

  it('prevents shell injection via variable substitution', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\n```bash\ngit checkout {{BRANCH}}\n```';
    const runbook = parseRunbookDocument(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { BRANCH: 'main; rm -rf /' });
    // The injected command should be safely quoted
    expect(result.steps[0].command!.code).toBe("git checkout 'main; rm -rf /'");
    // Should NOT contain the unescaped injection
    expect(result.steps[0].command!.code).not.toBe('git checkout main; rm -rf /');
  });

  it('prevents backtick injection', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\n```bash\necho {{MSG}}\n```';
    const runbook = parseRunbookDocument(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { MSG: '`whoami`' });
    expect(result.steps[0].command!.code).toBe("echo '`whoami`'");
  });

  it('prevents dollar-sign injection', () => {
    const rawMarkdown = '# Test\n\n## 1. Deploy\n\n```bash\necho {{MSG}}\n```';
    const runbook = parseRunbookDocument(rawMarkdown);
    const result = substituteRunbookVariables(runbook, { MSG: '$(cat /etc/passwd)' });
    expect(result.steps[0].command!.code).toBe("echo '$(cat /etc/passwd)'");
  });
});

describe('expandLoopVariablesForCommand', () => {
  it('should shell-escape values', () => {
    expect(expandLoopVariablesForCommand('echo {{msg}}', { msg: 'hello world' }))
      .toBe("echo 'hello world'");
  });

  it('should pass through safe numeric values unquoted', () => {
    expect(expandLoopVariablesForCommand('echo {{Index}}', { Index: '3' }))
      .toBe('echo 3');
  });

  it('should preserve unmatched variables', () => {
    expect(expandLoopVariablesForCommand('{{batch}} and {{other}}', { batch: '1' }))
      .toBe('1 and {{other}}');
  });

  it('should shell-escape values with special characters', () => {
    expect(expandLoopVariablesForCommand('deploy {{target}}', { target: 'prod; drop db' }))
      .toBe("deploy 'prod; drop db'");
  });
});
