// packages/core/__tests__/runbook/rd819-dependents.source-text.test.ts
//
// Enforcement half of the RD-819 dependency enumeration (#703).
//
// Three authority decisions lean on RD-819 (`DELEGATION_NESTED_FORBIDDEN`)
// instead of enforcing their own condition, because the prohibition makes the
// state they would otherwise have to handle impossible to CONSTRUCT. That is
// also why none of them can be pinned by behaviour: there is no state to drive
// them into while the guard holds, so a behavioural test would have nothing to
// assert. `create-delegation.test.ts` pins RD-819 itself, but that test failing
// is the EXPECTED signal when someone deliberately lifts the prohibition — they
// update it as part of the work, and nothing then connects that edit to the
// three exemptions.
//
// So the failure mode is not "the invariant silently breaks". It is "the
// invariant is deliberately relaxed, and three authority decisions silently stop
// being sound". The only artifact that survives into that moment is the
// enumeration comment at the `createDelegation` guard — so this file makes that
// comment load-bearing.
//
// KEYED ON MARKERS, NOT PROSE. Both ends of the link carry an explicit
// `RD-819-DEPENDENT: <name>` token: one per site, and one per entry in the
// enumeration. A source-text test that matched the surrounding sentences would
// fail on a comment reflow and teach everyone to distrust it; a token exists FOR
// this test, so anyone editing around it can see that it means something. The
// one place prose is read — the count word in "THREE OTHER SITES LEAN ON THIS
// INVARIANT" — is whitespace-normalised first, so reflow is safe there too.
//
// A MARKER NAMES A SITE, NOT A CHECK. One exemption can suppress several checks
// that each rest on RD-819 by a different argument — `guardOpenChildren`
// suppresses three, of which the `delegation_collection_pending` re-check is
// sound by a route the open-children claims-set argument does not cover. The
// enumeration lists those separately in prose, because a reader auditing the
// exemption needs each argument spelled out. They are NOT separate markers:
// there is one boolean in the code, so a second marker would have no distinct
// site to name, would make "marked exactly once" meaningless, and would put the
// count word out of step with the sites it counts. A bullet elaborating an
// already-marked site therefore carries no marker of its own.
//
// WHAT IS NOT COVERED: the scan is confined to `packages/core/src`. A fourth
// dependent landing in another package would not be found, because reaching
// outside the package would force the `*.repo-asset.test.ts` rename (CLAUDE.md
// § Testing Conventions) and cost that package its mutation coverage. All three
// of today's dependents are in core; a cross-package one is a different problem.
//
// Named `*.source-text.test.ts` because it reads `src/**` files as STRINGS.
// Inside Stryker's sandbox every mutate-matched source file is instrumented, so
// the tokens it scans for are rewritten and the scan finds nothing.
// `jest.config.shared.js` excludes this pattern in the sandbox and runs it
// normally. It asserts on source text, not behaviour, so it contributes nothing
// to mutation coverage.

import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to this package's `src` tree — the whole universe of the scan. */
const CORE_SRC = fileURLToPath(new URL('../../src', import.meta.url));

/** Absolute path to the module owning the RD-819 guard and its enumeration. */
const GUARD_MODULE = join(CORE_SRC, 'runbook', 'delegation-service.ts');

/** Opens the enumeration block attached to the RD-819 guard. */
const ENUMERATION_HEADER = 'RD-819-DEPENDENTS:';

/**
 * Names one site whose soundness rests on RD-819. Used on BOTH ends of the link:
 * once at the site, once per entry in the enumeration.
 *
 * The token must be bare (`(?<!\`)`) and followed by a same-line identifier
 * (`[ \t]+`): prose that quotes the marker inside backticks, or mentions it
 * without naming a site, is discussion of the convention and must not register as
 * a fourth dependent.
 */
