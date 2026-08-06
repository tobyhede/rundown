/**
 * `frameKeyForCursor` is the only frame-key derivation in `src/runbook`.
 *
 * The behavioural half of this guarantee lives in `targeting.test.ts`, which
 * drives each known consumer against a FOR stack whose top names a foreign
 * step. This file covers the sites that do not exist yet: it scans the source
 * for the *shape* of the rule `frameKeyForCursor` replaced — a conditional on
 * `<ctx>.implicit` yielding `<ctx>.iteration`, which filters implicit contexts
 * but never compares `stepId`.
 *
 * A hit is not necessarily a live bug. `initForStack` always returns a
 * single-element stack naming the step being entered, so the two rules agree on
 * every stack reachable today — which is exactly why a re-introduced local
 * rewrite would land silently and stay latent until nesting or a new entry path
 * makes it reachable. By then it is a mis-keyed frame: a delegation issued
 * under one key and looked up under another, and an entry ordinal the machine
 * and committed-state readers disagree about.
 *
 * Named `*.source-text.test.ts` per the convention in `jest.config.shared.js`:
 * it asserts on `src/**` text, which Stryker rewrites during instrumentation,
 * so the sandbox must not collect it.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every `.ts` file under a directory, recursively.
 *
 * @param dir - Absolute directory to walk.
 * @returns Absolute paths of the TypeScript files found.
 */
function typeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? typeScriptFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

describe('frame-key derivation is single-sourced', () => {
  it('leaves no module re-deriving a frame iteration from a raw stack top', () => {
    const root = fileURLToPath(new URL('../../src/runbook', import.meta.url));
    const files = typeScriptFiles(root);
    // A scan that finds nothing passes for the wrong reason.
    expect(files.length).toBeGreaterThan(0);

    // Matches `activeFor && !activeFor.implicit ? activeFor.iteration : ...`
    // and `top && !top.implicit ? top.iteration : ...` — the exact text every
    // migrated site used to carry. `getActiveForContext`, the one legitimate
    // reader of `.implicit`, tests it in a statement of its own and so does not
    // match.
    const unguarded = /\.implicit[^;{}]*\.iteration/s;
    const offenders = files.filter((file) => unguarded.test(readFileSync(file, 'utf8')));

    expect(offenders.map((file) => relative(root, file))).toEqual([]);
  });
});
