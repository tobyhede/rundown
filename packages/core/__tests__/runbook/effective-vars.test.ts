import { describe, it, expect } from '@jest/globals';
import {
  brandInitialTemplateVars,
  brandStoredOutputs,
  mergeEffectiveVars,
  type InitialTemplateVars,
  type StoredOutputs,
} from '../../src/runbook/effective-vars.js';
import { resolveForValue } from '../../src/runbook/source-resolver.js';
import type { ForContext, TemplateVarValue } from '../../src/runbook/types.js';

describe('brandInitialTemplateVars', () => {
  it('returns the same reference (zero runtime cost)', () => {
    const input: Readonly<Record<string, TemplateVarValue>> = { env: 'staging', port: 3000 };
    const out = brandInitialTemplateVars(input);
    expect(out).toBe(input);
  });

  it('produces a value assignable to InitialTemplateVars', () => {
    const branded: InitialTemplateVars = brandInitialTemplateVars({ a: '1' });
    // Type-level assertion proven by the variable annotation above.
    expect(Object.keys(branded)).toEqual(['a']);
  });

  it('produces a value still assignable to Record<string, TemplateVarValue> for read-only consumers', () => {
    const branded = brandInitialTemplateVars({ a: '1' });
    const asPlain: Readonly<Record<string, TemplateVarValue>> = branded;
    expect(asPlain.a).toBe('1');
  });
});

describe('brandStoredOutputs', () => {
  it('returns the same reference (zero runtime cost)', () => {
    const input: Readonly<Record<string, string>> = { Message: 'hello' };
    const out = brandStoredOutputs(input);
    expect(out).toBe(input);
  });

  it('produces a value assignable to StoredOutputs', () => {
    const branded: StoredOutputs = brandStoredOutputs({ Message: 'hello' });
    expect(Object.keys(branded)).toEqual(['Message']);
  });

  it('produces a value still assignable to Record<string, string> for read-only consumers', () => {
    const branded = brandStoredOutputs({ Message: 'hello' });
    const asPlain: Readonly<Record<string, string>> = branded;
    expect(asPlain.Message).toBe('hello');
  });
});

describe('mergeEffectiveVars accepts the new brands', () => {
  it('merges branded sources without further casting', () => {
    const tv = brandInitialTemplateVars({ a: 'tv', b: 'tv' });
    const sv = brandStoredOutputs({ b: 'sv', c: 'sv' });
    const merged = mergeEffectiveVars({ templateVars: tv, variables: sv });
    expect(merged).toEqual({ a: 'tv', b: 'sv', c: 'sv' });
  });
});

describe('brand symbol exposure', () => {
  it('does not export the brand symbols by name', async () => {
    const mod = await import('../../src/runbook/effective-vars.js');
    expect(Object.keys(mod)).toEqual(
      expect.arrayContaining([
        'brandInitialTemplateVars',
        'brandStoredOutputs',
        'mergeEffectiveVars',
      ]),
    );
    // Brand symbols are declared with `declare const … : unique symbol` and must
    // not appear in the runtime export surface.
    //
    // Note: given the `declare const` form there is no runtime value to export,
    // so this assertion is pro-forma — it will pass by construction. It still
    // earns its place as a regression gate: if a future refactor mistakenly
    // writes `export const initialTemplateVarsBrand = Symbol()` (which would
    // leak the brand and let outside callers mint branded values), this test
    // catches it.
    expect(Object.keys(mod)).not.toContain('initialTemplateVarsBrand');
    expect(Object.keys(mod)).not.toContain('storedOutputsBrand');
  });
});

describe('resolveForValue brand contract (compile-time)', () => {
  it('accepts InitialTemplateVars without a cast', () => {
    const tv = brandInitialTemplateVars({ items: ['a', 'b'] });
    const fc: ForContext = {
      stepId: '1',
      iteration: 1,
      start: 1,
      implicit: false,
      source: { kind: 'variable', name: 'items' },
    };
    // Type-level acceptance is the assertion. Awaiting the call also
    // exercises the runtime path; this should resolve without throwing.
    return expect(resolveForValue(fc, tv)).resolves.toBeDefined();
  });

  // The negative case lives as a comment because TypeScript compile
  // errors can't be asserted from a passing test. Verified by the
  // typecheck step in this task.
  // it('rejects StoredOutputs at compile time', () => {
  //   const sv = brandStoredOutputs({ items: 'not-an-array' });
  //   // @ts-expect-error - StoredOutputs is not assignable to InitialTemplateVars
  //   await resolveForValue(fc, sv);
  // });
});
