// jest.setup.ts
// Environment configuration for tests

// Disable logging in tests
process.env.TEST_ENV = 'jest';
process.env.RUNDOWN_PLUGIN_LOG = '0';

// Note: Test timeout is configured in jest.config.js via testTimeout option
