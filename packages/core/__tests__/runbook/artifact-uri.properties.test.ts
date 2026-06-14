import { describe, expect, it } from '@jest/globals';
import * as fc from 'fast-check';
import {
  latestArtifactRecordsByManifestGroup,
  matchesArtifactSelectorCreated,
  matchesArtifactSelectorModified,
  matchesArtifactSelectorRunbook,
  matchesArtifactSelectorSource,
  parseArtifactUri,
  type ArtifactSelectorQuery,
  type ArtifactSelectorSourceFilter,
} from '../../src/runbook/artifact-uri.js';

// Epoch-ms range kept well inside JS safe-date bounds so `new Date(ms).toISOString()`
// always yields a canonical, z.iso.datetime()-valid string that round-trips exactly.
const EPOCH_MS_MIN = 0; // 1970-01-01
const EPOCH_MS_MAX = 4_102_444_800_000; // 2100-01-01
const msArb = fc.integer({ min: EPOCH_MS_MIN, max: EPOCH_MS_MAX });
const isoFromMs = (ms: number): string => new Date(ms).toISOString();

const RUNBOOK_PATHS = [
  'a.runbook.md',
  'b.runbook.md',
  'planning/review.runbook.md',
  'ops/deploy.runbook.md',
  '/tmp/external/review.runbook.md',
] as const;
const SOURCES: readonly ArtifactSelectorSourceFilter[] = [
  'project',
  'plugin',
  'bundled',
  'external',
];
const KEYS = ['plan.json', 'review.json', 'output.json'] as const;

describe('parseQuery round-trip properties', () => {
  // A canonical spec of selector filters that we render to a URI query string and
  // parse back, asserting the parsed ArtifactSelectorQuery matches by construction.
  const querySpecArb = fc.record({
    runbook: fc.array(fc.constantFrom(...RUNBOOK_PATHS), { maxLength: 3 }),
    source: fc.array(fc.constantFrom(...SOURCES), { maxLength: 3 }),
    createdAfter: fc.option(msArb, { nil: undefined }),
    createdBefore: fc.option(msArb, { nil: undefined }),
    modifiedAfter: fc.option(msArb, { nil: undefined }),
    modifiedBefore: fc.option(msArb, { nil: undefined }),
    latest: fc.boolean(),
  });

  function buildSelectorUri(spec: QuerySpec): string {
    const params: string[] = [];
    for (const value of spec.runbook) params.push(`runbook=${encodeURIComponent(value)}`);
    for (const value of spec.source) params.push(`source=${value}`);
    for (const key of [
      'createdAfter',
      'createdBefore',
      'modifiedAfter',
      'modifiedBefore',
    ] as const) {
      const ms = spec[key];
      if (ms !== undefined) params.push(`${key}=${encodeURIComponent(isoFromMs(ms))}`);
    }
    if (spec.latest) params.push('latest=true');
    const query = params.length > 0 ? `?${params.join('&')}` : '';
    return `rd://artifacts/ctx1/*/review.json${query}`;
  }

  type QuerySpec = {
    runbook: string[];
    source: ArtifactSelectorSourceFilter[];
    createdAfter?: number;
    createdBefore?: number;
    modifiedAfter?: number;
    modifiedBefore?: number;
    latest: boolean;
  };

  function expectedQuery(spec: QuerySpec): ArtifactSelectorQuery {
    return {
      ...(spec.runbook.length > 0 ? { runbook: spec.runbook } : {}),
      ...(spec.source.length > 0 ? { source: spec.source } : {}),
      ...(spec.createdAfter !== undefined ? { createdAfter: spec.createdAfter } : {}),
      ...(spec.createdBefore !== undefined ? { createdBefore: spec.createdBefore } : {}),
      ...(spec.modifiedAfter !== undefined ? { modifiedAfter: spec.modifiedAfter } : {}),
      ...(spec.modifiedBefore !== undefined ? { modifiedBefore: spec.modifiedBefore } : {}),
      ...(spec.latest ? { latest: true as const } : {}),
    };
  }

  it('parses a rendered selector URI back to the canonical typed query', () => {
    fc.assert(
      fc.property(querySpecArb, (spec) => {
        const ref = parseArtifactUri(buildSelectorUri(spec));
        expect(ref.kind).toBe('selector');
        expect(ref.query).toEqual(expectedQuery(spec));
      }),
    );
  });

  it('preserves repeated runbook/source filters in URI order (OR within key)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...RUNBOOK_PATHS), { minLength: 1, maxLength: 4 }),
        fc.array(fc.constantFrom(...SOURCES), { minLength: 1, maxLength: 4 }),
        (runbook, source) => {
          const ref = parseArtifactUri(buildSelectorUri({ runbook, source, latest: false }));
          expect(ref.query.runbook).toEqual(runbook);
          expect(ref.query.source).toEqual(source);
        },
      ),
    );
  });
});

