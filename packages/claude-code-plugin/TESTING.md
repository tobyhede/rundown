# Testing Guide for @rundown-org/claude-code-plugin

This document describes the test architecture, how to run tests, and testing best practices for the claude-code-plugin package.

Legacy payload aliases are unsupported. Inputs containing `user_message`, `agent_name`, `subagent_name`, `output`, or top-level `file_path` are rejected at schema validation.

## Test Architecture

### Directory Structure

```
__tests__/
├── helpers/
│   └── test-utils.ts       # Shared test utilities
├── gates/
│   ├── plugin-path.test.ts
│   ├── workflow-skill-start.test.ts
│   ├── workflow-step-tracker.test.ts
│   ├── workflow-subagent-start.test.ts
│   └── workflow-subagent-stop.test.ts
├── integration/
│   └── synthetic-gates.test.ts
├── perf/
│   └── hook-performance.test.ts
├── security/
│   └── path-traversal.test.ts
├── shared/
│   └── logger.test.ts
├── synthetic-events/
│   ├── detector.test.ts
│   ├── integration.test.ts
│   └── registry-coverage.test.ts
├── workflow/
│   └── hooks/
│       ├── rundown.test.ts
│       └── subagent-stop.test.ts
├── action-handler.test.ts
├── builtin-gates.test.ts
├── cli.test.ts
├── cli.integration.test.ts
├── config.test.ts
├── context.test.ts
├── dispatcher.test.ts
├── errors.test.ts
├── gate-loader.test.ts
├── integration.test.ts
├── plugin-gates.integration.test.ts
├── schemas.test.ts
├── schemas.properties.test.ts
├── session.test.ts
├── session.properties.test.ts
└── types.test.ts
```

### Test Categories

1. **Unit Tests**: Test individual functions in isolation
2. **Integration Tests**: Test component interactions
3. **Performance Tests**: Verify operations complete within budget
4. **Security Tests**: Verify security boundaries
5. **Property Tests**: Use fast-check for property-based testing

## Running Tests

### Basic Commands

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run performance tests only
npm run test:perf

# Run CI tests (coverage + limited workers)
npm run test:ci

# Run smoke tests
npm run test:smoke
```

### Running Specific Tests

```bash
# Run tests matching a pattern
npm test -- --testPathPatterns=dispatcher

# Run a specific test file
npm test -- __tests__/dispatcher.test.ts

# Run tests in a specific directory
npm test -- __tests__/security/
```

### Coverage Thresholds

The project enforces minimum coverage thresholds:

- **Global**: 40% branches, 50% functions, 50% lines
- **dispatcher.ts**: 80% branches, 90% functions, 85% lines

## Manual Verification Commands

Use these commands to manually test hook dispatch behavior:

### PostToolUse - Edit

```bash
echo '{"hook_event_name":"PostToolUse","cwd":"'$(pwd)'","tool_name":"Edit","tool_input":{"file_path":"src/test.ts"}}' | node dist/cli.js
```

### PreToolUse - Skill

```bash
echo '{"hook_event_name":"PreToolUse","cwd":"'$(pwd)'","tool_name":"Skill","tool_input":{"skill":"rundown:verify"}}' | node dist/cli.js
```

### SubagentStop

**No-op path** (no active delegation — fast exit):

```bash
echo '{"hook_event_name":"SubagentStop","cwd":"'$(pwd)'","agent_id":"test-agent","agent_type":"code-review-agent","last_assistant_message":"Agent completed successfully."}' | node dist/cli.js
```

**Delegation correlation path** (exercises `rd status --json` flow):

1. Start a runbook with a delegation substep and create a delegation token:
   ```bash
   rd run my-runbook.md
   rd delegate --step 2.1
   ```
2. Claim the delegation token in a separate session (to seed `delegation_active_token`):
   ```bash
   rd claim <token>
   ```
3. Send SubagentStop with the same cwd so the handler finds the session token:
   ```bash
   echo '{"hook_event_name":"SubagentStop","cwd":"'$(pwd)'","agent_id":"test-agent","agent_type":"code-review-agent","last_assistant_message":"Agent completed successfully."}' | node dist/cli.js
   ```

The handler will call `rd status --json`, correlate the token hash against active delegations, and produce a context message based on the delegation state.

### UserPromptSubmit

```bash
echo '{"hook_event_name":"UserPromptSubmit","cwd":"'$(pwd)'","prompt":"/commit"}' | node dist/cli.js
```

### Session Commands

```bash
# Set active command
node dist/cli.js session set active_command /execute $(pwd)

