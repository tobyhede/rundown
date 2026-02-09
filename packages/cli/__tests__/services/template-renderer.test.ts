import { describe, it, expect } from '@jest/globals';
import { renderTemplate, expandLoopVariables } from '../../src/services/template-renderer.js';

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

  it('should not affect dynamic step syntax {N}', () => {
    const markdown = '## {N}. Dynamic Step\n\n{{command}}';
    const variables = { command: 'echo hello' };

    const result = renderTemplate(markdown, variables);

    expect(result).toBe('## {N}. Dynamic Step\n\necho hello');
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
});