describe('selector matcher composition properties', () => {
  it('matchesArtifactSelectorRunbook is exact OR membership; empty/undefined match all', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RUNBOOK_PATHS),
        fc.array(fc.constantFrom(...RUNBOOK_PATHS), { maxLength: 4 }),
        (pathValue, filters) => {
          const expected = filters.length === 0 ? true : filters.includes(pathValue);
          expect(matchesArtifactSelectorRunbook(pathValue, filters)).toBe(expected);
          expect(matchesArtifactSelectorRunbook(pathValue, undefined)).toBe(true);
        },
      ),
    );
  });

  it('matchesArtifactSelectorSource is exact OR membership; empty/undefined match all', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SOURCES),
        fc.array(fc.constantFrom(...SOURCES), { maxLength: 4 }),
        (sourceValue, filters) => {
          const expected = filters.length === 0 ? true : filters.includes(sourceValue);
          expect(matchesArtifactSelectorSource(sourceValue, filters)).toBe(expected);
          expect(matchesArtifactSelectorSource(sourceValue, undefined)).toBe(true);
        },
      ),
    );
  });

  it('created bounds are strict and AND-composed; a value on either bound is excluded', () => {
    fc.assert(
      fc.property(msArb, msArb, msArb, (tsMs, a, b) => {
        const ts = isoFromMs(tsMs);
        const lowerOnly = matchesArtifactSelectorCreated(ts, { createdAfter: a });
        const upperOnly = matchesArtifactSelectorCreated(ts, { createdBefore: b });
        const both = matchesArtifactSelectorCreated(ts, { createdAfter: a, createdBefore: b });
        // Window membership equals the conjunction of the two half-bounds.
        expect(both).toBe(lowerOnly && upperOnly);
        // Strict exclusive bounds: a timestamp exactly on a bound never matches.
        expect(matchesArtifactSelectorCreated(ts, { createdAfter: tsMs })).toBe(false);
        expect(matchesArtifactSelectorCreated(ts, { createdBefore: tsMs })).toBe(false);
        // No bound: always matches (timestamp is parseable).
        expect(matchesArtifactSelectorCreated(ts, {})).toBe(true);
      }),
    );
  });

  it('lowering createdAfter is monotonic: a match is never lost by widening the bound', () => {
    fc.assert(
      fc.property(msArb, msArb, msArb, (tsMs, boundA, delta) => {
        const ts = isoFromMs(tsMs);
        const wider = boundA - Math.abs(delta);
        if (matchesArtifactSelectorCreated(ts, { createdAfter: boundA })) {
          expect(matchesArtifactSelectorCreated(ts, { createdAfter: wider })).toBe(true);
        }
      }),
    );
  });

  it('modified bounds are strict and AND-composed; a value on either bound is excluded', () => {
    fc.assert(
      fc.property(msArb, msArb, msArb, (mtime, a, b) => {
        const lowerOnly = matchesArtifactSelectorModified(mtime, { modifiedAfter: a });
        const upperOnly = matchesArtifactSelectorModified(mtime, { modifiedBefore: b });
        const both = matchesArtifactSelectorModified(mtime, {
          modifiedAfter: a,
          modifiedBefore: b,
        });
        expect(both).toBe(lowerOnly && upperOnly);
        expect(matchesArtifactSelectorModified(mtime, { modifiedAfter: mtime })).toBe(false);
        expect(matchesArtifactSelectorModified(mtime, { modifiedBefore: mtime })).toBe(false);
        expect(matchesArtifactSelectorModified(mtime, {})).toBe(true);
      }),
    );
  });

  it('created and modified filters read disjoint query fields (independence)', () => {
    fc.assert(
      fc.property(msArb, msArb, msArb, (tsMs, mtime, bound) => {
        const ts = isoFromMs(tsMs);
        // Adding modified bounds never changes the created verdict and vice versa.
        const createdAlone = matchesArtifactSelectorCreated(ts, { createdAfter: bound });
        const createdWithModified = matchesArtifactSelectorCreated(ts, {
          createdAfter: bound,
          modifiedAfter: mtime,
          modifiedBefore: mtime,
        });
        expect(createdWithModified).toBe(createdAlone);

        const modifiedAlone = matchesArtifactSelectorModified(mtime, { modifiedAfter: bound });
        const modifiedWithCreated = matchesArtifactSelectorModified(mtime, {
          modifiedAfter: bound,
          createdAfter: tsMs,
          createdBefore: tsMs,
        });
        expect(modifiedWithCreated).toBe(modifiedAlone);
      }),
    );
  });
});

