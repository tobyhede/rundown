// @ts-check
import tseslint from 'typescript-eslint';
import globals from 'globals';
import jsdoc from 'eslint-plugin-jsdoc';

export default tseslint.config(
  // Ignore patterns (replaces .eslintignore)
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

  // TypeScript type-checked rules only (non-type-aware rules handled by Biome)
  ...tseslint.configs.strictTypeCheckedOnly,
  ...tseslint.configs.stylisticTypeCheckedOnly,

  // TSDoc coverage (warn level until coverage reaches ~95%)
  jsdoc.configs['flat/recommended-typescript'],

  // Global settings for all TypeScript files
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TSDoc coverage for exported symbols
      'jsdoc/require-jsdoc': [
        'warn',
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
            ArrowFunctionExpression: true,
            FunctionExpression: true,
          },
          contexts: ['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSEnumDeclaration'],
          exemptEmptyConstructors: true,
        },
      ],
      'jsdoc/require-description': 'warn',
      'jsdoc/require-param': 'warn',
      'jsdoc/require-param-description': 'warn',
      'jsdoc/require-returns': 'warn',
      'jsdoc/require-returns-description': 'warn',
      'jsdoc/require-throws': 'warn',
      'jsdoc/require-property': 'warn',
      'jsdoc/require-property-description': 'warn',
      'jsdoc/check-values': 'off',
      'jsdoc/tag-lines': 'off',

      // Explicit return types for public API clarity
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
        },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',

      // Type-safe imports
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
        },
      ],
      '@typescript-eslint/consistent-type-exports': [
        'error',
        {
          fixMixedExportsWithInlineTypeSpecifier: true,
        },
      ],

      // Unused vars with underscore exception
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },

  // Test files: relaxed rules for mocking flexibility
  {
    files: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-description': 'off',
      'jsdoc/require-param': 'off',
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/require-throws': 'off',
      'jsdoc/require-property': 'off',
      'jsdoc/require-property-description': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
);
