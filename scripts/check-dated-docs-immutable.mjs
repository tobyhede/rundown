#!/usr/bin/env node
// Guard: dated docs under docs/superpowers/ are write-once.
//
// CLAUDE.md makes `docs/superpowers/` prospective and write-once: a dated
// spec/plan/note (`YYYY-MM-DD-*.md`) is a historical record of what was
// *planned* versus what was later *discovered*. Rewriting an already-committed
// dated file destroys that record (see issue #612 and the #607 revert). This
// guard mechanically flags such rewrites at push/CI time.
//
// Rule: files matching `docs/superpowers/**/YYYY-MM-DD-*.md` may be ADDED or
// DELETED, but never MODIFIED or RENAMED, relative to the merge base. A rename
// rewrites the record just as effectively as an in-place edit, so it counts as
// a modification.
//
// Scope is only the dated files under `docs/superpowers/`. `docs/internal/` is
// descriptive and edited in place by design — it is never caught here.

import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

const DOCS_PREFIX = 'docs/superpowers/';
const DATED_BASENAME = /^\d{4}-\d{2}-\d{2}-/;

/**
 * Run git with the given arguments, returning trimmed stdout.
 *
 * @param {string[]} args - git arguments
 * @param {{ allowFailure?: boolean }} [opts] - when allowFailure, returns null instead of throwing
 * @returns {string | null} trimmed stdout, or null when the command failed and allowFailure is set
 */
function git(args, opts = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch (err) {
    if (opts.allowFailure) return null;
    throw err;
  }
}

/**
 * Parse `--base <ref>` from argv, if present.
 *
 * @param {string[]} argv - process arguments after the script name
 * @returns {string | undefined} the explicit base ref, or undefined
 */
function parseBaseArg(argv) {
  const idx = argv.indexOf('--base');
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  const inline = argv.find((a) => a.startsWith('--base='));
  return inline ? inline.slice('--base='.length) : undefined;
}

/**
 * Resolve the base ref to diff against.
 *
 * Prefers an explicit `--base`, then the PR base branch (`GITHUB_BASE_REF`),
 * then the conventional `origin/main` / `main`. Returns the first candidate
 * that resolves to a real commit, or null when none do (offline clone with no
 * merge base — the guard no-ops in that case, matching the CI-only intent).
 *
 * @param {string | undefined} explicit - value of `--base`, if provided
 * @returns {string | null} a resolvable ref, or null
 */
function resolveBase(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.GITHUB_BASE_REF) candidates.push(`origin/${process.env.GITHUB_BASE_REF}`);
  candidates.push('origin/main', 'main');
  for (const ref of candidates) {
    if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true })) {
      return ref;
    }
  }
  return null;
}

/**
 * Whether a repo-relative path is a dated write-once doc under docs/superpowers.
 *
 * @param {string} path - repo-relative path
 * @returns {boolean} true when the path is a dated `.md` under docs/superpowers/
 */
function isDatedDoc(path) {
  return (
    path.startsWith(DOCS_PREFIX) && path.endsWith('.md') && DATED_BASENAME.test(basename(path))
  );
}

function main() {
  const explicit = parseBaseArg(process.argv.slice(2));
  const base = resolveBase(explicit);
  if (!base) {
    console.log(
      'note: no base ref resolvable (need origin/main or --base); skipping dated-docs immutability check.',
    );
    return 0;
  }

  const mergeBase = git(['merge-base', base, 'HEAD'], { allowFailure: true });
  if (!mergeBase) {
    console.log(
      `note: no merge base between ${base} and HEAD; skipping dated-docs immutability check.`,
    );
    return 0;
  }

  // Modified (M) and renamed (R) entries only — additions and deletions are
  // allowed. --find-renames surfaces renames so we can flag them.
  const raw = git([
    'diff',
    '--name-status',
    '--find-renames',
    '--diff-filter=MR',
    mergeBase,
    'HEAD',
    '--',
    DOCS_PREFIX,
  ]);

  /** @type {{ path: string; kind: 'modified' | 'renamed'; to?: string }[]} */
  const violations = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    const status = fields[0];
    if (status.startsWith('R')) {
      // R<score>\t<old>\t<new> — the old path is the record being rewritten.
      const [, from, to] = fields;
      if (isDatedDoc(from)) violations.push({ path: from, kind: 'renamed', to });
    } else if (status.startsWith('M')) {
      const path = fields[1];
      if (isDatedDoc(path)) violations.push({ path, kind: 'modified' });
    }
  }

  if (violations.length === 0) {
    console.log(`dated docs under ${DOCS_PREFIX} are unchanged relative to ${base} — OK`);
    return 0;
  }

  console.error(
    `error: dated docs under ${DOCS_PREFIX} are write-once; the following committed dated file(s) were modified relative to ${base}:`,
  );
  for (const v of violations) {
    if (v.kind === 'renamed') {
      console.error(`  - ${v.path} (renamed to ${v.to})`);
    } else {
      console.error(`  - ${v.path} (modified)`);
    }
  }
  console.error(
    'A dated doc records what was planned vs. what was discovered — that record must not be rewritten.',
  );
  console.error(
    'Add a NEW dated file for a revised design instead of editing the existing one (see CLAUDE.md § Documentation).',
  );
  return 1;
}

process.exit(main());
