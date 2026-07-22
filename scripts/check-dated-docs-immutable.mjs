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
    if (
      git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
        allowFailure: true,
      })
    ) {
      return ref;
    }
  }
  return null;
}

/**
 * Whether the guard is running inside CI.
 *
 * In CI an unresolvable base or merge base is a misconfiguration (missing
 * history, an `origin/main` that was never fetched, a renamed base branch) —
 * not the offline clone that the local no-op path exists for — so it must fail
 * loudly rather than pass while checking nothing (issue #612).
 *
 * @returns {boolean} true when GITHUB_ACTIONS is 'true' or CI is truthy
 */
function isCI() {
  return process.env.GITHUB_ACTIONS === 'true' || Boolean(process.env.CI);
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
    const detail = 'no base ref resolvable (need full history / origin/main / --base)';
    if (isCI()) {
      console.error(
        `error: ${detail}; refusing to pass the dated-docs immutability check without a real comparison — this is a CI misconfiguration (ensure fetch-depth: 0 so origin/main is available, or pass --base).`,
      );
      return 1;
    }
    console.log(`note: ${detail}; skipping dated-docs immutability check.`);
    return 0;
  }

  const mergeBase = git(['merge-base', base, 'HEAD'], { allowFailure: true });
  if (!mergeBase) {
    const detail = `no merge base between ${base} and HEAD`;
    if (isCI()) {
      console.error(
        `error: ${detail}; refusing to pass the dated-docs immutability check without a real comparison — this is a CI misconfiguration (ensure full history is fetched with fetch-depth: 0).`,
      );
      return 1;
    }
    console.log(`note: ${detail}; skipping dated-docs immutability check.`);
    return 0;
  }

  // Modified (M) and renamed (R) entries only — additions and deletions are
  // allowed. --find-renames surfaces renames so we can flag them.
  //
  // Caveat: --find-renames uses git's default ~50% similarity threshold, so this
  // rename branch only catches *near-verbatim* renames. Two consequences follow:
  //  - A sanctioned "supersede with a new dated file" that copies most of the old
  //    file's text into the new one can be paired by git as a rename and flagged
  //    (a possible false positive — split the copy or reword to avoid it).
  //  - A rename combined with a >50% rewrite is reported as delete+add, not a
  //    rename, so it is NOT flagged. That is consistent with delete+add being
  //    allowed, but it means the rename branch is a near-verbatim tripwire, not a
  //    complete guard against "moved and rewritten" — do not over-trust it.
  // No `-- docs/superpowers/` pathspec: a dated doc *moved out* of the scope
  // prefix (e.g. into docs/internal/) rewrites the record just as an in-scope
  // rename does, but a pathspec that excludes the rename's destination makes git
  // report it as a plain deletion (allowed) instead of a rename (flagged). Diff
  // every path and rely on isDatedDoc() applied to the *old* path to scope the
  // check — that catches renames whether or not the destination is in scope.
  // -z: NUL-delimited, unquoted output. Without it, git C-quotes paths with
  // non-ASCII bytes or other unusual characters (wrapping them in double quotes
  // with octal escapes), which both breaks tab-splitting and hides the real path
  // from isDatedDoc(). With -z each field is a raw literal separated by NUL, so a
  // renamed record is `R<score>\0<old>\0<new>\0` and a modified one is `M\0<path>\0`.
  const raw = git([
    'diff',
    '--name-status',
    '--find-renames',
    '-z',
    '--diff-filter=MR',
    mergeBase,
    'HEAD',
  ]);

  /** @type {{ path: string; kind: 'modified' | 'renamed'; to?: string }[]} */
  const violations = [];
  const tokens = raw.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    if (!status) {
      i += 1; // skip empty trailing token (git terminates the last record with NUL)
      continue;
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      // R<score>/C<score> carry two path fields: <old> then <new>. The old path
      // is the record being rewritten.
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      i += 3;
      if (isDatedDoc(from)) violations.push({ path: from, kind: 'renamed', to });
    } else {
      // Single-path statuses (M here; A/D/T never reach us under --diff-filter=MR).
      const path = tokens[i + 1];
      i += 2;
      if (isDatedDoc(path)) violations.push({ path, kind: 'modified' });
    }
  }

  if (violations.length === 0) {
    // Name the resolved base and the compared range so a CI log positively shows
    // a real comparison happened rather than a silently skipped no-op.
    console.log(
      `dated docs under ${DOCS_PREFIX} are unchanged relative to ${base} (${mergeBase}..HEAD) — OK`,
    );
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
