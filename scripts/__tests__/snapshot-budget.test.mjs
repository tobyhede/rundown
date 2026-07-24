import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLOUDFLARE_PAGES_FILE_LIMIT_BYTES,
  SNAPSHOT_BUDGET_BYTES,
  assertSnapshotWithinBudget,
} from '../../site/scripts/snapshot-budget.mjs';

// The snapshot is ONE static asset and Cloudflare Pages rejects any single file
// over 25 MiB. Before this budget existed the ceiling was enforced by Cloudflare
// after merge, in a log behind their dashboard, while every GitHub check passed.
// See issue #639.

test('the budget leaves headroom below the hard Cloudflare limit', () => {
  // A budget at the wall is not a guardrail: it fails the build at the same
  // moment the deploy would, with none of the room a fix needs.
  assert.ok(
    SNAPSHOT_BUDGET_BYTES < CLOUDFLARE_PAGES_FILE_LIMIT_BYTES,
    'budget must trip before Cloudflare does',
  );
  assert.ok(
    CLOUDFLARE_PAGES_FILE_LIMIT_BYTES - SNAPSHOT_BUDGET_BYTES >= 4 * 1024 * 1024,
    'at least 4 MiB between the build failing and the deploy failing',
  );
});

test('the budget stays tight enough to make growth a diff-time conversation', () => {
  // The point of the guardrail (issue #639) is that a sql.js-sized addition
  // trips it in the PR that adds it, not ten quiet megabytes later. A budget
  // far above the asset it guards defeats that, so it is bounded from above too
  // — retune it deliberately alongside the asset, not by drifting upward.
  assert.ok(
    SNAPSHOT_BUDGET_BYTES <= 13 * 1024 * 1024,
    'budget must stay close to the asset it guards',
  );
});

test('the hard limit is Cloudflare Pages’ documented 25 MiB', () => {
  assert.equal(CLOUDFLARE_PAGES_FILE_LIMIT_BYTES, 25 * 1024 * 1024);
});

test('accepts a snapshot within budget', () => {
  assert.doesNotThrow(() => assertSnapshotWithinBudget(SNAPSHOT_BUDGET_BYTES));
});

test('rejects a snapshot one byte over budget', () => {
  assert.throws(() => assertSnapshotWithinBudget(SNAPSHOT_BUDGET_BYTES + 1));
});

test('names the measured size, the budget and the hard limit when it refuses', () => {
  // The whole point is a readable GitHub check: whoever hits this needs to see
  // how far over they are and what the real wall is, without leaving the log.
  assert.throws(
    () => assertSnapshotWithinBudget(24 * 1024 * 1024),
    (error) => {
      assert.match(error.message, /24\.00 MiB/, 'measured size');
      assert.match(error.message, /12\.00 MiB/, 'budget');
      assert.match(error.message, /25\.00 MiB/, 'hard limit');
      return true;
    },
  );
});

test('renders the refusal as one flat line, byte for byte', () => {
  // Pins the exact CLI output so a rewrite of the message construction (e.g.
  // concatenation → a single template literal) cannot silently insert a newline
  // or drop a space. The segments are one continuous sentence, not a list.
  const error = /** @type {Error} */ (
    (() => {
      try {
        assertSnapshotWithinBudget(24 * 1024 * 1024);
        return new Error('did not throw');
      } catch (thrown) {
        return thrown;
      }
    })()
  );

  assert.equal(
    error.message,
    'WebContainer snapshot is 24.00 MiB, over its 12.00 MiB budget (Cloudflare Pages rejects ' +
      'any single file over 25.00 MiB, so this fails the deploy long before it fails a test). ' +
      'Every runtime dependency of @rundown-org/cli is paid for twice: once as a dependency and ' +
      'again as weight in this asset. Either drop what was added, or split the asset so no single ' +
      'file approaches the limit — see issue #639.',
  );
});
