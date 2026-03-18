// @ts-check
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/*.js',
      '**/stryker.config.mjs',
      '**/*.d.ts',
      'site/**',
      '.work/**',
      '.worktree/**',
      '.worktrees/**',
      '**/.stryker-tmp/**',
    ],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
      parser: tseslint.parser,
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    // Intentional: 'warn' severity — complexity checks are advisory, not CI-blocking.
    rules: {
      complexity: ['warn', { max: 15 }],
      'max-lines-per-function': ['warn', { max: 100, skipBlankLines: true, skipComments: true }],
      'max-depth': ['warn', { max: 4 }],
      'max-params': ['warn', { max: 4 }],
    },
  },
);