# Get active command
node dist/cli.js session get active_command $(pwd)

# Append to edited files
node dist/cli.js session append edited_files src/file.ts $(pwd)

# Check if file was edited
node dist/cli.js session contains edited_files src/file.ts $(pwd)

# Clear session
node dist/cli.js session clear $(pwd)
```

## Writing Tests

### Using Test Utilities

The `__tests__/helpers/test-utils.ts` file provides utilities for common test patterns:

```typescript
import {
  createMockHookInput,
  createMockConfig,
  createMockSessionState,
  createTempTestDir,
  writeTestConfig,
  measureExecutionTime,
  measureExecutionTimeSync,
  createMockExecSync,
  createMockExecSyncError
} from '../helpers/test-utils.js';

// Create mock hook input
const input = createMockHookInput('PostToolUse', {
  tool_name: 'Edit',
  tool_input: { file_path: '/test/file.ts' }
});

// Create temp directory with cleanup
const testDir = await createTempTestDir();
try {
  await writeTestConfig(testDir.path, createMockConfig());
  // ... run tests
} finally {
  await testDir.cleanup();
}

// Measure performance
const { result, durationMs } = await measureExecutionTime(() =>
  dispatch(input)
);
expect(durationMs).toBeLessThan(150);
```

### Performance Testing Best Practices

1. **Warm up first**: Run the function once before measuring
2. **Use appropriate budgets**: 150ms for I/O, 50ms for pure computation
3. **Run multiple iterations**: For statistical significance
4. **Test concurrent behavior**: Verify parallel execution works

```typescript
// Warm up
await dispatch(input);

// Measure
const { durationMs } = await measureExecutionTime(() => dispatch(input));
expect(durationMs).toBeLessThan(HOOK_BUDGET_MS);
```

### Security Testing Best Practices

1. **Test malicious inputs**: Path traversal, injection attempts
2. **Verify boundaries**: Ensure operations stay within allowed scope
3. **Test error cases**: Verify proper error handling for invalid input

```typescript
const MALICIOUS_PATHS = [
  '../../../etc/passwd',
  '..\\..\\windows\\system32',
  'valid/../../../escape'
];

for (const path of MALICIOUS_PATHS) {
  expect(() => resolvePluginPath(path)).toThrow(/path separators/i);
}
```

## Docker Testing

Build and run tests in a container:

```bash
# Build test container
docker build -f Dockerfile.test -t claude-code-plugin-test .

# Run smoke tests
docker run --rm claude-code-plugin-test

# Run all tests
docker run --rm claude-code-plugin-test npm test
```

## Debugging Tests

### View logs during tests

```bash
# Enable plugin logging
RUNDOWN_PLUGIN_LOG=1 npm test

# Set debug log level
RUNDOWN_PLUGIN_LOG_LEVEL=debug npm test
```

### View log files

```bash
# Get log directory
node dist/cli.js log-dir

# View today's logs
tail -f $(node dist/cli.js log-path)
```

## Adding New Tests

1. **Create test file**: Place in appropriate `__tests__/` subdirectory
2. **Import utilities**: Use `test-utils.ts` for common patterns
3. **Use descriptive names**: Describe what's being tested
4. **Test edge cases**: Empty inputs, invalid data, boundaries
5. **Verify cleanup**: Use `afterEach` for cleanup

### Template

```typescript
import { jest } from '@jest/globals';
import {
  createMockHookInput,
  createTempTestDir
} from '../helpers/test-utils.js';

describe('MyFeature', () => {
  let testDir: { path: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    testDir = await createTempTestDir();
  });

  afterEach(async () => {
    await testDir.cleanup();
    jest.restoreAllMocks();
  });

  describe('functionality', () => {
    it('does something specific', async () => {
      const input = createMockHookInput('PostToolUse');
      // ... test implementation
    });
  });

  describe('error handling', () => {
    it('handles invalid input gracefully', () => {
      // ... error case tests
    });
  });
});
```