const DEPENDENT_MARKER = /(?<!`)RD-819-DEPENDENT:[ \t]+([A-Za-z_$][\w$]*)/g;

/**
 * The guard the enumeration documents. Tolerant of spacing, strict about the
 * condition, so narrowing it (an added conjunct) detaches the enumeration.
 */
const GUARD_STATEMENT = /^if \(\s*state\.parentLinkage\?\.kind\s*===\s*'delegation'\s*\) \{$/;

/** Count words the enumeration prose may open with, indexed by the value they name. */
const COUNT_WORDS = [
  'ZERO',
  'ONE',
  'TWO',
  'THREE',
  'FOUR',
  'FIVE',
  'SIX',
  'SEVEN',
  'EIGHT',
  'NINE',
  'TEN',
];

/** Prose sentence whose count word must agree with the number of entries. */
const COUNT_SENTENCE = /\b([A-Z]+) OTHER SITES? LEANS? ON THIS INVARIANT\b/i;

/** The dependents that exist today. A legitimate change to this set is a review event. */
const KNOWN_DEPENDENTS = ['guardOpenChildren', 'skipOpenClaims', 'transitionDelegationRuntime'];

/**
 * How many lines below its marker a site's named symbol may sit and still count
 * as "the site this marker names". The largest gap among today's dependents is
 * `guardOpenChildren` (marker to `const`, ~24 lines through an intervening
 * comment block), so this leaves generous headroom for reflow while still
 * excluding the same name's distant reuse elsewhere in the file.
 */
const MARKER_SITE_WINDOW = 60;

/** The enumeration block, and enough of its surroundings to prove it is still attached. */
interface Enumeration {
  /** The contiguous `//` block introduced by the header, or `''` when absent. */
  readonly block: string;
  /** First non-blank line after the block, trimmed; `''` when the block is absent. */
  readonly nextStatement: string;
  /** `delegation-service.ts` with the block removed, so the site scan cannot see it. */
  readonly moduleWithoutBlock: string;
}

/**
 * Every `.ts` file under this package's `src` tree.
 *
 * @param dir - Absolute directory to walk.
 * @returns Absolute paths, in directory-entry order.
 */
function typeScriptFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...typeScriptFilesUnder(path));
    } else if (entry.isFile() && path.endsWith('.ts')) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Read the enumeration block attached to the RD-819 guard.
 *
 * The block runs from the header marker to the last contiguous `//` line, so it
 * survives any amount of reflow within itself. Returns empty fields rather than
 * throwing when the header is gone: that is a REPORTABLE failure, and a throw at
 * describe-scope would collapse every assertion into one opaque suite error.
 *
 * @returns The block, the statement it must precede, and the module without it.
 */
function readEnumeration(): Enumeration {
  const source = readFileSync(GUARD_MODULE, 'utf-8');
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.includes(ENUMERATION_HEADER));
  if (start === -1) {
    return { block: '', nextStatement: '', moduleWithoutBlock: source };
  }
  let end = start;
  while (end + 1 < lines.length && lines[end + 1].trim().startsWith('//')) {
    end += 1;
  }
  const after = lines.slice(end + 1).find((line) => line.trim().length > 0) ?? '';
  return {
    block: lines.slice(start, end + 1).join('\n'),
    nextStatement: after.trim(),
    moduleWithoutBlock: [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n'),
  };
}

/**
 * Site names marked `RD-819-DEPENDENT:` in a chunk of source.
 *
 * @param text - Source text to scan.
 * @returns Marked names, in source order, duplicates preserved.
 */
function markedNames(text: string): string[] {
  return [...text.matchAll(DEPENDENT_MARKER)].map((match) => match[1]);
}

/**
 * Site markers in a source string, each paired with the window of source
 * immediately below it in which its named symbol is expected to appear.
 *
 * The window ANCHORS the existence check to the marker's own site. A package-wide
 * "does this name appear anywhere in core" check false-greens whenever the name
 * is independently reused: `guardOpenChildren` is also a boolean parameter at
 * eight unrelated call sites, so orphaning its marker would still find those and
 * pass — exactly the deleted/renamed-site case the check exists to catch. Binding
 * the check to the lines directly below the marker excludes that distant reuse.
 *
 * @param text - Source text to scan.
 * @returns One entry per marker, in source order, each with its lookahead window.
 */
function markerSites(text: string): { name: string; window: string }[] {
  const lines = text.split('\n');
  return [...text.matchAll(DEPENDENT_MARKER)].map((match) => {
    const markerLine = text.slice(0, match.index).split('\n').length - 1;
    return {
      name: match[1],
      window: lines.slice(markerLine + 1, markerLine + 1 + MARKER_SITE_WINDOW).join('\n'),
    };
  });
}

/**
 * Whether `name` occurs as CODE — not inside a comment — in a chunk of source.
 *
 * Skips whole-line comments (`//`, `/*`, and ` * ` JSDoc bodies) and trailing
 * line comments, so a marker's own prose, which names the very symbol it marks,
 * cannot satisfy the check on its own. Crude and line-based by design: it runs
 * over a bounded window, not the whole tree, so it needs no parser.
 *
 * @param text - Source window to scan.
 * @param name - Identifier to look for.
 * @returns True when the identifier occurs on a code line.
 */
function appearsAsCode(text: string, name: string): boolean {
  // `DEPENDENT_MARKER` admits `$` in a name, which is regex syntax rather than a
  // `\b` word character — `\b$foo\b` would anchor mid-pattern and never match.
  // So escape the name and spell the identifier boundaries out instead.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`);
  return text.split('\n').some((line) => {
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) {
      return false;
    }
    return word.test(line.replace(/\/\/.*$/, ''));
  });
}

