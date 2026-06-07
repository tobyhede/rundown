import { describe, expect, it } from '@jest/globals';
import { isBuiltinName, type TemplateNode } from '../../src/runbook/template/nodes.js';

describe('TemplateNode', () => {
  it('recognizes parser-owned built-in names', () => {
    expect(isBuiltinName('artifact')).toBe(true);
    expect(isBuiltinName('path')).toBe(true);
    expect(isBuiltinName('validateSchema')).toBe(true);
    expect(isBuiltinName('upper')).toBe(false);
  });

  it('supports exhaustive kind switching', () => {
    const render = (node: TemplateNode): string => {
      switch (node.kind) {
        case 'literal':
          return node.text;
        case 'variable':
          return node.name;
        case 'userHelper':
          return node.name;
        case 'builtinHelper':
          return node.name;
      }
    };
    expect(render({ kind: 'literal', text: 'x' })).toBe('x');
  });
});
