/**
 * Generic JSON-to-Markdown renderer.
 *
 * Converts any JSON structure to readable Markdown following structural
 * conventions. Schema-unaware — rendering is driven by the JSON shape itself.
 *
 * @module rdx-core
 */

import * as yaml from 'js-yaml';

/** Maximum heading depth (H6). */
const MAX_DEPTH = 6;

/**
 * Convert a field name or value to a Title Case heading.
 *
 * Splits on underscores and spaces, capitalizes every word.
 * Returns empty string for empty input.
 *
 * @param field - The field name (e.g. `architecture_and_approach`) or value (e.g. `Write failing test`)
 * @returns Title-cased heading text (e.g. `Architecture And Approach`), or empty string
 */
function toHeading(field: string): string {
  if (!field) return '';
  return field
    .split(/[_ ]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Escape pipe characters in a string for use in Markdown table cells.
 *
 * @param s - Cell content
 * @returns Escaped string safe for pipe tables
 */
function escapeCell(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/**
 * Emit a markdown heading at the given depth, clamped to H6.
 *
 * @param text - Heading text
 * @param depth - Heading depth (1 = H1, 6 = H6 max)
 * @returns Markdown heading line
 */
function heading(text: string, depth: number): string {
  const level = Math.min(depth, MAX_DEPTH);
  return `${'#'.repeat(level)} ${text}\n`;
}

/**
 * Check if a value is a code block shape: `{ language, content }`.
 *
 * @param value - The value to check
 * @returns True if value is an object with exactly `language` and `content` string fields
 */
function isCodeBlockShape(value: unknown): value is { language: string; content: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    keys.includes('language') &&
    keys.includes('content') &&
    typeof (value as Record<string, unknown>).language === 'string' &&
    typeof (value as Record<string, unknown>).content === 'string'
  );
}

/**
 * Check if all objects in an array have a `name` string field.
 *
 * @param arr - The array to check
 * @returns True if every element is an object with a string `name` field
 */
function isNamedObjectArray(
  arr: unknown[],
): arr is Array<Record<string, unknown> & { name: string }> {
  return arr.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      !Array.isArray(item) &&
      typeof (item as Record<string, unknown>).name === 'string',
  );
}

/**
 * Check if all items in an array are plain objects (not arrays, not null).
 *
 * @param arr - The array to check
 * @returns True if every element is a plain object
 */
function isObjectArray(arr: unknown[]): arr is Array<Record<string, unknown>> {
  return arr.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item));
}

/**
 * Render a pipe table from an array of objects.
 *
 * Column headers are the union of all keys across all elements.
 * Column order follows first-appearance insertion order.
 *
 * @param items - Array of objects to render as a table
 * @returns Markdown pipe table string
 */
