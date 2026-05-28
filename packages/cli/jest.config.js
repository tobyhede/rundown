import base from '../../jest.config.base.js';

export default {
  ...base,
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts'],
  coverageThreshold: {
    global: {
      branches: 65,
      functions: 90,
      lines: 80,
      statements: 80,
    },
    './src/helpers/': {
      branches: 60,
      functions: 80,
      lines: 75,
      statements: 75,
    },
    './src/services/': {
      branches: 60,
      functions: 80,
      lines: 75,
      statements: 75,
    },
  },
  coverageReporters: ['text', 'lcov', 'html'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  extensionsToTreatAsEsm: ['.ts'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@rundown-org/core$': '<rootDir>/../core/src/index.ts',
    '^@rundown-org/core/testing/effective-vars$': '<rootDir>/../core/src/testing/effective-vars.ts',
    '^@rundown-org/parser$': '<rootDir>/../parser/src/index.ts',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
          lib: ['ES2022'],
          strict: true,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          skipLibCheck: true,
          forceConsistentCasingInFileNames: true,
          resolveJsonModule: true,
          isolatedModules: true,
          verbatimModuleSyntax: true,
        },
      },
    ],
  },
};
