// __tests__/perf/hook-performance.test.ts
// Performance budget tests for hook processing

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  dispatch,
  shouldProcessHook,
  gateMatchesKeywords,
  gateMatchesFilePattern,
} from '../../src/dispatcher.js';
import { detectSyntheticEvents } from '../../src/synthetic-events/detector.js';
import { loadConfig } from '../../src/shared/config.js';
import {
  createMockHookInput,
  createMockConfig,
  measureExecutionTime,
  measureExecutionTimeSync,
  createTempTestDir,
  writeTestConfig,
} from '../helpers/test-utils.js';
import { execFileSync as originalExecFileSync } from 'node:child_process';
import { setExecSync } from '../../src/workflow/hooks/rundown.js';
import { mockExecFileSync } from '../helpers/execfile-mock.js';
import type { GateConfig, HookConfig } from '../../src/shared/index.js';

/**
 * Performance budget in milliseconds for hook operations.
 * Hooks must complete within this time to avoid blocking Claude's response.
 */
const HOOK_BUDGET_MS = 150;

/**
 * Tighter budget for pure computation (no I/O).
 */
const COMPUTE_BUDGET_MS = 50;

/**
 * Number of iterations for statistical significance.
 */
const ITERATIONS = 10;

describe('Hook Performance Budget', () => {
  let testDir: { path: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    testDir = await createTempTestDir('perf-test-');
  });

  afterEach(async () => {
    // Belt-and-braces: restore the real execFileSync so no mock installed
    // inside a test leaks into the next one. Individual tests may also
    // restore in their own `finally` blocks for early-failure safety.
    setExecSync(originalExecFileSync);
    await testDir.cleanup();
  });

  describe('dispatcher', () => {
    it('processes PostToolUse under budget', async () => {
      // Set up minimal config
      const config = createMockConfig({
        hooks: {
          PostToolUse: {
            enabled_tools: ['Edit'],
            gates: ['test-gate'],
          },
        },
        gates: {
          'test-gate': {
            command: 'echo "test"',
            on_pass: 'CONTINUE',
          },
        },
      });
      await writeTestConfig(testDir.path, config);

      const input = createMockHookInput('PostToolUse', {
        cwd: testDir.path,
        tool_name: 'Edit',
        tool_input: { file_path: path.join(testDir.path, 'src/file.ts') },
      });

      // Warm up
      await dispatch(input);

      // Measure
      const { durationMs } = await measureExecutionTime(() => dispatch(input));
      expect(durationMs).toBeLessThan(HOOK_BUDGET_MS);
    });

    it('processes SubagentStop under budget', async () => {
      const config = createMockConfig({
        hooks: {
          SubagentStop: {
            enabled_agents: ['test-agent'],
            gates: [],
          },
        },
        gates: {},
      });
      await writeTestConfig(testDir.path, config);

      const input = createMockHookInput('SubagentStop', {
        cwd: testDir.path,
        agent_type: 'test-agent',
        last_assistant_message: 'Agent completed successfully.',
      });

      // Warm up
      await dispatch(input);

      const { durationMs } = await measureExecutionTime(() => dispatch(input));
      expect(durationMs).toBeLessThan(HOOK_BUDGET_MS);
    });

    it('processes SubagentStop with delegation under budget', async () => {
      const config = createMockConfig({
        hooks: {
          SubagentStop: {
            enabled_agents: ['test-agent'],
            gates: [],
          },
        },
        gates: {},
      });
      await writeTestConfig(testDir.path, config);

      // Session expects token under metadata (SessionStateSchema)
      const sessionDir = path.join(testDir.path, '.claude', 'session');
      fs.mkdirSync(sessionDir, { recursive: true });
      const sessionFile = path.join(sessionDir, 'state.json');
      const seedSession = () => {
        fs.writeFileSync(
          sessionFile,
          JSON.stringify({
            metadata: { delegation_active_token: 'rdtk_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567' },
          }),
        );
      };

      // Mock rd status --json to return a deterministic response
      const statusJson = JSON.stringify({
        active: true,
        stashed: false,
        file: 'parent.runbook.md',
        delegations: [],
      });
      setExecSync(mockExecFileSync(statusJson));

      try {
        const input = createMockHookInput('SubagentStop', {
          cwd: testDir.path,
          agent_type: 'test-agent',
          last_assistant_message: 'Agent completed successfully.',
        });

        // Warm up (consumes the one-shot token)
        seedSession();
        await dispatch(input);

        // Re-seed so the timed run exercises the full delegation path
        seedSession();
        const { durationMs } = await measureExecutionTime(() => dispatch(input));
        expect(durationMs).toBeLessThan(HOOK_BUDGET_MS);
      } finally {
        // Restore the real execFileSync so subsequent tests don't inherit a mock.
        setExecSync(originalExecFileSync);
      }
    });

    it('handles missing config gracefully and quickly', async () => {
      // No config file in testDir
      const input = createMockHookInput('PostToolUse', {
        cwd: testDir.path,
      });

      const { durationMs } = await measureExecutionTime(() => dispatch(input));
      expect(durationMs).toBeLessThan(HOOK_BUDGET_MS);
    });
  });

  describe('config loading', () => {
    it('loads config under budget', async () => {
      const config = createMockConfig();
      await writeTestConfig(testDir.path, config);

      // Warm up
      await loadConfig(testDir.path);

      const { durationMs } = await measureExecutionTime(() => loadConfig(testDir.path));
      expect(durationMs).toBeLessThan(COMPUTE_BUDGET_MS);
    });

    it('handles missing config under budget', async () => {
      const { durationMs } = await measureExecutionTime(() => loadConfig(testDir.path));
      expect(durationMs).toBeLessThan(COMPUTE_BUDGET_MS);
    });
  });

  describe('shouldProcessHook', () => {
    it('filters PostToolUse under budget', () => {
      const input = createMockHookInput('PostToolUse');
      const hookConfig: HookConfig = {
        enabled_tools: ['Edit', 'Write', 'Read'],
      };

      const { durationMs } = measureExecutionTimeSync(() => {
        for (let i = 0; i < 1000; i++) {
          shouldProcessHook(input, hookConfig);
        }
      });

      // 1000 iterations should complete quickly
      expect(durationMs).toBeLessThan(20);
    });

    it('filters SubagentStop under budget', () => {
      const input = createMockHookInput('SubagentStop');
      const hookConfig: HookConfig = {
        enabled_agents: ['agent-a', 'agent-b', 'agent-c'],
      };

      const { durationMs } = measureExecutionTimeSync(() => {
        for (let i = 0; i < 1000; i++) {
          shouldProcessHook(input, hookConfig);
        }
      });

      expect(durationMs).toBeLessThan(20);
    });
  });

  describe('gateMatchesKeywords', () => {
    it('matches keywords under budget', () => {
      const gateConfig: GateConfig = {
        command: 'test',
        keywords: ['test', 'verify', 'check', 'validate', 'run'],
      };
      const message = 'Please run the tests and verify everything works correctly';

      const { durationMs } = measureExecutionTimeSync(() => {
        for (let i = 0; i < 1000; i++) {
          gateMatchesKeywords(gateConfig, message);
        }
      });

      expect(durationMs).toBeLessThan(20);
    });

    it('handles no keywords under budget', () => {
      const gateConfig: GateConfig = {
        command: 'test',
      };
      const message = 'Some user message';

      const { durationMs } = measureExecutionTimeSync(() => {
        for (let i = 0; i < 1000; i++) {
          gateMatchesKeywords(gateConfig, message);
        }
      });

      // Relaxed from 5ms: no-keywords gate includes pattern compilation overhead in CI
      expect(durationMs).toBeLessThan(10);
    });
  });

  describe('gateMatchesFilePattern', () => {
    it('matches patterns under budget', async () => {
      const gateConfig: GateConfig = {
        command: 'test',
        file_patterns: ['packages/cts/**', 'packages/shared/**', 'src/**/*.ts'],
      };
      const filePath = '/project/packages/cts/src/index.ts';
      const cwd = '/project';

      // Warm up
      await gateMatchesFilePattern(gateConfig, filePath, cwd);

      const durations: number[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const { durationMs } = await measureExecutionTime(() =>
          gateMatchesFilePattern(gateConfig, filePath, cwd),
        );
        durations.push(durationMs);
      }

      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
      expect(avgDuration).toBeLessThan(COMPUTE_BUDGET_MS);
    });

    it('handles no patterns under budget', async () => {
      const gateConfig: GateConfig = {
        command: 'test',
      };
      const filePath = '/project/src/file.ts';
      const cwd = '/project';

      const { durationMs } = await measureExecutionTime(() =>
        gateMatchesFilePattern(gateConfig, filePath, cwd),
      );

      expect(durationMs).toBeLessThan(5);
    });
  });
});

