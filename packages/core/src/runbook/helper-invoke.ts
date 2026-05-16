/**
 * Call-time validation for user-defined template helpers.
 *
 * User helpers declared via `.rundownrc` follow the contract
 * `(value: string) => string` — synchronous, string-in, string-out. The
 * registry already rejects clearly-broken shapes at load time
 * (non-functions, classes, `async function` declarations) but cannot detect
 * sync functions that nonetheless return a `Promise` or other non-string value
 * without invoking them. Validating at call time keeps user code from running
 * during CLI startup while still surfacing contract violations the first time
 * the helper is actually used.
 *
 * Both call sites (the OUTPUTS evaluator in core and the template renderer in
 * cli) route helper invocations through {@link invokeHelperSafely} so the
 * one-shot warning state and Promise-detection logic live in a single place.
 *
 * @module
 */

const warnedHelpers = new Set<string>();

/** Synchronous user-defined template helper contract. */
export type TemplateHelper = (value: string) => string;
/** Registry of template helpers keyed by helper name. */
export type TemplateHelperRegistry = ReadonlyMap<string, TemplateHelper>;

/**
 * Reset the per-process "already warned" set.
 *
 * Tests that exercise multiple helpers across multiple cases need a way to
 * observe each first-time warning independently. Production code should never
 * call this — the set is intentionally module-scoped so a misbehaving helper
 * warns once per CLI process, not per template expansion.
 */
export function resetHelperInvokeWarnings(): void {
  warnedHelpers.clear();
}

/**
 * Invoke a helper with the given argument and validate the return value.
 *
 * Catches three failure modes:
 * - the helper throws synchronously
 * - the helper returns a `Promise` (sync helper that's secretly async)
 * - the helper returns a non-string value (number, undefined, object, etc.)
 *
 * Each distinct failure mode emits a single `console.warn` per helper name
 * across the lifetime of the process; subsequent failures from the same
 * helper are silently treated as failures. Returned `Promise` values get a
 * no-op `.catch()` attached so they do not surface as unhandled rejections.
 *
 * @param helperName - Name the helper is registered under (used in warnings)
 * @param helper - Registered helper function from the {@link HelperRegistry}
 * @param argValue - String argument to pass to the helper
 * @returns The helper's string return value, or `undefined` when validation
 *   fails (matching the existing "helper threw" convention in
 *   `tryDispatchHelper` and the "return original match" path in the template
 *   renderer)
 */
export function invokeHelperSafely(
  helperName: string,
  helper: (value: string) => string,
  argValue: string,
): string | undefined {
  let result: unknown;
  try {
    result = (helper as (v: string) => unknown)(argValue);
  } catch (err) {
    if (!warnedHelpers.has(helperName)) {
      warnedHelpers.add(helperName);
      console.warn(`Warning: helper "${helperName}" threw at call time: ${String(err)}`);
    }
    return undefined;
  }

  if (result instanceof Promise) {
    // Swallow the rejection so a thrown-inside-async helper doesn't surface
    // as an unhandled rejection after we've already decided to drop the value.
    result.catch(() => {});
    if (!warnedHelpers.has(helperName)) {
      warnedHelpers.add(helperName);
      console.warn(
        `Warning: helper "${helperName}" returned a Promise — only synchronous helpers are supported.`,
      );
    }
    return undefined;
  }

  if (typeof result !== 'string') {
    if (!warnedHelpers.has(helperName)) {
      warnedHelpers.add(helperName);
      console.warn(
        `Warning: helper "${helperName}" returned a ${typeof result} — helpers must return a string.`,
      );
    }
    return undefined;
  }

  return result;
}

/**
 * Resolve a template helper call, preserving the original text on miss.
 *
 * @param helpers - Registry to search for the helper
 * @param helperName - Name of the helper to invoke
 * @param argValue - String argument to pass to the helper
 * @param original - Original template text to return when no helper applies
 * @returns Helper output or the original template text
 */
export function resolveTemplateHelperCall(
  helpers: TemplateHelperRegistry | undefined,
  helperName: string,
  argValue: string,
  original: string,
): string {
  if (helperName === 'artifact' || helperName === 'path') return original;
  const helper = helpers?.get(helperName);
  if (!helper) return original;
  return invokeHelperSafely(helperName, helper, argValue) ?? original;
}
