// @ts-check
import tseslint from 'typescript-eslint';
import globals from 'globals';
import jsdoc from 'eslint-plugin-jsdoc';
import { ignores } from './eslint.ignores.js';

// Ban direct `Error.isError(...)` calls — undefined in Node ≤ 23 (notably
// WebContainer's bundled Node 22.x). Use the polyfilled helpers from
// @rundown-org/core (or shared/errors in the plugin). Applies everywhere,
// including tests; the polyfill modules themselves are allow-listed below.
const errorIsErrorSelector = {
  selector:
    "CallExpression[callee.type='MemberExpression'][callee.object.name='Error'][callee.property.name='isError']",
  message:
    'Use isError() / isNodeError() from @rundown-org/core (or shared/errors in the plugin) — direct Error.isError() is undefined in Node ≤ 23 and breaks WebContainer.',
};

// Ban `as TrustedArtifact*` casts — the trust brand is a non-enumerable runtime
// symbol minted only by the sanctioned producers in effective-vars.ts. The type
// system cannot catch this structurally (ArtifactRecord is assignable to
// JsonObject). brand-helpers.ts and the producers are exempted below.
const trustedArtifactCastSelectors = [
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
];

// Closes the dynamic-import gap left by the front-end no-restricted-imports
// boundary (below): no-restricted-imports vets static named/aliased/namespace
// imports of parser template-syntax APIs, but not `await import('@rundown-org/parser')`.
// Module-broad by necessity — a dynamic import yields the whole namespace, so the
// three banned names can't be singled out at the import site.
//
// Two selectors cover both spellings of the literal specifier: a plain string
// (`import('@rundown-org/parser')`, source is a `Literal`) and a no-substitution
// template (`import(`@rundown-org/parser`)`, source is a `TemplateLiteral` with a
// single quasi and no expressions — it has no `.value`, so the first selector
// misses it). Computed/concatenated specifiers are out of scope by design.
//
// Scoped to production source only, mirroring the static boundary's "test fixtures
// and mocks are unaffected" exemption: ESM jest mocking (`jest.unstable_mockModule`)
// legitimately dynamic-imports the parser to mock allowed APIs (e.g. extractFrontmatter),
// and tests may stand in for parser internals directly. The test-file override below
// re-declares no-restricted-syntax without these selectors. As of writing, the only
// dynamic parser imports in the repo are those test mocks.
const parserDynamicImportMessage =
  'Do not dynamically import @rundown-org/parser to reach template-syntax APIs. Consume rendered/evaluated results via @rundown-org/core. (Static imports of allowed parser APIs are vetted by no-restricted-imports.)';
const parserDynamicImportSelectors = [
  {
    selector: "ImportExpression[source.value='@rundown-org/parser']",
    message: parserDynamicImportMessage,
  },
  {
    selector:
      "ImportExpression[source.type='TemplateLiteral'][source.expressions.length=0][source.quasis.0.value.raw='@rundown-org/parser']",
    message: parserDynamicImportMessage,
  },
];

// Clean-extraction guard for the parser's template-syntax surface. These three
// modules are pure string/grammar/identity logic: `tokenizeTemplate`,
// `parseTemplateExpression`, the `{{ }}` grammar patterns, and built-in helper
// name identity. They depend only on each other and carry no markdown-parsing
// dependencies — unlike the rest of @rundown-org/parser, whose runtime deps are
// a markdown stack (gray-matter, mdast/unist/micromark, etc.).
//
// Keeping this surface free of that stack is what makes a future
// @rundown-org/template extraction a self-contained move of these files rather
// than a dependency untangle (issue #393). The ban is scoped to the three-file
// closure: as long as none of them reaches the markdown stack — directly or via
// a sibling that does — the whole subgraph stays pure. If you add an import to
// one of these files, the target must itself be equally pure.
const templateSyntaxFiles = [
  'packages/parser/src/template.ts',
  'packages/parser/src/template-grammar.ts',
  'packages/parser/src/reserved.ts',
];
const templateSyntaxPurityMessage =
  'Template-syntax modules (template.ts, template-grammar.ts, reserved.ts) must stay free of the markdown-parsing stack so a future @rundown-org/template extraction remains a self-contained move (issue #393). Keep them to pure string/grammar/identity logic.';
const markdownStackGroup = [
  'gray-matter',
  'mdast',
  'mdast-util-*',
  'unist',
  'unist-util-*',
  'micromark',
  'micromark-*',
  'remark',
  'remark-*',
  'unified',
  'vfile',
  'vfile-*',
];

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

      // Restricted-syntax bans (Error.isError, trust-brand casts, parser
      // dynamic import). Selector definitions and full rationale live at the
      // top of this file; the override blocks below scope the cast exception
      // to the producer + test-helper files and the parser-import exception to
      // test fixtures and mocks.
      'no-restricted-syntax': [
        'error',
        errorIsErrorSelector,
        ...trustedArtifactCastSelectors,
        ...parserDynamicImportSelectors,
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

  // Clean-extraction guard: the template-syntax surface must not import the
  // markdown-parsing stack. Rationale and the three-file closure are documented
  // at `templateSyntaxFiles` above (issue #393).
  {
    files: templateSyntaxFiles,
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: markdownStackGroup,
              message: templateSyntaxPurityMessage,
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

  // Test fixtures and mocks: exempt from the parser dynamic-import ban, mirroring
  // the front-end no-restricted-imports boundary's "test fixtures and mocks are
  // unaffected" scope. ESM jest mocking (`jest.unstable_mockModule`) must
  // dynamic-import `@rundown-org/parser` to mock allowed APIs (e.g. extractFrontmatter)
  // while passing the rest of the namespace through. The Error.isError and
  // trust-brand-cast bans still apply to tests, so they are re-declared here.
  //
  // brand-helpers.ts is excluded: it carries its own `no-restricted-syntax: off`
  // override (the sanctioned place for `as TrustedArtifact*` casts), and that
  // exemption must survive — re-declaring the rule here would otherwise clobber it.
  {
    files: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    ignores: ['packages/cli/__tests__/helpers/brand-helpers.ts'],
    rules: {
      'no-restricted-syntax': ['error', errorIsErrorSelector, ...trustedArtifactCastSelectors],
    },
  },
);