describe('latestArtifactRecordsByManifestGroup properties', () => {
  type LatestRecord = {
    readonly runbook: { readonly source: string; readonly path: string };
    readonly key: string;
    readonly timestamp: string;
    readonly uri: string;
  };

  // Records drawn from a small pool of group dimensions to force group collisions,
  // with a globally-unique uri so the (timestamp, uri) winner is unambiguous.
  const recordsArb: fc.Arbitrary<LatestRecord[]> = fc
    .array(
      fc.record({
        source: fc.constantFrom(...SOURCES),
        path: fc.constantFrom(...RUNBOOK_PATHS),
        key: fc.constantFrom(...KEYS),
        timestampMs: fc.integer({ min: EPOCH_MS_MIN, max: EPOCH_MS_MAX }),
      }),
      { maxLength: 40 },
    )
    .map((rows) =>
      rows.map((row, index) => ({
        runbook: { source: row.source, path: row.path },
        key: row.key,
        timestamp: isoFromMs(row.timestampMs),
        // Unique, zero-padded so lexical uri order is deterministic across the set.
        uri: `rd://artifacts/${String(index).padStart(4, '0')}`,
      })),
    );

  const groupOf = (r: LatestRecord): string => `${r.runbook.source}\0${r.runbook.path}\0${r.key}`;

  // Independent winner oracle: sort each group ascending by (timestamp, uri) and
  // take the last element — a different computation than the reduce under test.
  function winnersByGroup(records: readonly LatestRecord[]): Map<string, LatestRecord> {
    const groups = new Map<string, LatestRecord[]>();
    for (const r of records) {
      const g = groupOf(r);
      const bucket = groups.get(g);
      if (bucket === undefined) {
        groups.set(g, [r]);
      } else {
        bucket.push(r);
      }
    }
    const winners = new Map<string, LatestRecord>();
    for (const [g, rows] of groups) {
      const sorted = [...rows].sort((l, r) =>
        l.timestamp !== r.timestamp
          ? l.timestamp.localeCompare(r.timestamp)
          : l.uri.localeCompare(r.uri),
      );
      winners.set(g, sorted[sorted.length - 1]);
    }
    return winners;
  }

  it('returns exactly one record per (source, path, key) group', () => {
    fc.assert(
      fc.property(recordsArb, (records) => {
        const out = latestArtifactRecordsByManifestGroup(records);
        const groups = out.map(groupOf);
        expect(new Set(groups).size).toBe(groups.length);
        expect(new Set(groups)).toEqual(new Set(records.map(groupOf)));
      }),
    );
  });

  it('output is a subset of the input by reference identity', () => {
    fc.assert(
      fc.property(recordsArb, (records) => {
        const out = latestArtifactRecordsByManifestGroup(records);
        for (const r of out) {
          expect(records.some((input) => input === r)).toBe(true);
        }
      }),
    );
  });

  it('each group winner is the max under (timestamp, then uri)', () => {
    fc.assert(
      fc.property(recordsArb, (records) => {
        const out = latestArtifactRecordsByManifestGroup(records);
        const oracle = winnersByGroup(records);
        for (const r of out) {
          expect(r).toBe(oracle.get(groupOf(r)));
        }
      }),
    );
  });

  it('is idempotent: latest(latest(rs)) deep-equals latest(rs)', () => {
    fc.assert(
      fc.property(recordsArb, (records) => {
        const once = latestArtifactRecordsByManifestGroup(records);
        const twice = latestArtifactRecordsByManifestGroup(once);
        expect(twice).toEqual(once);
      }),
    );
  });

  it('is permutation-invariant on the per-group winner', () => {
    fc.assert(
      fc.property(recordsArb, fc.array(fc.integer()), (records, noise) => {
        // Derive a deterministic permutation from the noise array.
        const shuffled = records
          .map((r, i) => ({ r, sort: noise[i] ?? i }))
          .sort((a, b) => a.sort - b.sort)
          .map((x) => x.r);
        const a = latestArtifactRecordsByManifestGroup(records);
        const b = latestArtifactRecordsByManifestGroup(shuffled);
        const byGroup = (out: LatestRecord[]) =>
          new Map(out.map((r) => [groupOf(r), r.uri] as const));
        expect(byGroup(b)).toEqual(byGroup(a));
      }),
    );
  });
});
