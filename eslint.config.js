// @ts-check
import tseslint from 'typescript-eslint';
import globals from 'globals';
import jsdoc from 'eslint-plugin-jsdoc';
import { ignores } from './eslint.ignores.js';

export default tseslint.config(
  // Ignore patterns (replaces .eslintignore)
  { ignores },

  // TypeScript type-checked rules only (non-type-aware rules handled by Biome)
  ...tseslint.configs.strictTypeCheckedOnly,
  ...tseslint.configs.stylisticTypeCheckedOnly,

  // TSDoc coverage enforcement
  // Exclude test files — tests don't need JSDoc enforcement
  {
    ...jsdoc.configs['flat/recommended-typescript'],
    ignores: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
  },

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
        'error',
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
      'jsdoc/require-description': 'error',
      'jsdoc/require-param': 'error',
      'jsdoc/require-param-description': 'error',
      'jsdoc/require-returns': 'error',
      'jsdoc/require-returns-description': 'error',
      'jsdoc/require-throws': 'error',
      'jsdoc/require-property': 'error',
      'jsdoc/require-property-description': 'error',
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

      // Ban direct `Error.isError(...)` calls — undefined in Node ≤ 23
      // (notably WebContainer's bundled Node 22.x, used by the marketing
      // site and Playwright tests). Use the centralized polyfilled helpers
      // `isError()` / `isNodeError()` from `@rundown-org/core` (or
      // `packages/claude-code-plugin/src/shared/errors.ts` in the plugin).
      // The polyfill modules themselves are allow-listed in a later block.
      //
      // Also bans `as TrustedArtifactRecord` / `as TrustedArtifactArray` /
      // `as TrustedArtifactValue` casts. The trust brand is a non-enumerable
      // runtime symbol attached via `Object.defineProperty` inside the
      // sanctioned producer functions in `effective-vars.ts`; a final cast
      // codifies the mint at the end of each producer body. Any other `as`
      // cast to a trust-branded type is an escape hatch that bypasses the
      // runtime brand check. The type system cannot catch this structurally
      // because `ArtifactRecord` is assignable to `JsonObject` (see
      // `packages/core/src/runbook/types.ts:304-308`). The override block
      // below scopes the cast exception to the producer + test-helper files.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name='Error'][callee.property.name='isError']",
          message:
            'Use isError() / isNodeError() from @rundown-org/core (or shared/errors in the plugin) — direct Error.isError() is undefined in Node ≤ 23 and breaks WebContainer.',
        },
        {
          selector: "TSAsExpression[typeAnnotation.typeName.name='TrustedArtifactRecord']",
          message:
            'Use brandTrustedArtifactRecord() from effective-vars to mint trust. Direct `as TrustedArtifactRecord` casts bypass the runtime brand check.',
        },
        {
          selector: "TSAsExpression[typeAnnotation.typeName.name='TrustedArtifactArray']",
          message:
            'Use brandTrustedArtifactArray() from effective-vars to mint trust. Direct `as TrustedArtifactArray` casts bypass the runtime brand check.',
        },
        {
          selector: "TSAsExpression[typeAnnotation.typeName.name='TrustedArtifactValue']",
          message:
            'Use brandTrustedArtifactValue() from effective-vars to mint trust. Direct `as TrustedArtifactValue` casts bypass the runtime brand check.',
        },
        {
          // Closes the dynamic-import gap left by the front-end no-restricted-imports
          // boundary (below): no-restricted-imports vets static named/aliased/namespace
          // imports of parser template-syntax APIs, but not `await import('@rundown-org/parser')`.
          // Module-broad by necessity — a dynamic import yields the whole namespace, so the
          // three names can't be singled out at the import site. No code dynamically imports
          // the parser today; this is defense-in-depth.
          selector: "ImportExpression[source.value='@rundown-org/parser']",
          message:
            'Do not dynamically import @rundown-org/parser to reach template-syntax APIs. Consume rendered/evaluated results via @rundown-org/core. (Static imports of allowed parser APIs are vetted by no-restricted-imports.)',
        },
      ],
    },
  },

  // Polyfill modules: the only place where direct `Error.isError()` is allowed.
  // These files implement the feature-detected fallback that all other code
  // routes through — see the `no-restricted-syntax` rule above.
  {
    files: ['packages/core/src/errors.ts', 'packages/claude-code-plugin/src/shared/errors.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // Trust-brand producers and test helpers: the only places where direct
  // `as TrustedArtifact*` casts are allowed. The production producers in
  // `effective-vars.ts` attach the runtime brand via `Object.defineProperty`
  // and codify the mint with a final cast. The test-helper modules mirror
  // those producers for fixture construction. The rule above forbids the
  // cast everywhere else; this override scopes the exception narrowly.
  {
    files: [
      'packages/core/src/runbook/effective-vars.ts',
      'packages/core/src/testing/effective-vars.ts',
      'packages/cli/__tests__/helpers/brand-helpers.ts',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // Architectural boundary: the front-end packages (CLI, MCP, plugin) are
  // alternate front ends over @rundown-org/core. They must not reach into the
  // parser's template *syntax* APIs directly — template tokenization and
  // expression parsing are consumed only by @rundown-org/core, which owns
  // render and OUTPUTS semantics. Front ends invoke core and observe its
  // output; they never re-classify template syntax themselves.
  //
  // This is AST-accurate enforcement (it ignores the names in comments/strings,
  // catches aliased and namespace imports, and only flags genuine imports from
  // @rundown-org/parser), mirroring the no-restricted-syntax bans above. Scoped
  // to src so test fixtures and mocks are unaffected.
  {
    files: [
      'packages/cli/src/**/*.ts',
      'packages/mcp/src/**/*.ts',
      'packages/claude-code-plugin/src/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@rundown-org/parser',
              importNames: ['tokenizeTemplate', 'parseTemplateExpression', 'parseOutputExpression'],
              message:
                'Front-end packages must not import parser template-syntax APIs. Template tokenization and expression parsing are core-internal; consume the rendered/evaluated result via @rundown-org/core instead.',
            },
          ],
        },
      ],
    },
  },

  // Test files: relaxed rules for mocking flexibility
  {
    files: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      // Disable jsdoc/require-* rules set in the main **/*.ts block
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
