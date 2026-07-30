// @ts-check

/** Shared ignore patterns for ESLint configurations. */
export const ignores = [
  '**/node_modules/**',
  '**/dist/**',
  '**/coverage/**',
  '**/*.js',
  '**/*.mjs',
  '**/*.cjs',
  '**/*.d.ts',
  'site/**',
  '.rundown/work/**',
  '.rundown/plans/**',
  '.work/**',
  '.worktree/**',
  '.worktrees/**',
  // Claude Code-managed worktrees (git-excluded via .git/info/exclude). Each is a
  // full checkout, so linting them multiplies the typed-lint surface and puts
  // duplicate copies of the workspace packages in front of module resolution —
  // which both exhausts the heap and degrades real files' types to `any`.
  // biome.json and .prettierignore already exclude this path.
  '.claude/worktrees/**',
  '**/.stryker-tmp/**',
  '**/.stryker-tmp*/**',
  'reports/**',
  'tests/e2e/fixtures/**',
  '.claude-docker/**',
];
