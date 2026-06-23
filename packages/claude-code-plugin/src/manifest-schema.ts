/**
 * Zod schema and validation for the Claude Code plugin manifest.
 *
 * Pins the structure of `.claude-plugin/plugin.json` so a malformed or
 * incomplete manifest is caught by the unit suite (the cheap, always-runs
 * layer) ahead of the official `claude plugin validate --strict` gate that
 * runs in the Docker verify path.
 *
 * The schema is intentionally **not** `.strict()`: the official Claude Code
 * manifest format permits many optional fields (keywords, license, homepage,
 * commands, agents, skills, hooks, mcpServers, …). Validating only the fields
 * this plugin actually ships keeps the check stable when optional fields are
 * added, while still asserting the required core is well-formed.
 *
 * @module manifest-schema
 */

import { z } from 'zod';

/** Plugin name: lowercase kebab-case (matches the Claude Code loader constraint). */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Semver-shaped version: major.minor.patch (optional pre-release/build suffix). */
const VERSION_PATTERN = /^\d+\.\d+\.\d+/;

/** Pragmatic email check — non-empty local/domain parts around a single `@`. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** HTTP(S) repository URL. */
const REPOSITORY_PATTERN = /^https?:\/\/\S+$/;

/**
 * Manifest author block. The plugin ships the object form
 * (`{ name, email }`); the string form permitted by the official spec is not
 * used here and therefore not modelled.
 */
const AuthorSchema = z.object({
  name: z.string().min(1),
  email: z.string().regex(EMAIL_PATTERN, 'author.email must be a valid email address'),
});

/**
 * Schema for the plugin manifest (`.claude-plugin/plugin.json`).
 *
 * Asserts the required core fields shipped by this plugin. Unknown keys are
 * permitted (and stripped) so the check survives addition of official optional
 * manifest fields.
 */
export const PluginManifestSchema = z.object({
  name: z.string().min(1).regex(NAME_PATTERN, 'name must be lowercase kebab-case'),
  version: z.string().regex(VERSION_PATTERN, 'version must be semver-shaped (major.minor.patch)'),
  description: z.string().min(1),
  author: AuthorSchema,
  repository: z.string().regex(REPOSITORY_PATTERN, 'repository must be an http(s) URL'),
});

/** Validated plugin manifest type inferred from {@link PluginManifestSchema}. */
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** Validated manifest author type inferred from the author schema. */
export type PluginManifestAuthor = z.infer<typeof AuthorSchema>;
