/**
 * Serialize a value for CLI JSON output.
 *
 * Preserves the existing writer behavior around formatting and root values that
 * `JSON.stringify` cannot represent directly: `undefined`, symbols, and
 * functions are emitted as `null`. Native `JSON.stringify` errors, including
 * circular references and bigint values, are intentionally allowed to throw.
 *
 * @param data - Value to serialize for JSON output
 * @param pretty - Whether to pretty-print with two-space indentation
 * @returns Serialized JSON string, using `null` for non-serializable root values
 * @throws {TypeError} When `JSON.stringify` throws for the provided value
 */
export function serializeJsonForOutput(data: unknown, pretty = true): string {
  const stringify = JSON.stringify as (
    value: unknown,
    replacer?: null,
    space?: string | number,
  ) => string | undefined;
  const json = pretty ? stringify(data, null, 2) : stringify(data);
  return json ?? 'null';
}
