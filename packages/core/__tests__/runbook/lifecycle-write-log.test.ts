// packages/core/__tests__/runbook/lifecycle-write-log.test.ts

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lifecycleWriteLogPath } from '../../src/paths.js';
import {
  appendLifecycleWriteRecord,
  captureLifecycleWriteAttribution,
  type LifecycleWriteRecord,
} from '../../src/runbook/lifecycle-write-log.js';

describe('lifecycle-write-log', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'rd-lwl-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function transitionRecord(): LifecycleWriteRecord {
    return {
      kind: 'transition',
      runId: 'rd_00000000000000000000000000000001',
      prev: 'running',
      next: 'stopped',
      attribution: captureLifecycleWriteAttribution(),
    };
  }

  it('appends one JSON line per record, in order', async () => {
    await appendLifecycleWriteRecord(cwd, transitionRecord());
    await appendLifecycleWriteRecord(cwd, {
      kind: 'delete',
      runId: 'rd_00000000000000000000000000000002',
      prev: 'completed',
      attribution: captureLifecycleWriteAttribution(),
    });
    const lines = (await readFile(lifecycleWriteLogPath(cwd), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]) as LifecycleWriteRecord;
    expect(first.kind).toBe('transition');
    expect(first).toMatchObject({ prev: 'running', next: 'stopped' });
    expect(JSON.parse(lines[1])).toMatchObject({ kind: 'delete', prev: 'completed' });
  });

  it('captures pid, ppid, redacted argv, timestamp, and caller frames', () => {
    const attribution = captureLifecycleWriteAttribution();
    expect(attribution.pid).toBe(process.pid);
    expect(attribution.ppid).toBe(process.ppid);
    // argv is captured element-for-element but REDACTED — never pin it equal
    // to raw process.argv (review error: raw tokens/inputs must not persist).
    expect(attribution.argv).toHaveLength(process.argv.length);
    expect(attribution.argv.join(' ')).not.toMatch(/rdtk_[A-Z2-7]{32}/);
    expect(Number.isNaN(Date.parse(attribution.at))).toBe(false);
    expect(attribution.callSite.length).toBeGreaterThan(0);
    expect(attribution.callSite[0]).not.toContain('captureLifecycleWriteAttribution');
  });

  it('redacts delegation tokens and input values from argv before persistence', () => {
    const rawToken = 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const attribution = captureLifecycleWriteAttribution([
      '/usr/bin/node',
      '/usr/local/bin/rundown',
      'claim',
      rawToken,
      '--input',
      'environment=staging',
      '--input-json',
      'items=["a","b"]',
      '--input-file',
      'secrets.yaml',
      'RD_INPUT_API_KEY=hunter2',
    ]);
    expect(attribution.argv).toEqual([
      '/usr/bin/node',
      '/usr/local/bin/rundown',
      'claim',
      'rdtk_ABC...4567', // truncateDelegationToken display form
      '--input',
      'environment=***', // key kept, value masked
      '--input-json',
      'items=***',
      '--input-file',
      '***',
      'RD_INPUT_API_KEY=***',
    ]);
    const serialized = JSON.stringify(attribution);
    expect(serialized).not.toContain(rawToken);
    expect(serialized).not.toContain('staging');
    expect(serialized).not.toContain('hunter2');
  });

  it('never throws when the log cannot be written', async () => {
    await mkdir(join(cwd, '.rundown'), { recursive: true });
    await writeFile(join(cwd, '.rundown', 'logs'), 'not a directory', 'utf8');
    await expect(appendLifecycleWriteRecord(cwd, transitionRecord())).resolves.toBeUndefined();
  });
});
