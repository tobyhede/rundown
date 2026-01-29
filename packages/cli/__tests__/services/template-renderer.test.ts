import { describe, it, expect } from '@jest/globals';
import { renderTemplate } from '../../src/services/template-renderer.js';

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
});