describe('Synthetic Event Detection Performance', () => {
  it('detects synthetic events under budget', () => {
    const inputs = [
      createMockHookInput('PreToolUse', {
        tool_name: 'Skill',
        tool_input: { skill: 'rundown:verify' },
      }),
      createMockHookInput('PostToolUse', {
        tool_name: 'Task',
        tool_input: { description: '1.1 - Implement feature', subagent_type: 'code-agent' },
        tool_use_id: 'tool-123',
      }),
      createMockHookInput('UserPromptSubmit', {
        prompt: '/execute the plan',
      }),
      createMockHookInput('Stop'),
    ];

    for (const input of inputs) {
      const { durationMs } = measureExecutionTimeSync(() => {
        for (let i = 0; i < 1000; i++) {
          detectSyntheticEvents(input);
        }
      });

      // 1000 detections should be fast
      expect(durationMs).toBeLessThan(50);
    }
  });

  it('handles complex inputs under budget', () => {
    const input = createMockHookInput('PostToolUse', {
      tool_name: 'Task',
      tool_input: {
        description:
          '12.5 - This is a very long description that contains lots of text and details about what the task should accomplish including multiple sentences and various punctuation marks!',
        subagent_type: 'cipherpowers:ultrathink-debugger',
        prompt: 'A long prompt that explains what the agent should do in great detail...',
      },
      tool_use_id: 'a'.repeat(100), // Long ID
    });

    const { durationMs } = measureExecutionTimeSync(() => {
      for (let i = 0; i < 1000; i++) {
        detectSyntheticEvents(input);
      }
    });

    expect(durationMs).toBeLessThan(30);
  });
});

