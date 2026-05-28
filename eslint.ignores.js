// @ts-check

/** Shared ignore patterns for ESLint configurations. */
export const ignores = [
  '**/node_modules/**',
  '**/dist/**',
  '**/coverage/**',
  '**/*.js',
  '**/*.mjs',
  '**/*.d.ts',
  'site/**',
  '.rundown/work/**',
  '.rundown/plans/**',
  '.work/**',
  '.worktree/**',
  '.worktrees/**',
  '**/.stryker-tmp/**',
  '**/.stryker-tmp*/**',
  'reports/**',
  'tests/e2e/fixtures/**',
  '.claude-docker/**',
];
