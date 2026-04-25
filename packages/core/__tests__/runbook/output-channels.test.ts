import { describe, it, expect } from '@jest/globals';
import * as path from 'node:path';
import {
  partitionOutputDeclarations,
  outputsDirForRun,
  outputChannelPath,
  buildOutputChannelEnv,
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
    const scope: OutputScope = { stepId: '1', substepId: '2' };
    expect(outputChannelPath(cwd, runId, scope, 'DeployUrl')).toBe(
      path.join(cwd, '.rundown', 'runs', runId, 'outputs', '1', '2', 'DeployUrl'),
    );
  });

  it('assembles a FOR-iteration-in-step path (iteration, no substep)', () => {
    const scope: OutputScope = { stepId: '3', iteration: 2 };
    expect(outputChannelPath(cwd, runId, scope, 'Tag')).toBe(
      path.join(cwd, '.rundown', 'runs', runId, 'outputs', '3', '2', 'Tag'),
    );
  });

  it('assembles a FOR-iteration-in-substep path with all four segments', () => {
    const scope: OutputScope = { stepId: '3', substepId: '1', iteration: 2 };
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

  it('routes scope substepId + iteration into a four-segment env value', () => {
    const cwd = '/repo';
    const runId = 'wf-2026-04-25-abc123';
    const scope: OutputScope = { stepId: '1', substepId: '2', iteration: 3 };
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
