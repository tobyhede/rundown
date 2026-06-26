/**
 * YAML loading helpers with stable parsing semantics across js-yaml versions.
 *
 * js-yaml 5.0.0 introduced two behaviour changes that the rest of the
 * codebase relies on the previous defaults for:
 *
 * 1. The default `load` schema changed from the YAML 1.1 schema to
 *    {@link https://yaml.org/spec/1.2.2/ | YAML 1.2}'s `CORE_SCHEMA`. The core
 *    schema drops the legacy `!!timestamp`, `!!binary`, and `!!set` tags, so a
 *    bare timestamp such as `2026-03-20` now parses to a `string` instead of a
 *    JavaScript `Date`. Rundown's variable router deliberately detects and
 *    stringifies non-JSON values (Dates, Buffers, Sets), so we keep the YAML 1.1
 *    schema to preserve that behaviour.
 * 2. An empty document (empty string, whitespace, or comment-only) now throws
 *    `YAMLException: expected a document, but the input is empty` instead of
 *    returning `undefined`. Callers treat an empty config file as "no
 *    variables", so {@link loadYaml} restores the `undefined` return.
 *
 * Centralising both fixes here keeps every direct `js-yaml` consumer on the
 * same parsing contract rather than each call site re-deriving it.
 *
 * @module
 */

import { load as yamlLoad, YAML11_SCHEMA, type LoadOptions } from 'js-yaml';

/**
 * Detect a YAML document that contains no node.
 *
 * js-yaml 5.0.0 throws for these inputs rather than returning `undefined`, so we
 * short-circuit before calling `load`. A document is empty when, after stripping
 * comment lines and surrounding whitespace, nothing remains.
 *
 * @param content - Raw YAML source text
 * @returns True when the document has no parseable content
 */
function isEmptyYamlDocument(content: string): boolean {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith('#')) {
      return false;
    }
  }
  return true;
}

/**
 * Parse a YAML document using Rundown's stable parsing contract.
 *
 * Uses the YAML 1.1 schema (so `Date`, `Buffer`, and `Set` values are produced
 * as in js-yaml 4.x) and returns `undefined` for empty documents instead of
 * throwing. Pass additional {@link LoadOptions} to override defaults; an
 * explicit `schema` option takes precedence over the YAML 1.1 default.
 *
 * @param content - Raw YAML source text
 * @param options - Optional js-yaml load options (merged over the YAML 1.1 default schema)
 * @returns The parsed value, or `undefined` when the document is empty
 * @throws {import('js-yaml').YAMLException} When the content is not valid YAML
 */
export function loadYaml(content: string, options?: LoadOptions): unknown {
  if (isEmptyYamlDocument(content)) {
    return undefined;
  }
  return yamlLoad(content, { schema: YAML11_SCHEMA, ...options });
}
