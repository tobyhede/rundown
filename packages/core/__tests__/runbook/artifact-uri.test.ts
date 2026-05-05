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

const RUN_ID = 'wf_0123456789abcdef0123456789abcdef';
const EXACT_URI = `rd://artifacts/ctx1/runs/${RUN_ID}/review.json`;

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
    expect(parseExactArtifactUriParts(`${EXACT_URI}?status=any`)).toBeNull();
    expect(parseExactArtifactUriParts('rd://artifacts/ctx1/runs/*/review.json')).toBeNull();
    expect(
      parseExactArtifactUriParts(`rd://artifacts/ctx%2F1/runs/${RUN_ID}/review.json`),
    ).toBeNull();
  });

  it('parses selector artifact URIs with query arrays', () => {
    expect(
      parseArtifactUri(
        'rd://artifacts/ctx1/runs/*/review.json?runbook=planning/review/review-plan-*.runbook.md',
      ),
    ).toEqual({
      kind: 'selector',
      contextId: 'ctx1',
      runId: '*',
      key: 'review.json',
      query: { runbook: ['planning/review/review-plan-*.runbook.md'] },
    });
  });

  it('classifies a concrete run id with a query string as a selector', () => {
    expect(parseArtifactUri(`${EXACT_URI}?status=any`)).toMatchObject({
      kind: 'selector',
      runId: RUN_ID,
      query: { status: ['any'] },
    });
  });

  it('rejects unsupported selector query parameter names', () => {
    expect(() => parseArtifactUri(`${EXACT_URI}?stats=any`)).toThrow(
      'Unsupported artifact URI query parameter: stats',
    );
    expect(() => parseArtifactUri('rd://artifacts/ctx1/runs/*/review.json?unknown=plan')).toThrow(
      'Unsupported artifact URI query parameter: unknown',
    );
  });

  it('rejects invalid path shapes', () => {
    expect(() => parseArtifactUri(`rd://artifacts/ctx1/runs/${RUN_ID}/nested/review.json`)).toThrow(
      ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE,
    );
    expect(() => parseArtifactUri(`${EXACT_URI}/`)).toThrow(
      ARTIFACT_ERROR_TEXT.INVALID_URI_PATH_SHAPE,
    );
  });

  it('rejects fragments', () => {
    expect(() => parseArtifactUri(`${EXACT_URI}#part`)).toThrow(
      ARTIFACT_ERROR_TEXT.INVALID_URI_FRAGMENT,
    );
  });

  it.each([
    'wf_short',
    'wf_0123456789abcdef0123456789ABCDEF',
    'plain_id',
  ])('rejects invalid concrete run id %s', (runId) => {
    expect(() => parseArtifactUri(`rd://artifacts/ctx1/runs/${runId}/review.json`)).toThrow(
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
      path.join(
        '/repo',
        '.rundown/work/.rd-ctx1/runs/wf_0123456789abcdef0123456789abcdef/review.json',
      ),
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
    expect(() => parseArtifactUri('rd://artifacts/*/runs/*/review.json')).toThrow(
      ARTIFACT_ERROR_TEXT.CROSS_CONTEXT_WILDCARD,
    );
    expect(() => parseArtifactUri('rd://artifacts/{{ContextId}}/runs/*/review.json')).toThrow(
      ARTIFACT_ERROR_TEXT.UNRESOLVED_TEMPLATE_MARKER,
    );
    expect(() => parseArtifactUri('rd://artifacts/ctx1/runs/{{RunId}}/review.json')).toThrow(
      ARTIFACT_ERROR_TEXT.UNRESOLVED_TEMPLATE_MARKER,
    );
    expect(() => parseArtifactUri('rd://artifacts/ContextId/runs/*/review.json')).toThrow(
      ARTIFACT_ERROR_TEXT.BARE_BUILTIN_PLACEHOLDER,
    );
    expect(() => parseArtifactUri('rd://artifacts/ctx1/runs/RunId/review.json')).toThrow(
      ARTIFACT_ERROR_TEXT.BARE_BUILTIN_PLACEHOLDER,
    );
    expect(() => parseArtifactUri('rd://artifacts/ctx1/runs/**/review.json')).toThrow(
      ARTIFACT_ERROR_TEXT.RECURSIVE_WILDCARD,
    );
  });
});
