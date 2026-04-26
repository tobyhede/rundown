import { describe, it, expect } from '@jest/globals';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import {
  partitionOutputDeclarations,
  outputsDirForRun,
  outputChannelPath,
  buildOutputChannelEnv,
  prepareOutputChannels,
  readCapturedOutputs,
  type OutputScope,
} from '../../src/runbook/output-channels.js';

describe('partitionOutputDeclarations', () => {
  it('separates naked and expression entries preserving order', () => {
    const result = partitionOutputDeclarations([
      { name: 'DeployUrl' },
      { name: 'Tag', value: '"{{ RunId }}-staging"' },
      { name: 'Version' },
    ]);
    expect(result.naked).toEqual([{ name: 'DeployUrl' }, { name: 'Version' }]);
    expect(result.expression).toEqual([{ name: 'Tag', value: '"{{ RunId }}-staging"' }]);
  });

  it('returns empty arrays for an empty input', () => {
    const result = partitionOutputDeclarations([]);
    expect(result.naked).toEqual([]);
    expect(result.expression).toEqual([]);
  });

  it('returns all entries as naked when no expressions are present', () => {
    const result = partitionOutputDeclarations([{ name: 'Foo' }, { name: 'Bar' }]);
    expect(result.naked).toEqual([{ name: 'Foo' }, { name: 'Bar' }]);
    expect(result.expression).toEqual([]);
  });

  it('returns all entries as expression when no naked entries are present', () => {
    const result = partitionOutputDeclarations([
      { name: 'Foo', value: '"literal"' },
      { name: 'Bar', value: '"{{ RunId }}"' },
    ]);
    expect(result.naked).toEqual([]);
    expect(result.expression).toEqual([
      { name: 'Foo', value: '"literal"' },
      { name: 'Bar', value: '"{{ RunId }}"' },
    ]);
  });
});

describe('outputsDirForRun', () => {
  it('joins to .rundown/runs/<runId>/outputs', () => {
    const cwd = '/repo';
    expect(outputsDirForRun(cwd, 'wf-2026-04-25-abc123')).toBe(
      path.join('/repo', '.rundown', 'runs', 'wf-2026-04-25-abc123', 'outputs'),
    );
  });

  it('rejects an unsafe runId', () => {
    expect(() => outputsDirForRun('/repo', '..')).toThrow(/Invalid runId/);
    expect(() => outputsDirForRun('/repo', 'a/b')).toThrow(/Invalid runId/);
  });
});

describe('outputChannelPath', () => {
  const cwd = '/repo';
  const runId = 'wf-2026-04-25-abc123';

  it('assembles a step-scoped path (no substep, no iteration)', () => {
    const scope: OutputScope = { stepId: '1' };
    expect(outputChannelPath(cwd, runId, scope, 'Version')).toBe(
      path.join(cwd, '.rundown', 'runs', runId, 'outputs', '1', 'Version'),
    );
  });

  it('assembles a substep-scoped path (substep, no iteration)', () => {
    const scope: OutputScope = { stepId: '1', substep: { id: '2' } };
    expect(outputChannelPath(cwd, runId, scope, 'DeployUrl')).toBe(
      path.join(cwd, '.rundown', 'runs', runId, 'outputs', '1', '2', 'DeployUrl'),
    );
  });

  it('assembles a FOR-iteration-in-substep path with all four segments', () => {
    const scope: OutputScope = { stepId: '3', substep: { id: '1', iteration: 2 } };
    expect(outputChannelPath(cwd, runId, scope, 'Tag')).toBe(
      path.join(cwd, '.rundown', 'runs', runId, 'outputs', '3', '1', '2', 'Tag'),
    );
  });

  it('rejects an invalid VarName', () => {
    const scope: OutputScope = { stepId: '1' };
    expect(() => outputChannelPath(cwd, runId, scope, '../escape')).toThrow(/Invalid output name/);
    expect(() => outputChannelPath(cwd, runId, scope, '1bad')).toThrow(/Invalid output name/);
  });

  it('rejects a reserved name (case-insensitive)', () => {
    const scope: OutputScope = { stepId: '1' };
    expect(() => outputChannelPath(cwd, runId, scope, 'Step')).toThrow(/reserved/);
  });

  it('rejects an unsafe stepId', () => {
    expect(() => outputChannelPath(cwd, runId, { stepId: '..' }, 'Var')).toThrow(/Invalid stepId/);
    expect(() => outputChannelPath(cwd, runId, { stepId: 'a/b' }, 'Var')).toThrow(/Invalid stepId/);
  });

  it('rejects an unsafe substepId', () => {
    expect(() =>
      outputChannelPath(cwd, runId, { stepId: '1', substep: { id: '../escape' } }, 'Var'),
    ).toThrow(/Invalid substepId/);
  });

  it('rejects iteration <= 0 (must be via substep tier — unrepresentable without substep)', () => {
    expect(() =>
      outputChannelPath(cwd, runId, { stepId: '1', substep: { id: '2', iteration: 0 } }, 'Var'),
    ).toThrow(/Invalid iteration/);
    expect(() =>
      outputChannelPath(cwd, runId, { stepId: '1', substep: { id: '2', iteration: -1 } }, 'Var'),
    ).toThrow(/Invalid iteration/);
  });
});

