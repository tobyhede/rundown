// packages/core/__tests__/paths.test.ts

import { completionLockPath, delegationLockPath, statePath } from '../src/paths.js';

describe('assertSafeId (via path builders)', () => {
  const cwd = '/tmp/project';

  describe('rejects unsafe ids that would enable path traversal', () => {
    const builders: Array<{
      name: string;
      build: (id: string) => string;
    }> = [
      { name: 'completionLockPath', build: (id) => completionLockPath(cwd, id) },
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
});
