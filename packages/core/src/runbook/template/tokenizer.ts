import type { TemplateArg, TemplateNode } from './nodes.js';
import { isBuiltinName } from './nodes.js';

/**
 * Maximum interior whitespace, per side, accepted between `{{`/`}}` and the
 * token body. Mirrors the bound the prior pass-order regexes enforced so
 * malformed placeholders padded with excessive whitespace stay literal.
 */
const MAX_EDGE_WHITESPACE = 64;

const PATH_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+))*$/;
const HELPER_PATTERN =
  /^([a-zA-Z_][a-zA-Z0-9_]*)[ \t\r\n]{1,64}((?:[a-zA-Z_][a-zA-Z0-9_]*(?:\.(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+))*)|"[^"]*")$/;

/**
 * Tokenize a template string in a single source scan.
 *
 * Invalid or unsupported `{{ ... }}` forms are left as literal text because
 * current rendering preserves unknown placeholders. Quoted helper literals
 * containing `}}` are unsupported and are preserved literally by design.
 *
 * @param text - Template text
 * @returns Ephemeral token nodes for one render call
 */
export function tokenizeTemplate(text: string): TemplateNode[] {
  const nodes: TemplateNode[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const open = text.indexOf('{{', cursor);
    if (open === -1) {
      pushLiteral(nodes, text.slice(cursor));
      break;
    }

    const close = text.indexOf('}}', open + 2);
    if (close === -1) {
      pushLiteral(nodes, text.slice(cursor));
      break;
    }

    if (open > cursor) {
      pushLiteral(nodes, text.slice(cursor, open));
    }

    const raw = text.slice(open, close + 2);
    const node = classify(raw);
    if (node) {
      nodes.push(node);
    } else {
      pushLiteral(nodes, raw);
    }

    cursor = close + 2;
  }

  return nodes;
}

function pushLiteral(nodes: TemplateNode[], text: string): void {
  if (text === '') return;
  if (nodes.length > 0) {
    const previous = nodes[nodes.length - 1];
    if (previous.kind === 'literal') {
      nodes[nodes.length - 1] = { kind: 'literal', text: previous.text + text };
      return;
    }
  }
  nodes.push({ kind: 'literal', text });
}

function classify(raw: string): TemplateNode | undefined {
  const interior = raw.slice(2, -2);
  // Preserve malformed placeholders padded with excessive whitespace literally,
  // matching the prior regex bound; the trim below is otherwise unbounded.
  if (
    interior.length - interior.trimStart().length > MAX_EDGE_WHITESPACE ||
    interior.length - interior.trimEnd().length > MAX_EDGE_WHITESPACE
  ) {
    return undefined;
  }

  const inner = interior.trim();
  if (inner.startsWith('./')) {
    const explicit = inner.slice(2).trim();
    if (!PATH_PATTERN.test(explicit)) return undefined;
    return { kind: 'variable', name: explicit, explicit: true, raw };
  }

  if (PATH_PATTERN.test(inner)) {
    return { kind: 'variable', name: inner, explicit: false, raw };
  }

  const helperMatch = HELPER_PATTERN.exec(inner);
  if (!helperMatch) return undefined;

  const [, helperName, rawArg] = helperMatch;
  const arg = parseArg(rawArg);
  if (isBuiltinName(helperName)) {
    return { kind: 'builtinHelper', name: helperName, arg, raw };
  }
  return { kind: 'userHelper', name: helperName, arg, raw };
}

function parseArg(rawArg: string): TemplateArg {
  if (rawArg.startsWith('"') && rawArg.endsWith('"')) {
    return { kind: 'literal', value: rawArg.slice(1, -1) };
  }
  return { kind: 'ref', name: rawArg };
}
