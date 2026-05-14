import { describe, it, expect } from '@jest/globals';
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
import { brandEffectiveVarsForTest } from '../../helpers/effective-vars.js';

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

describe('forIterateActor termination property', () => {
  it('emits kind=exhausted within MAX_FILE_ITERATIONS for an unbounded JSONL stream', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-cap-prop-'));
    try {
      const cwd = canonicalProjectRootSyncForTest(tmp);
      const filePath = path.join(tmp, 'data.jsonl');
      const lines = Array.from({ length: MAX_FILE_ITERATIONS + 100 }, (_, i) =>
        JSON.stringify({ n: i }),
      );
      fs.writeFileSync(filePath, `${lines.join('\n')}\n`);

      const baseCtx: ForContext = {
        stepId: '1',
        iteration: 1,
        start: 1,
        end: undefined,
        variable: 'item',
        implicit: false,
        source: { kind: 'variable', name: 'items' },
      };
      const templateVars = brandEffectiveVarsForTest({
        items: createJsonArrayStream(filePath),
      });

      let iteration = MAX_FILE_ITERATIONS;
      let exhausted = false;
      while (iteration <= MAX_FILE_ITERATIONS + 1) {
        const output = await runActor({
          forContext: { ...baseCtx, iteration },
          templateVars,
          cwd,
        });
        if (output.kind === 'exhausted') {
          exhausted = true;
          break;
        }
        iteration += 1;
      }

      expect(exhausted).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