function renderTable(items: Array<Record<string, unknown>>): string {
  // Collect all unique keys in insertion order
  const keys: string[] = [];
  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }

  const headers = keys.map(toHeading);
  const lines: string[] = [];

  // Header row
  lines.push(`| ${headers.join(' | ')} |`);
  // Separator row
  lines.push(`|${keys.map(() => '------').join('|')}|`);
  // Data rows
  for (const item of items) {
    const cells = keys.map((k) => {
      const val = item[k];
      if (val === undefined || val === null) return '';
      if (typeof val === 'string') return escapeCell(val);
      if (typeof val === 'number' || typeof val === 'boolean') return String(val);
      return escapeCell(JSON.stringify(val));
    });
    lines.push(`| ${cells.join(' | ')} |`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Render a value to markdown lines.
 *
 * @param value - The value to render
 * @param depth - Current heading depth
 * @param prefix - Numbering prefix for nested arrays (e.g. "1.")
 * @returns Array of markdown lines
 */
function renderValue(value: unknown, depth: number, prefix: string): string[] {
  const lines: string[] = [];

  // Null — omit entirely
  if (value === null || value === undefined) {
    return lines;
  }

  // String — paragraph
  if (typeof value === 'string') {
    lines.push(value);
    lines.push('');
    return lines;
  }

  // Number or boolean — string paragraph
  if (typeof value === 'number' || typeof value === 'boolean') {
    lines.push(String(value));
    lines.push('');
    return lines;
  }

  // Array
  if (Array.isArray(value)) {
    return renderArray(value, depth, prefix);
  }

  // Code block shape: { language, content }
  if (isCodeBlockShape(value)) {
    lines.push(`\`\`\`${value.language}`);
    lines.push(value.content);
    lines.push('```');
    lines.push('');
    return lines;
  }

  // Object — render fields as subsections
  if (typeof value === 'object') {
    return renderObjectFields(value as Record<string, unknown>, depth, prefix);
  }

  return lines;
}

/**
 * Render an array value to markdown lines.
 *
 * @param arr - The array to render
 * @param depth - Current heading depth
 * @param prefix - Numbering prefix for nested arrays
 * @returns Array of markdown lines
 */
function renderArray(arr: unknown[], depth: number, prefix: string): string[] {
  if (arr.length === 0) return [];

  // Array of objects with name — numbered sections
  if (isNamedObjectArray(arr)) {
    return renderNamedArray(arr, depth, prefix);
  }

  // Array of objects without name — pipe table
  if (isObjectArray(arr)) {
    return renderTable(arr).split('\n');
  }

  // Array of primitives — bullet list
  const lines: string[] = [];
  for (const item of arr) {
    lines.push(`- ${String(item)}`);
  }
  lines.push('');
  return lines;
}

/**
 * Render an array of named objects as numbered sections.
 * Elements render at the current depth (replacing the parent heading).
 *
 * Number format:
 * - Top-level (prefix=""): `1. Name` (dot after number)
 * - Nested (prefix="1."): `1.1 Name` (no trailing dot)
 *
 * Within a named item, simple values (strings, code) render inline
 * without field headings. Complex values (arrays, objects) get headings.
 *
 * @param arr - Array of objects with `name` fields
 * @param depth - Current heading depth
 * @param prefix - Numbering prefix (e.g. "1." for nested items)
 * @returns Array of markdown lines
 */
function renderNamedArray(
  arr: Array<Record<string, unknown> & { name: string }>,
  depth: number,
  prefix: string,
): string[] {
  const lines: string[] = [];

  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    const num = `${prefix}${String(i + 1)}`;
    const itemName = toHeading(item.name);
    // Top-level: "1. Name", nested: "1.1 Name"
    const separator = prefix ? ' ' : '. ';
    lines.push(heading(`${num}${separator}${itemName}`, depth));

    // Render remaining fields (excluding name) at depth + 1
    const childPrefix = `${num}.`;
    for (const [key, val] of Object.entries(item)) {
      if (key === 'name') continue;
      if (val === null || val === undefined) continue;
      if (Array.isArray(val) && val.length === 0) continue;

      // Code field — fenced code block (no heading)
      if (key === 'code') {
        if (typeof val === 'string') {
          lines.push('```');
          lines.push(val);
          lines.push('```');
          lines.push('');
        } else {
          lines.push(...renderValue(val, depth + 1, childPrefix));
        }
        continue;
      }

      // String — inline paragraph (no heading)
      if (typeof val === 'string') {
        lines.push(val);
        lines.push('');
        continue;
      }

      // Number/boolean — inline paragraph (no heading)
      if (typeof val === 'number' || typeof val === 'boolean') {
        lines.push(String(val));
        lines.push('');
        continue;
      }

      // Named array — replace heading
      if (Array.isArray(val) && val.length > 0 && isNamedObjectArray(val)) {
        lines.push(...renderNamedArray(val, depth + 1, childPrefix));
        continue;
      }

      // Complex values (arrays, objects) — emit heading then value
      lines.push(heading(toHeading(key), depth + 1));
      lines.push(...renderValue(val, depth + 2, childPrefix));
    }
  }

  return lines;
}

/**
 * Render object fields at the given depth.
 *
 * @param obj - Object whose fields to render
 * @param depth - Current heading depth
 * @param prefix - Numbering prefix for nested arrays
 * @returns Array of markdown lines
 */
function renderObjectFields(obj: Record<string, unknown>, depth: number, prefix: string): string[] {
  const lines: string[] = [];

  for (const [key, val] of Object.entries(obj)) {
    if (!key) continue;
    if (val === null || val === undefined) continue;
    if (Array.isArray(val) && val.length === 0) continue;

    // Code field — fenced code block
    if (key === 'code') {
      if (typeof val === 'string') {
        lines.push('```');
        lines.push(val);
        lines.push('```');
        lines.push('');
      } else {
        lines.push(...renderValue(val, depth, prefix));
      }
      continue;
    }

    // Named array — elements replace the field heading
    if (Array.isArray(val) && val.length > 0 && isNamedObjectArray(val)) {
      lines.push(...renderNamedArray(val, depth, prefix));
      continue;
    }

    // All other values — emit heading then value
    lines.push(heading(toHeading(key), depth));
    lines.push(...renderValue(val, depth + 1, prefix));
  }

  return lines;
}

/**
 * Render a JSON value to Markdown.
 *
 * Follows structural conventions:
 * - `name` field → H1 heading
 * - `meta` field → YAML frontmatter
 * - Named arrays → numbered sections (replacing parent heading)
 * - Unnamed object arrays → pipe tables
 * - Primitive arrays → bullet lists
 * - Code blocks detected by field name or `{ language, content }` shape
 *
 * @param data - The JSON data to render
 * @returns Markdown string
 */
export function renderToMarkdown(data: unknown): string {
  if (data === null || data === undefined) return '\n';
  if (Array.isArray(data)) return renderArray(data, 1, '').join('\n');
  if (typeof data === 'string') return `${data}\n`;
  if (typeof data === 'number' || typeof data === 'boolean') return `${String(data)}\n`;
  if (typeof data !== 'object') return '\n';

  const obj = data as Record<string, unknown>;
  const lines: string[] = [];

  // Extract meta → YAML frontmatter
  if (obj.meta !== undefined && obj.meta !== null) {
    lines.push('---');
    lines.push(yaml.dump(obj.meta, { lineWidth: -1 }).trimEnd());
    lines.push('---');
    lines.push('');
  }

  // Extract name → H1
  if (typeof obj.name === 'string') {
    lines.push(heading(obj.name, 1));
  }

  // Render remaining fields at depth 2
  for (const [key, val] of Object.entries(obj)) {
    if (!key || key === 'name' || key === 'meta' || key === '$schema') continue;
    if (val === null || val === undefined) continue;
    if (Array.isArray(val) && val.length === 0) continue;

    // Code field at root
    if (key === 'code') {
      if (typeof val === 'string') {
        lines.push('```');
        lines.push(val);
        lines.push('```');
        lines.push('');
      } else {
        lines.push(...renderValue(val, 2, ''));
      }
      continue;
    }

    // Named array — elements replace the field heading
    if (Array.isArray(val) && val.length > 0 && isNamedObjectArray(val)) {
      lines.push(...renderNamedArray(val, 2, ''));
      continue;
    }

    // All other values — emit H2 heading then value
    lines.push(heading(toHeading(key), 2));
    lines.push(...renderValue(val, 3, ''));
  }

  return lines.join('\n');
}
