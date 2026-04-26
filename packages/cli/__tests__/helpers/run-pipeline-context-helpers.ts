import { jest } from '@jest/globals';
import type {
  ExecutionLifecycleService,
  RunbookActorService,
  RunbookStateManager,
  SessionService,
} from '@rundown-org/core';
import type { RunPipelineContext } from '../../src/helpers/runbook-pipeline.js';
import type { OutputEmitter } from '../../src/services/output-emitter.js';
import { mockFn } from './typed-mocks.js';

/**
 * Structurally compatible overrides for CLI run pipeline tests.
 *
 * Tests outside `@rundown-org/core` should use object-shaped service doubles
 * for injected dependencies instead of constructing service classes from a
 * mocked core module.
 */
export interface RunPipelineContextOverrides {
  output?: Partial<OutputEmitter>;
  manager?: Partial<RunbookStateManager>;
  actorService?: Partial<RunbookActorService>;
  sessionService?: Partial<SessionService>;
  lifecycleService?: Partial<ExecutionLifecycleService>;
  cwd?: string;
}

/**
 * Create a minimal `RunPipelineContext` for CLI tests.
 *
 * @param overrides - Service or cwd overrides for behavior under test.
 * @returns A structurally compatible run pipeline context.
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
      ...overrides.output,
    } as unknown as OutputEmitter,
    manager: {
      create: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ id: 'run-1' }),
      update: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
      load: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
      initializeSubsteps:
        mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
      ...overrides.manager,
    } as unknown as RunbookStateManager,
    actorService: {
      initializeState:
        mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
      ...overrides.actorService,
    } as unknown as RunbookActorService,
    sessionService: {
      pushRunbook: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
      ...overrides.sessionService,
    } as unknown as SessionService,
    lifecycleService: {
      ensureActiveEntry:
        mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
      ...overrides.lifecycleService,
    } as unknown as ExecutionLifecycleService,
    cwd: overrides.cwd ?? '/test',
  };
}
