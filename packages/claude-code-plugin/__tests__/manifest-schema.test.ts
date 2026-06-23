import { describe, it, expect, beforeAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginManifestSchema } from '../src/manifest-schema.js';
import type { PluginManifest, PluginManifestAuthor } from '../src/manifest-schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Minimal valid manifest for testing. Override fields as needed. */
function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'rundown',
    version: '1.0.0',
    description: 'Claude Code plugin for runbook orchestration and workflow execution',
    author: { name: 'Toby Hede', email: 'toby@rundown.org' },
    repository: 'https://github.com/rundown-org/rundown',
    ...overrides,
  };
}

describe('PluginManifestSchema', () => {
  describe('shipped manifest', () => {
    let manifest: unknown;

    beforeAll(async () => {
      const manifestPath = path.resolve(__dirname, '..', '.claude-plugin', 'plugin.json');
      const raw = await fs.readFile(manifestPath, 'utf-8');
      manifest = JSON.parse(raw);
    });

    it('the real .claude-plugin/plugin.json conforms to the schema', () => {
      const result = PluginManifestSchema.safeParse(manifest);
      expect(result.success).toBe(true);
    });
  });

  describe('valid manifests', () => {
    it('accepts a valid minimal manifest', () => {
      expect(PluginManifestSchema.safeParse(validManifest()).success).toBe(true);
    });

    it('accepts a multi-segment kebab-case name', () => {
      expect(
        PluginManifestSchema.safeParse(validManifest({ name: 'rundown-plugin' })).success,
      ).toBe(true);
    });

    it('accepts a version with a pre-release suffix', () => {
      expect(
        PluginManifestSchema.safeParse(validManifest({ version: '1.2.3-beta.1' })).success,
      ).toBe(true);
    });

    it('ignores unknown optional manifest fields', () => {
      const result = PluginManifestSchema.safeParse(
        validManifest({ keywords: ['runbook'], license: 'MIT' }),
      );
      expect(result.success).toBe(true);
    });
  });

  describe('invalid manifests', () => {
    it('rejects a non-kebab-case name', () => {
      expect(PluginManifestSchema.safeParse(validManifest({ name: 'Rundown' })).success).toBe(
        false,
      );
    });

    it('rejects an empty name', () => {
      expect(PluginManifestSchema.safeParse(validManifest({ name: '' })).success).toBe(false);
    });

    it('rejects a missing version', () => {
      const { version: _omit, ...rest } = validManifest();
      expect(PluginManifestSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects a non-semver version', () => {
      expect(PluginManifestSchema.safeParse(validManifest({ version: 'v1' })).success).toBe(false);
    });

    it('rejects an empty description', () => {
      expect(PluginManifestSchema.safeParse(validManifest({ description: '' })).success).toBe(
        false,
      );
    });

    it('rejects a missing author', () => {
      const { author: _omit, ...rest } = validManifest();
      expect(PluginManifestSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects an author missing email', () => {
      expect(
        PluginManifestSchema.safeParse(validManifest({ author: { name: 'Toby Hede' } })).success,
      ).toBe(false);
    });

    it('rejects a malformed author email', () => {
      expect(
        PluginManifestSchema.safeParse(
          validManifest({ author: { name: 'Toby Hede', email: 'not-an-email' } }),
        ).success,
      ).toBe(false);
    });

    it('rejects a missing repository', () => {
      const { repository: _omit, ...rest } = validManifest();
      expect(PluginManifestSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects a non-URL repository', () => {
      expect(
        PluginManifestSchema.safeParse(validManifest({ repository: 'rundown-org/rundown' }))
          .success,
      ).toBe(false);
    });
  });

  describe('type-level API', () => {
    it('PluginManifest has the expected fields', () => {
      const manifest = {} as PluginManifest;
      const _name: string = manifest.name;
      const _version: string = manifest.version;
      const _description: string = manifest.description;
      const _author: PluginManifestAuthor = manifest.author;
      const _repository: string = manifest.repository;
      expect(true).toBe(true);
    });

    it('PluginManifestAuthor has name and email', () => {
      const author = {} as PluginManifestAuthor;
      const _name: string = author.name;
      const _email: string = author.email;
      expect(true).toBe(true);
    });
  });
});
