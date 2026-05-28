import { describe, it, expect } from '@jest/globals';
import fc from 'fast-check';
import { createActor } from 'xstate';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  forIterateActor,
  type ForIterateOutput,
} from '../../../src/runbook/actors/for-iterate-actor.js';
import { MAX_FILE_ITERATIONS } from '../../../src/runbook/compiler.js';
import { createJsonArrayStream, type ForContext } from '../../../src/runbook/types.js';
import { canonicalProjectRootSyncForTest } from '../../helpers/canonical-paths.js';
import { brandEffectiveVarsForTest } from '../../../src/testing/effective-vars.js';

async function runActor(input: {
  readonly forContext: ForContext;
  readonly templateVars: ReturnType<typeof brandEffectiveVarsForTest>;
  readonly cwd: string;
}): Promise<ForIterateOutput> {
  const actor = createActor(forIterateActor, { input });
  const result = new Promise<ForIterateOutput>((resolve, reject) => {
    actor.subscribe({
      next: (snap) => {
        if (snap.status === 'done') resolve(snap.output);
        if (snap.status === 'error') {
          reject(snap.error instanceof Error ? snap.error : new Error(String(snap.error)));
        }
      },
    });
  });
  actor.start();
  return await result;
}

describe('forIterateActor high-offset property', () => {
  it('does not apply the relative MAX_FILE_ITERATIONS cap as an absolute source index cap', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: MAX_FILE_ITERATIONS + 1, max: MAX_FILE_ITERATIONS + 20 }),
        async (highOffset) => {
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-cap-prop-'));
          try {
            const cwd = canonicalProjectRootSyncForTest(tmp);
            const filePath = path.join(tmp, 'data.jsonl');
            const lines = Array.from({ length: highOffset }, (_, index) =>
              JSON.stringify({ n: index + 1 }),
            );
            fs.writeFileSync(filePath, `${lines.join('\n')}\n`);

            const baseCtx: ForContext = {
              stepId: '1',
              iteration: highOffset,
              start: highOffset,
              end: highOffset + 2,
              variable: 'item',
              implicit: false,
              source: { kind: 'variable', name: 'items' },
            };
            const templateVars = brandEffectiveVarsForTest({
              items: createJsonArrayStream(filePath),
            });

            const output = await runActor({
              forContext: baseCtx,
              templateVars,
              cwd,
            });

            expect(output).toMatchObject({
              kind: 'ready',
              forIndex: highOffset,
              forValue: { n: highOffset },
              snapshot: {
                lastLine: highOffset,
              },
            });
          } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});
