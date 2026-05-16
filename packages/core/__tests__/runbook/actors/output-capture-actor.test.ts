import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createActor } from 'xstate';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { outputCaptureActor } from '../../../src/runbook/actors/output-capture-actor.js';

async function makeChannel(dir: string, name: string, content: string) {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, 'utf-8');
  return { name, path: filePath };
}

describe('outputCaptureActor', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'oca-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('returns captured values from prepared channels with result passthrough', async () => {
    const channels = [
      await makeChannel(tmp, 'Foo', 'foo-value\n'),
      await makeChannel(tmp, 'Bar', 'bar-value'),
    ];
    const actor = createActor(outputCaptureActor, { input: { channels, result: 'pass' } });
    actor.start();
    const output = await new Promise((resolve) => {
      actor.subscribe((s) => {
        if (s.status === 'done') resolve(s.output);
      });
    });
    expect(output).toEqual({ variables: { Foo: 'foo-value', Bar: 'bar-value' }, result: 'pass' });
  });

  it('returns typed captured JSON values with result passthrough', async () => {
    const channels = [
      await makeChannel(tmp, 'Items', '["alpha",{"id":2}]'),
      await makeChannel(tmp, 'Config', '{"host":"localhost","port":5432}'),
      await makeChannel(tmp, 'Count', '42'),
    ];
    const actor = createActor(outputCaptureActor, { input: { channels, result: 'pass' } });
    actor.start();
    const output = await new Promise((resolve) => {
      actor.subscribe((s) => {
        if (s.status === 'done') resolve(s.output);
      });
    });
    expect(output).toEqual({
      variables: {
        Items: ['alpha', { id: 2 }],
        Config: { host: 'localhost', port: 5432 },
        Count: 42,
      },
      result: 'pass',
    });
  });

  it('omits missing channel files but does not reject, with result passthrough', async () => {
    const channels = [
      { name: 'Missing', path: path.join(tmp, 'does-not-exist') },
      await makeChannel(tmp, 'Present', 'ok'),
    ];
    const actor = createActor(outputCaptureActor, { input: { channels, result: 'fail' } });
    actor.start();
    const output = await new Promise((resolve) => {
      actor.subscribe((s) => {
        if (s.status === 'done') resolve(s.output);
      });
    });
    expect(output).toEqual({ variables: { Present: 'ok' }, result: 'fail' });
  });

  it('returns empty record when channels array is empty, with result passthrough', async () => {
    const actor = createActor(outputCaptureActor, { input: { channels: [], result: 'pass' } });
    actor.start();
    const output = await new Promise((resolve) => {
      actor.subscribe((s) => {
        if (s.status === 'done') resolve(s.output);
      });
    });
    expect(output).toEqual({ variables: {}, result: 'pass' });
  });
});
