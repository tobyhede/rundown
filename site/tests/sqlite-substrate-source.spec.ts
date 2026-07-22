import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test('WebContainer command capture awaits output EOF after process exit', async () => {
  const source = await readFile(
    new URL('../src/pages/dev/sqlite-substrate-probe.astro', import.meta.url),
    'utf8',
  );

  const drainDeclaration = source.indexOf('const drain = (async () =>');
  const exitAwait = source.indexOf('const code = await proc.exit');
  const drainAwait = source.indexOf('await drain', exitAwait);
  const resultReturn = source.indexOf('return { out, code }', exitAwait);

  expect(drainDeclaration).toBeGreaterThan(-1);
  expect(exitAwait).toBeGreaterThan(drainDeclaration);
  expect(drainAwait).toBeGreaterThan(exitAwait);
  expect(resultReturn).toBeGreaterThan(drainAwait);
});