describe('buildOutputChannelEnv', () => {
  it('emits one RD_OUTPUTS_<Name> entry per naked output, all absolute paths', () => {
    const cwd = '/repo';
    const runId = 'wf-2026-04-25-abc123';
    const scope: OutputScope = { stepId: '1' };
    const env = buildOutputChannelEnv(cwd, runId, scope, [
      { name: 'DeployUrl' },
      { name: 'Version' },
    ]);
    expect(Object.keys(env).sort()).toEqual(['RD_OUTPUTS_DeployUrl', 'RD_OUTPUTS_Version']);
    expect(env.RD_OUTPUTS_DeployUrl).toBe(
      path.join(cwd, '.rundown', 'runs', runId, 'outputs', '1', 'DeployUrl'),
    );
    expect(path.isAbsolute(env.RD_OUTPUTS_Version)).toBe(true);
  });

  it('routes scope substep + iteration into a four-segment env value', () => {
    const cwd = '/repo';
    const runId = 'wf-2026-04-25-abc123';
    const scope: OutputScope = { stepId: '1', substep: { id: '2', iteration: 3 } };
    const env = buildOutputChannelEnv(cwd, runId, scope, [{ name: 'DeployUrl' }]);
    expect(env.RD_OUTPUTS_DeployUrl).toBe(
      path.join(cwd, '.rundown', 'runs', runId, 'outputs', '1', '2', '3', 'DeployUrl'),
    );
  });

  it('returns an empty record when no naked outputs are declared', () => {
    const env = buildOutputChannelEnv('/repo', 'wf-x', { stepId: '1' }, []);
    expect(env).toEqual({});
  });
});

describe('prepareOutputChannels', () => {
  it('creates one zero-byte file per naked output and returns absolute env paths', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-outputs-'));
    try {
      const result = await prepareOutputChannels({
        cwd,
        runId: 'wf-test-1',
        scope: { stepId: '1' },
        naked: [{ name: 'DeployUrl' }, { name: 'Version' }],
      });
      expect(Object.keys(result.env).sort()).toEqual([
        'RD_OUTPUTS_DeployUrl',
        'RD_OUTPUTS_Version',
      ]);
      for (const p of result.prepared.map((c) => c.path)) {
        const stat = await fs.stat(p);
        expect(stat.isFile()).toBe(true);
        expect(stat.size).toBe(0);
      }
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('prepared channels carry the correct name for each entry', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-outputs-'));
    try {
      const result = await prepareOutputChannels({
        cwd,
        runId: 'wf-test-1b',
        scope: { stepId: '1' },
        naked: [{ name: 'DeployUrl' }, { name: 'Version' }],
      });
      expect(result.prepared.map((c) => c.name)).toEqual(['DeployUrl', 'Version']);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('truncates an existing channel file to zero bytes', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-outputs-'));
    try {
      const channelPath = path.join(
        cwd,
        '.rundown',
        'runs',
        'wf-test-2',
        'outputs',
        '1',
        'Version',
      );
      await fs.mkdir(path.dirname(channelPath), { recursive: true });
      await fs.writeFile(channelPath, 'stale-value\n');
      await prepareOutputChannels({
        cwd,
        runId: 'wf-test-2',
        scope: { stepId: '1' },
        naked: [{ name: 'Version' }],
      });
      const after = await fs.readFile(channelPath, 'utf-8');
      expect(after).toBe('');
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('skips an entry with an invalid name and continues with the rest', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-outputs-'));
    try {
      const result = await prepareOutputChannels({
        cwd,
        runId: 'wf-test-3',
        scope: { stepId: '1' },
        // 'step' is reserved → should be dropped; 'Version' should still be created
        naked: [{ name: 'step' }, { name: 'Version' }],
      });
      expect(Object.keys(result.env)).toEqual(['RD_OUTPUTS_Version']);
      expect(result.prepared).toHaveLength(1);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('readCapturedOutputs', () => {
  it('reads UTF-8 content and trims trailing whitespace + newlines', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-outputs-'));
    try {
      const prepared = await prepareOutputChannels({
        cwd,
        runId: 'wf-test-4',
        scope: { stepId: '1' },
        naked: [{ name: 'A' }, { name: 'B' }],
      });
      await fs.writeFile(prepared.prepared[0].path, 'value-a\n');
      await fs.writeFile(prepared.prepared[1].path, 'value-b   \n\n');
      const captured = await readCapturedOutputs(prepared.prepared);
      expect(captured).toEqual({ A: 'value-a', B: 'value-b' });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('omits empty files (post-trim) with a warning', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-outputs-'));
    try {
      const prepared = await prepareOutputChannels({
        cwd,
        runId: 'wf-test-5',
        scope: { stepId: '1' },
        naked: [{ name: 'Empty' }, { name: 'Filled' }],
      });
      await fs.writeFile(prepared.prepared[0].path, '   \n');
      await fs.writeFile(prepared.prepared[1].path, 'kept');
      const captured = await readCapturedOutputs(prepared.prepared);
      expect(captured).toEqual({ Filled: 'kept' });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('omits files containing a NUL byte (treated as non-UTF-8)', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-outputs-'));
    try {
      const prepared = await prepareOutputChannels({
        cwd,
        runId: 'wf-test-6',
        scope: { stepId: '1' },
        naked: [{ name: 'Bin' }],
      });
      await fs.writeFile(prepared.prepared[0].path, Buffer.from([0x68, 0x00, 0x69]));
      const captured = await readCapturedOutputs(prepared.prepared);
      expect(captured).toEqual({});
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('omits files that are missing on disk', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-outputs-'));
    try {
      const ghostPath = path.join(cwd, '.rundown', 'runs', 'wf-test-7', 'outputs', '1', 'Ghost');
      const captured = await readCapturedOutputs([{ name: 'Ghost', path: ghostPath }]);
      expect(captured).toEqual({});
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
