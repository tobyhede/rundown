import { jest } from '@jest/globals';
import type { RunbookActorService, RunbookStateManager } from '@rundown-org/core';
import type { RunPipelineContext } from '../../src/helpers/runbook-pipeline.js';
import type { OutputEmitter } from '../../src/services/output-emitter.js';
import { mockFn } from './typed-mocks.js';

/** Per-field overrides for {@link makeRunPipelineContext}. */
export interface RunPipelineContextOverrides {
  output?: Partial<OutputEmitter>;
  manager?: Partial<RunbookStateManager>;
  actorService?: Partial<RunbookActorService>;
  cwd?: string;
  launchDir?: string;
}

/**
 * Build a structurally mocked pipeline context for `startRunbook` tests.
 *
 * Every injected core service is an object-shaped double (CLAUDE.md § Testing
 * Conventions). The manager's `create` resolves to a minimal run state and
 * `delete` succeeds so the launch's best-effort cleanup is observable.
 *
 * @param overrides - Fields to replace on the default doubles
 * @returns A pipeline context whose services are mocks
 */
export function makeRunPipelineContext(
  overrides: RunPipelineContextOverrides = {},
): RunPipelineContext {
  return {
    output: {
      error: jest.fn(),
      status: jest.fn(),
      action: jest.fn(),
      detail: jest.fn(),
      flush: jest.fn(),
      executionEvent: jest.fn(),
      ...overrides.output,
    } as unknown as OutputEmitter,
    manager: {
      create: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ id: 'run-1' }),
      update: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
      load: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
      delete: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
      ...overrides.manager,
    } as unknown as RunbookStateManager,
    actorService: {
      initializeState:
        mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
      ...overrides.actorService,
    } as unknown as RunbookActorService,
    cwd: overrides.cwd ?? '/test',
    launchDir: overrides.launchDir ?? '.',
  };
}