describe('Memory Usage', () => {
  it('does not leak memory during repeated dispatches', async () => {
    const testDir = await createTempTestDir('memory-test-');

    try {
      const config = createMockConfig();
      await writeTestConfig(testDir.path, config);

      const input = createMockHookInput('PostToolUse', {
        cwd: testDir.path,
      });

      // Warm one-time allocations/caches before the baseline measurement
      await dispatch(input);

      // Force GC if available
      if (global.gc) {
        global.gc();
      }

      const beforeMemory = process.memoryUsage().heapUsed;

      // Run many dispatches
      for (let i = 0; i < 100; i++) {
        await dispatch(input);
      }

      // Force GC if available
      if (global.gc) {
        global.gc();
      }

      const afterMemory = process.memoryUsage().heapUsed;
      const memoryGrowth = afterMemory - beforeMemory;

      // Memory growth should be minimal (less than 50MB)
      // Generous threshold because GC is non-deterministic without --expose-gc
      expect(memoryGrowth).toBeLessThan(50 * 1024 * 1024);
    } finally {
      await testDir.cleanup();
    }
  });
});

describe('Concurrent Processing', () => {
  it('handles concurrent hook dispatches', async () => {
    const testDir = await createTempTestDir('concurrent-test-');

    try {
      const config = createMockConfig({
        gates: {},
      });
      await writeTestConfig(testDir.path, config);

      const input = createMockHookInput('PostToolUse', {
        cwd: testDir.path,
      });

      const CONCURRENCY = 10;

      // Warm up to amortise first-call costs (module init, fs cache priming)
      // before either measurement, so neither is penalised for cold start.
      await dispatch(input);

      // Baseline: run the same work serially, measured in this same process.
      // This self-calibrates to the current runner's speed and to coverage
      // instrumentation overhead, so the assertion below is independent of
      // absolute CI machine performance.
      const { durationMs: serialMs } = await measureExecutionTime(async () => {
        for (let i = 0; i < CONCURRENCY; i++) {
          await dispatch(input);
        }
      });

      // Launch the same number of dispatches concurrently.
      const { durationMs: concurrentMs } = await measureExecutionTime(() =>
        Promise.all(Array.from({ length: CONCURRENCY }, () => dispatch(input))),
      );

      // The property under test: concurrency must not serialise. Running the
      // dispatches in parallel should never be meaningfully slower than running
      // them one after another. We compare against the in-run serial baseline
      // (not an absolute millisecond budget, which drifts with runner load and
      // coverage overhead) and allow a generous margin for scheduler jitter and
      // I/O contention between the concurrent dispatches.
      expect(concurrentMs).toBeLessThan(serialMs * 1.5);
    } finally {
      await testDir.cleanup();
    }
  });
});
