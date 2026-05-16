import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveForValue } from '../../src/runbook/source-resolver.js';
import { createJsonArrayStream, type ForContext, type JsonValue } from '../../src/runbook/types.js';
import { canonicalProjectRootForTest } from '../helpers/canonical-paths.js';
import { brandEffectiveVarsForTest } from '../helpers/effective-vars.js';

const jsonLineValueArb: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.string(),
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
  fc.constant(null),
  fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.string()),
);

describe('resolveForValue JSONL stream properties', () => {
  it('resolves selected JSONL lines with matching lastLine snapshots', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(jsonLineValueArb, { minLength: 1, maxLength: 25 }),
        fc.integer({ min: 1, max: 25 }),
        async (values, requestedIndex) => {
          const iteration = Math.min(requestedIndex, values.length);
          const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-source-prop-'));
          try {
            const file = path.join(tmp, 'items.jsonl');
            await fs.writeFile(
              file,
              `${values.map((value) => JSON.stringify(value)).join('\n')}\n`,
            );
            const projectRoot = await canonicalProjectRootForTest(tmp);
            const fcContext: ForContext = {
              stepId: '1',
              iteration,
              start: iteration,
              end: values.length,
              variable: 'item',
              implicit: false,
              source: { kind: 'variable', name: 'items' },
            };

            const result = await resolveForValue(
              fcContext,
              brandEffectiveVarsForTest({ items: createJsonArrayStream(file) }),
              projectRoot,
            );

            expect(result.kind).toBe('resolved');
            if (result.kind === 'resolved') {
              expect(result.context.currentValue).toEqual(values[iteration - 1]);
              expect(result.context.snapshot?.lastLine).toBe(iteration);
            }
          } finally {
            await fs.rm(tmp, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
