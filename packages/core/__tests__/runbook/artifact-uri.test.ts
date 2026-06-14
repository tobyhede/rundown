import { describe, expect, it } from '@jest/globals';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ARTIFACT_ERROR_TEXT } from '../../src/runbook/artifact-errors.js';
import {
  artifactUriToPath,
  buildArtifactUri,
  parseArtifactUri,
  parseExactArtifactUriParts,
} from '../../src/runbook/artifact-uri.js';

const RUN_ID = 'rd_0123456789abcdef0123456789abcdef';
const EXACT_URI = `rd://artifacts/ctx1/${RUN_ID}/review.json`;

describe('artifact URI utilities', () => {
  it('builds an exact artifact URI from validated identity parts', () => {
    expect(buildArtifactUri({ contextId: 'ctx1', runId: RUN_ID, key: 'review.json' })).toBe(
      EXACT_URI,
    );
  });

  it('rejects unsafe identity parts while building', () => {
    expect(() =>
      buildArtifactUri({ contextId: '../escape', runId: RUN_ID, key: 'review.json' }),
    ).toThrow(/Invalid contextId/);
    expect(() =>
      buildArtifactUri({ contextId: 'ctx1', runId: RUN_ID, key: 'nested/review.json' }),
    ).toThrow(/Invalid ArtifactKey/);
  });

  it('parses an exact artifact URI', () => {
    expect(parseArtifactUri(EXACT_URI)).toEqual({
      kind: 'exact',
      contextId: 'ctx1',
      runId: RUN_ID,
      key: 'review.json',
      query: {},
    });
  });

  it('extracts exact URI parts only for exact producer URIs', () => {
    expect(parseExactArtifactUriParts(EXACT_URI)).toEqual({
      contextId: 'ctx1',
      runId: RUN_ID,
      key: 'review.json',
    });
    expect(parseExactArtifactUriParts(`${EXACT_URI}?latest=true`)).toBeNull();
    expect(parseExactArtifactUriParts('rd://artifacts/ctx1/*/review.json')).toBeNull();
    expect(parseExactArtifactUriParts(`rd://artifacts/ctx%2F1/${RUN_ID}/review.json`)).toBeNull();
  });

  it('parses selector artifact URIs with query arrays', () => {
    expect(
      parseArtifactUri(
        'rd://artifacts/ctx1/*/review.json?runbook=planning/review/review-plan-*.runbook.md',
      ),
    ).toEqual({
      kind: 'selector',
      contextId: 'ctx1',
      runId: '*',
      key: 'review.json',
      query: { runbook: ['planning/review/review-plan-*.runbook.md'] },
    });
  });

  it('parses selector artifact URI metadata filters', () => {
    expect(
      parseArtifactUri(
        'rd://artifacts/ctx1/*/review.json?runbook=planning/review.runbook.md&source=plugin&source=project&latest=true',
      ),
    ).toEqual({
      kind: 'selector',
      contextId: 'ctx1',
      runId: '*',
      key: 'review.json',
      query: {
        runbook: ['planning/review.runbook.md'],
        source: ['plugin', 'project'],
        latest: true,
      },
    });
  });

  it('parses a selector URI with a wildcard key', () => {
    expect(parseArtifactUri('rd://artifacts/ctx1/*/review-*.json')).toEqual({
      kind: 'selector',
      contextId: 'ctx1',
      runId: '*',
      key: 'review-*.json',
      query: {},
    });
  });

  it('parses a selector URI with a wildcard run and an exact key', () => {
    expect(parseArtifactUri('rd://artifacts/ctx1/*/end-to-end-test-review.json')).toEqual({
      kind: 'selector',
      contextId: 'ctx1',
      runId: '*',
      key: 'end-to-end-test-review.json',
      query: {},
    });
  });

  it('parses a wildcard-key selector with a percent-encoded question mark', () => {
    expect(parseArtifactUri('rd://artifacts/ctx1/*/review-%3F.json')).toEqual({
      kind: 'selector',
      contextId: 'ctx1',
      runId: '*',
      key: 'review-?.json',
      query: {},
    });
  });

  it('parses a concrete-run URI with a wildcard key as a selector', () => {
    expect(parseArtifactUri(`rd://artifacts/ctx1/${RUN_ID}/review-*.json`)).toEqual({
      kind: 'selector',
      contextId: 'ctx1',
      runId: RUN_ID,
      key: 'review-*.json',
      query: {},
    });
  });

  it('rejects a glob key passed to the exact-URI builder', () => {
    expect(() =>
      buildArtifactUri({ contextId: 'ctx1', runId: RUN_ID, key: 'review-*.json' }),
    ).toThrow(ARTIFACT_ERROR_TEXT.GLOB_KEY_IN_EXACT_URI);
  });

  it('keeps rejecting recursive wildcard keys in selector URIs', () => {
    expect(() => parseArtifactUri('rd://artifacts/ctx1/*/review-**.json')).toThrow(
      ARTIFACT_ERROR_TEXT.RECURSIVE_WILDCARD,
    );
  });

  it('keeps rejecting an unsafe selector key (path separator after decode)', () => {
    expect(() => parseArtifactUri('rd://artifacts/ctx1/*/with%2F' + 'space.json')).toThrow(
      /Invalid ArtifactKey|path shape/,
    );
  });

  it('classifies a concrete run id with a query string as a selector', () => {
    expect(parseArtifactUri(`${EXACT_URI}?latest=true`)).toMatchObject({
      kind: 'selector',
      runId: RUN_ID,
      query: { latest: true },
    });
  });

  it('rejects unsupported selector query parameter names', () => {
    expect(() => parseArtifactUri(`${EXACT_URI}?status=any`)).toThrow(
      'Unsupported artifact URI query parameter: status',
    );
    expect(() => parseArtifactUri('rd://artifacts/ctx1/*/review.json?unknown=plan')).toThrow(
      'Unsupported artifact URI query parameter: unknown',
    );
  });

  it('rejects invalid selector query parameter values', () => {
    expect(() => parseArtifactUri('rd://artifacts/ctx1/*/review.json?runbook=')).toThrow(
      'Artifact URI runbook filter must not be empty',
    );
    expect(() => parseArtifactUri('rd://artifacts/ctx1/*/review.json?source=external')).toThrow(
      'Unsupported artifact URI source filter: external',
    );
    expect(() => parseArtifactUri('rd://artifacts/ctx1/*/review.json?latest=false')).toThrow(
      'Artifact URI latest filter must be exactly latest=true',
    );
    expect(() =>
      parseArtifactUri('rd://artifacts/ctx1/*/review.json?latest=true&latest=true'),
    ).toThrow('Artifact URI latest filter may appear at most once');
  });

  it('rejects invalid path shapes', () => {
    expect(() => parseArtifactUri(`rd://artifacts/ctx1/${RUN_ID}/nested/review.json`)).toThrow(
      ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE,
    );
    expect(() => parseArtifactUri(`${EXACT_URI}/`)).toThrow(
      ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE,
    );
  });

  it('rejects the legacy five-segment /runs/ URI shape', () => {
    expect(() => parseArtifactUri(`rd://artifacts/ctx1/runs/${RUN_ID}/review.json`)).toThrow(
      ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE,
    );
    expect(() => parseArtifactUri('rd://artifacts/ctx1/runs/*/review.json')).toThrow(
      ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE,
    );
  });

  it('rejects fragments', () => {
    expect(() => parseArtifactUri(`${EXACT_URI}#part`)).toThrow(
      ARTIFACT_ERROR_TEXT.INVALID_URI_FRAGMENT,
    );
  });

  it.each([
    'rd_short',
    'rd_0123456789abcdef0123456789ABCDEF',
    'wf_0123456789abcdef0123456789abcdef',
    'plain_id',
  ])('rejects invalid concrete run id %s', (runId) => {
    expect(() => parseArtifactUri(`rd://artifacts/ctx1/${runId}/review.json`)).toThrow(
      ARTIFACT_ERROR_TEXT.INVALID_RUN_ID,
    );
  });

  it.each([
    '',
    '.',
    '..',
    'nested/review.json',
    encodeURIComponent('nested/review.json'),
    'with spaces.json',
  ])('rejects invalid artifact key %s', (key) => {
    expect(() => buildArtifactUri({ contextId: 'ctx1', runId: RUN_ID, key })).toThrow(
      /Invalid ArtifactKey/,
    );
  });

  it('maps exact artifact URIs into the configured work path', () => {
    expect(artifactUriToPath(EXACT_URI, { cwd: '/repo', workPath: '.rundown/work' })).toBe(
      path.join('/repo', '.rundown/work/.rd-ctx1/rd_0123456789abcdef0123456789abcdef/review.json'),
    );
  });

  it.each([
    '../outside',
    path.resolve('/outside'),
  ])('rejects work paths that escape cwd: %s', (workPath) => {
    expect(() => artifactUriToPath(EXACT_URI, { cwd: '/repo', workPath })).toThrow(
      ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE,
    );
  });

  it('rejects symlinked work path segments', async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'artifact-uri-'));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'artifact-uri-outside-'));
    try {
      await fsp.mkdir(path.join(cwd, '.rundown'), { recursive: true });
      try {
        await fsp.symlink(outside, path.join(cwd, '.rundown/work'), 'dir');
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'EPERM'
        ) {
          return;
        }
        throw error;
      }

      expect(() => artifactUriToPath(EXACT_URI, { cwd, workPath: '.rundown/work' })).toThrow(
        ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE,
      );
    } finally {
      await Promise.all([
        fsp.rm(cwd, { force: true, recursive: true }),
        fsp.rm(outside, { force: true, recursive: true }),
      ]);
    }
  });

  it('rejects unsupported selector shapes and template placeholders', () => {
    expect(() => parseArtifactUri('rd://artifacts/*/*/review.json')).toThrow(
      ARTIFACT_ERROR_TEXT.CROSS_CONTEXT_WILDCARD,
    );
    expect(() => parseArtifactUri('rd://artifacts/{{ContextId}}/*/review.json')).toThrow(
      ARTIFACT_ERROR_TEXT.UNRESOLVED_TEMPLATE_MARKER,
    );
    expect(() => parseArtifactUri('rd://artifacts/ctx1/{{RunId}}/review.json')).toThrow(
      ARTIFACT_ERROR_TEXT.UNRESOLVED_TEMPLATE_MARKER,
    );
    expect(() => parseArtifactUri('rd://artifacts/ContextId/*/review.json')).toThrow(
      ARTIFACT_ERROR_TEXT.BARE_BUILTIN_PLACEHOLDER,
    );
    expect(() => parseArtifactUri('rd://artifacts/ctx1/RunId/review.json')).toThrow(
      ARTIFACT_ERROR_TEXT.BARE_BUILTIN_PLACEHOLDER,
    );
    expect(() => parseArtifactUri('rd://artifacts/ctx1/**/review.json')).toThrow(
      ARTIFACT_ERROR_TEXT.RECURSIVE_WILDCARD,
    );
  });
});