/**
 * Collapse a `//` comment block to a single normalised line.
 *
 * Strips the comment prefixes and collapses runs of whitespace, so a reflowed
 * sentence still matches the phrase it is made of.
 *
 * @param block - A contiguous run of `//` comment lines.
 * @returns The prose on one line, single-spaced.
 */
function normaliseCommentProse(block: string): string {
  return block
    .replace(/^\s*\/\/ ?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('RD-819 dependents stay linked to the guard they lean on (#703)', () => {
  const enumeration = readEnumeration();
  const enumerated = markedNames(enumeration.block);

  const sourceFiles = typeScriptFilesUnder(CORE_SRC);
  const sites = new Map<string, string[]>();
  const siteMarkers: { name: string; file: string; window: string }[] = [];
  for (const file of sourceFiles) {
    const text =
      file === GUARD_MODULE ? enumeration.moduleWithoutBlock : readFileSync(file, 'utf-8');
    const rel = relative(CORE_SRC, file);
    for (const { name, window } of markerSites(text)) {
      sites.set(name, [...(sites.get(name) ?? []), rel]);
      siteMarkers.push({ name, file: rel, window });
    }
  }

  it('scans this package (sanity: the walk is not vacuous)', () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
    expect(enumeration.block).not.toBe('');
  });

  it('still names the three known dependents', () => {
    // Relaxing RD-819 must revisit each of these, not merely delete them. If
    // this fails because a dependent was legitimately retired, updating the list
    // here is the acknowledgement that the retirement was deliberate.
    expect([...enumerated].sort()).toEqual(KNOWN_DEPENDENTS);
  });

  it('keeps the enumeration attached to the RD-819 guard it documents', () => {
    // The enumeration is worth nothing detached from the guard: it exists to be
    // read by whoever edits that condition. Removing the guard, moving it away
    // from the block, or narrowing the condition with an extra conjunct all land
    // here.
    expect(enumeration.nextStatement).toMatch(GUARD_STATEMENT);
  });

  it('enumerates exactly the sites marked RD-819-DEPENDENT in core source', () => {
    // Both directions. Left-to-right: an entry whose site lost its marker or
    // vanished. Right-to-left: a fourth site that took RD-819 as a soundness
    // premise without being listed where the prohibition is enforced.
    expect([...enumerated].sort()).toEqual([...sites.keys()].sort());
  });

  it('marks each dependent site exactly once', () => {
    // A name marked twice makes the set comparison above satisfiable by a
    // copy-pasted marker rather than by a real second site.
    expect([...sites].filter(([, files]) => files.length > 1)).toEqual([]);
  });

  it('names a symbol that still exists as code below its marker', () => {
    // Catches a site deleted or renamed while its marker comment was left behind,
    // which the set comparison alone would read as a healthy link. Bound to the
    // window directly below each marker, NOT to the whole package: several
    // dependents' names are independently reused elsewhere in core
    // (`guardOpenChildren` is a boolean parameter at eight unrelated sites), and a
    // package-wide existence check would read that reuse as a live link and
    // false-green on exactly the orphaned marker this asserts against.
    const orphaned = siteMarkers
      .filter(({ name, window }) => !appearsAsCode(window, name))
      .map(({ name, file }) => `${name} (${file})`);
    expect(orphaned).toEqual([]);
  });

  it('binds the existence check to the marker, not to distant reuse of the name', () => {
    // Regression guard for that false-green: a marker whose site is gone but whose
    // name survives far below — as an unrelated parameter, say — must NOT pass.
    const attached = markerSites(
      ['// RD-819-DEPENDENT: sample', 'const sample = true;'].join('\n'),
    );
    expect(appearsAsCode(attached[0].window, 'sample')).toBe(true);

    const orphaned = markerSites(
      [
        '// RD-819-DEPENDENT: sample',
        ...Array.from({ length: MARKER_SITE_WINDOW + 5 }, () => '// filler'),
        'function unrelated(sample: boolean) {}',
      ].join('\n'),
    );
    expect(appearsAsCode(orphaned[0].window, 'sample')).toBe(false);
  });

  it('agrees with the count word in the enumeration prose', () => {
    // Deleting an entry without updating the sentence that counts them fails
    // here. Read from whitespace-normalised prose, so a reflow does not.
    const counted = COUNT_SENTENCE.exec(normaliseCommentProse(enumeration.block));
    expect(counted).not.toBeNull();
    expect(counted?.[1].toUpperCase()).toBe(COUNT_WORDS[enumerated.length]);
  });
});
