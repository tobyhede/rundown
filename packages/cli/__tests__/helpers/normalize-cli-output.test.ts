import { describe, it, expect } from '@jest/globals';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { normalizeCliOutput } from './test-utils.js';
import type { TestWorkspace } from './test-utils.js';

function makeWorkspace(cwd: string): TestWorkspace {
  // Minimal stub — normaliser only reads `cwd`.
  return {
    cwd,
    cleanup: async () => undefined,
    runbookPath: () => '',
    statePath: () => '',
    sessionPath: () => '',
    runbooksDir: () => '',
    pluginRunbooksDir: () => '',
    rootRunbooksDir: () => '',
    locksDir: () => '',
    binPath: () => '',
  };
}

describe('normalizeCliOutput', () => {
  const workspace = makeWorkspace('/var/folders/abc/T/rd-test-xyz');

  it('replaces cwd occurrences with <workdir>', () => {
    const input = 'wrote file at /var/folders/abc/T/rd-test-xyz/runbooks/x.md';
    expect(normalizeCliOutput(input, workspace)).toBe('wrote file at <workdir>/runbooks/x.md');
  });

  it('replaces the /private prefix realpath form of cwd with <workdir>', () => {
    const input = 'at /private/var/folders/abc/T/rd-test-xyz/runs/state.json';
    expect(normalizeCliOutput(input, workspace)).toBe('at <workdir>/runs/state.json');
  });

  it('replaces delegation tokens with <token>', () => {
    // cspell:disable-next-line
    const input = '"token": "rdtk_UTDQH4LPV3I364XFXLBSGKNPLNQGRAZO"';
    expect(normalizeCliOutput(input, workspace)).toBe('"token": "<token>"');
  });

  it('replaces sha256 hex digests with <tokenHash>', () => {
    const input =
      '"token_hash": "sha256:99f78f8946aa2736d1894b2f5800989c37343f04cf645e0110735913e7607306"';
    expect(normalizeCliOutput(input, workspace)).toBe('"token_hash": "<tokenHash>"');
  });

  it('does not match sha256 with wrong length', () => {
    // 63 chars — should NOT match
    const input = 'sha256:99f78f8946aa2736d1894b2f5800989c37343f04cf645e0110735913e760730';
    expect(normalizeCliOutput(input, workspace)).toBe(input);
  });

  it('replaces full UUIDs with <uuid>', () => {
    const input = '"runId": "550e8400-e29b-41d4-a716-446655440000"';
    expect(normalizeCliOutput(input, workspace)).toBe('"runId": "<uuid>"');
  });

  it('masks an 8-char hex RunId template-variable value as <hex8>', () => {
    // {{RunId}} is a built-in template variable — `randomBytes(4).toString('hex')`.
    const input = 'RunId value is abcd1234 done';
    expect(normalizeCliOutput(input, workspace)).toBe('RunId value is <hex8> done');
  });

  it('masks an 8-char hex ContextId template-variable value as <hex8>', () => {
    // {{ContextId}} shares the same randomBytes(4)→hex shape as {{RunId}};
    // one rule covers both.
    const input = 'ContextId value is deadbeef';
    expect(normalizeCliOutput(input, workspace)).toBe('ContextId value is <hex8>');
  });

  it('also masks arbitrary 8-char hex tokens at word boundaries (documented false-positive)', () => {
    // The 8-hex rule is deliberately aggressive: a git short SHA, step-frame
    // hash, or hex-like user token will also be normalised. When reviewing
    // snapshot diffs, verify each <hex8> substitution is legitimate — anything
    // unexpected masked by this rule is a signal, not noise.
    const input = 'commit abcdef01 fixed the thing';
    expect(normalizeCliOutput(input, workspace)).toBe('commit <hex8> fixed the thing');
  });

  it('replaces ISO 8601 timestamps with <timestamp>', () => {
    const input = '"startedAt": "2026-04-22T12:34:56.789Z"';
    expect(normalizeCliOutput(input, workspace)).toBe('"startedAt": "<timestamp>"');
  });

  it('replaces ISO 8601 timestamps with timezone offset', () => {
    const input = '"t": "2026-04-22T12:34:56+10:00"';
    expect(normalizeCliOutput(input, workspace)).toBe('"t": "<timestamp>"');
  });

  it('replaces numeric startedAt epoch ms field values with placeholder', () => {
    const input = '"startedAt": 1745000000000,';
    expect(normalizeCliOutput(input, workspace)).toBe('"startedAt": <epochMs>,');
  });

  it('replaces completedAt epoch ms field values with placeholder', () => {
    const input = '"completedAt": 1745000001234,';
    expect(normalizeCliOutput(input, workspace)).toBe('"completedAt": <epochMs>,');
  });

  it('replaces expiresAt epoch ms field values with placeholder', () => {
    const input = '"expiresAt": 1745000002000';
    expect(normalizeCliOutput(input, workspace)).toBe('"expiresAt": <epochMs>');
  });

  it('replaces durationMs and took numeric fields with <ms>', () => {
    const input = '"durationMs": 1234, "took": 56';
    expect(normalizeCliOutput(input, workspace)).toBe('"durationMs": <ms>, "took": <ms>');
  });

  it('replaces tmpdir (outside workspace) with <tmpdir>', async () => {
    const realTmp = await realpath(tmpdir());
    const input = `loaded from ${realTmp}/other-file`;
    expect(normalizeCliOutput(input, workspace)).toBe('loaded from <tmpdir>/other-file');
  });

  it('replaces wf-YYYY-MM-DD-xxxxxx runbookId values with <runbookId>', () => {
    // cspell:disable-next-line
    const input = '"runbookId":"wf-2026-04-22-8gcrrf"';
    expect(normalizeCliOutput(input, workspace)).toBe('"runbookId":"<runbookId>"');
  });

  it('replaces runbookId values embedded in state paths', () => {
    const input = '"statePath":".rundown/runs/wf-2026-04-22-zxn59z.json"';
    expect(normalizeCliOutput(input, workspace)).toBe(
      '"statePath":".rundown/runs/<runbookId>.json"',
    );
  });

  it('replaces runbookId with shorter base-36 suffix', () => {
    const input = '"runbookId":"wf-2026-04-22-a1"';
    expect(normalizeCliOutput(input, workspace)).toBe('"runbookId":"<runbookId>"');
  });

  describe('runbook ID normalization is bounded to 1-6 base-36 chars', () => {
    it('normalizes a 3-char base-36 suffix', () => {
      const input = '"runbookId":"wf-2026-04-23-abc"';
      expect(normalizeCliOutput(input, workspace)).toBe('"runbookId":"<runbookId>"');
    });

    it('normalizes a 6-char suffix (upper boundary)', () => {
      const input = '"runbookId":"wf-2026-04-23-abcdef"';
      expect(normalizeCliOutput(input, workspace)).toBe('"runbookId":"<runbookId>"');
    });

    it('does NOT normalize a 7-char suffix (malformed runbook ID)', () => {
      // Suffixes longer than 6 base-36 chars do not match the production
      // ID generator; leave them alone so genuine garbage stays visible
      // in snapshot diffs rather than getting masked.
      const input = '"runbookId":"wf-2026-04-23-abcdefg"';
      expect(normalizeCliOutput(input, workspace)).toBe(input);
    });
  });

  it('is idempotent — running twice produces the same output', () => {
    const input =
      '{"t":"2026-04-22T12:34:56Z","startedAt":1745000000000,"durationMs":123,"path":"/var/folders/abc/T/rd-test-xyz/x"}';
    const once = normalizeCliOutput(input, workspace);
    const twice = normalizeCliOutput(once, workspace);
    expect(twice).toBe(once);
  });
});
