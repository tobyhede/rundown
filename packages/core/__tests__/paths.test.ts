// packages/core/__tests__/paths.test.ts

import {
  contextOutputsPath,
  contextOutputsLockPath,
  delegationLockPath,
  statePath,
} from '../src/paths.js';

describe('assertSafeId (via path builders)', () => {
  const cwd = '/tmp/project';

  describe('rejects unsafe ids that would enable path traversal', () => {
    const builders: Array<{
      name: string;
      build: (id: string) => string;
    }> = [
      { name: 'contextOutputsPath', build: (id) => contextOutputsPath(cwd, id) },
      { name: 'contextOutputsLockPath', build: (id) => contextOutputsLockPath(cwd, id) },
      { name: 'delegationLockPath', build: (id) => delegationLockPath(cwd, id) },
      { name: 'statePath', build: (id) => statePath(cwd, id) },
    ];

    const badIds = ['..', '.', 'foo/bar', 'foo\\bar', '', '../outside'];

    for (const { name, build } of builders) {
      for (const bad of badIds) {
        it(`${name} throws for ${JSON.stringify(bad)}`, () => {
          expect(() => build(bad)).toThrow(/Invalid/);
        });
      }
    }
  });

  describe('accepts safe ids', () => {
    const goodIds = ['abc', 'ctx-123', 'run_42', 'a.b', 'A1-b2.c3_d4'];
    for (const good of goodIds) {
      it(`contextOutputsPath accepts ${JSON.stringify(good)}`, () => {
        expect(contextOutputsPath('/tmp/project', good)).toContain(good);
      });
    }
  });
});
