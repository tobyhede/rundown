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
  // Deliberate `RenderedUnitCommand` forgeries. Every file there violates
  // `local/no-rendered-unit-command-cast` on purpose, so linting them normally
  // would fail this gate forever. `scripts/__tests__/eslint-brand-cast-guard.test.mjs`
  // re-includes them with `new ESLint({ ignore: false })`, which overrides file
  // SELECTION only — the rule configuration those paths resolve is this config,
  // unmodified, which is what makes the test meaningful. That test also asserts
  // this entry still hides them, so deleting it fails rather than quietly
  // reddening the repository.
  'packages/core/__tests__/fixtures/brand-cast/**',
  '.claude-docker/**',
];
