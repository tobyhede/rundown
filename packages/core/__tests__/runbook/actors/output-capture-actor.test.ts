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

  it('returns captured values from prepared channels', async () => {
    const channels = [
      await makeChannel(tmp, 'Foo', 'foo-value\n'),
      await makeChannel(tmp, 'Bar', 'bar-value'),
    ];
    const actor = createActor(outputCaptureActor, { input: { channels } });
    actor.start();
    const output = await new Promise<Record<string, string>>((resolve) => {
      actor.subscribe((s) => {
        if (s.status === 'done') resolve(s.output as Record<string, string>);
      });
    });
    expect(output).toEqual({ Foo: 'foo-value', Bar: 'bar-value' });
  });

  it('omits missing channel files but does not reject', async () => {
    const channels = [
      { name: 'Missing', path: path.join(tmp, 'does-not-exist') },
      await makeChannel(tmp, 'Present', 'ok'),
    ];
    const actor = createActor(outputCaptureActor, { input: { channels } });
    actor.start();
    const output = await new Promise<Record<string, string>>((resolve) => {
      actor.subscribe((s) => {
        if (s.status === 'done') resolve(s.output as Record<string, string>);
      });
    });
    expect(output).toEqual({ Present: 'ok' });
  });

  it('returns empty record when channels array is empty', async () => {
    const actor = createActor(outputCaptureActor, { input: { channels: [] } });
    actor.start();
    const output = await new Promise<Record<string, string>>((resolve) => {
      actor.subscribe((s) => {
        if (s.status === 'done') resolve(s.output as Record<string, string>);
      });
    });
    expect(output).toEqual({});
  });
});
