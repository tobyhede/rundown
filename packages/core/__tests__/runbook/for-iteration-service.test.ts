import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { RunbookState, ForContext, Step } from '../../src/runbook/types.js';

// Capture the real ForResolutionError before the mock is installed.
// jest.unstable_mockModule does NOT hoist, so this top-level await executes
// first and always captures the real class.
const { ForResolutionError: RealForResolutionError } = await import(
  '../../src/runbook/source-resolver.js'
);

// Mock source-resolver to avoid file I/O in unit tests
jest.unstable_mockModule('../../src/runbook/source-resolver.js', () => ({
  resolveForValue: jest.fn(),
}));

// Mock snapshot-utils (used internally)
jest.unstable_mockModule('../../src/runbook/snapshot-utils.js', () => {
  const asTerminalSnapshot = jest.fn((snapshot: unknown) => {
    if (
      typeof snapshot === 'object' &&
      snapshot !== null &&
      'status' in snapshot &&
      'value' in snapshot &&
      typeof (snapshot as Record<string, unknown>).status === 'string'
    ) {
      return snapshot as { status: string; value: unknown };
    }
    return null;
  });
  return {
    isRunbookComplete: jest.fn(),
    isRunbookStopped: jest.fn(),
    asTerminalSnapshot,
    asTerminalSnapshotOrDefault: jest.fn((snapshot: unknown) => {
      return asTerminalSnapshot(snapshot) ?? { status: 'active', value: undefined };
    }),
  };
});

const { resolveForValue } = await import('../../src/runbook/source-resolver.js');
const { isRunbookComplete, isRunbookStopped } = await import('../../src/runbook/snapshot-utils.js');
const { ForIterationService } = await import('../../src/runbook/for-iteration-service.js');
const { createJsonArrayStream } = await import('../../src/runbook/types.js');

const mockedResolveForValue = resolveForValue as jest.MockedFunction<typeof resolveForValue>;
const mockedIsComplete = isRunbookComplete as jest.MockedFunction<typeof isRunbookComplete>;
const mockedIsStopped = isRunbookStopped as jest.MockedFunction<typeof isRunbookStopped>;

function makeState(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id: 'test-123',
    runbook: 'test.md',
    runbookPath: '/tmp/test.md',
    step: '1',
    stepName: 'Step 1',
    retryCount: 0,
    variables: {},
    steps: [],
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const steps: Step[] = [] as unknown as Step[];

const TEST_PROJECT_ROOT = '/tmp/test-root';

describe('ForIterationService', () => {
  let mockManager: any;
  let mockActorService: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockManager = {
      load: jest.fn(),
      updateForContext: jest.fn(),
    };

    mockActorService = {
      sendAndSync: jest.fn(),
    };
  });

  describe('prepareIteration', () => {
    it('throws when load returns null', async () => {
      mockManager.load.mockResolvedValue(null);

      const service = new ForIterationService(mockManager, mockActorService, TEST_PROJECT_ROOT);
      await expect(service.prepareIteration('missing-id', steps)).rejects.toThrow(
        'Runbook missing-id not found',
      );
    });

    it('returns no-resolution-needed when no forStack', async () => {
      const state = makeState();
      mockManager.load.mockResolvedValue(state);

      const service = new ForIterationService(mockManager, mockActorService, TEST_PROJECT_ROOT);
      const result = await service.prepareIteration('test-123', steps);

      expect(result.status).toBe('no-resolution-needed');
      expect(result.state).toBe(state);
    });

    it('returns no-resolution-needed for implicit loop', async () => {
      const fc: ForContext = {
        stepId: '1',
        iteration: 1,
        start: 1,
        end: 1,
        implicit: true,
        source: { kind: 'range' },
      };
      const state = makeState({ forStack: [fc] });
      mockManager.load.mockResolvedValue(state);

      const service = new ForIterationService(mockManager, mockActorService, TEST_PROJECT_ROOT);
      const result = await service.prepareIteration('test-123', steps);

      expect(result.status).toBe('no-resolution-needed');
    });

    it('returns no-resolution-needed for range source (short-circuit)', async () => {
      const fc: ForContext = {
        stepId: '1',
        iteration: 2,
        start: 1,
        end: 5,
        variable: 'i',
        implicit: false,
        source: { kind: 'range' },
      };
      const state = makeState({ forStack: [fc] });
      mockManager.load.mockResolvedValue(state);

      const service = new ForIterationService(mockManager, mockActorService, TEST_PROJECT_ROOT);
      const result = await service.prepareIteration('test-123', steps);

      expect(result.status).toBe('no-resolution-needed');
      // resolveForValue should NOT be called for range sources
      expect(mockedResolveForValue).not.toHaveBeenCalled();
    });

    it('returns no-resolution-needed when currentValue already populated', async () => {
      const fc: ForContext = {
        stepId: '1',
        iteration: 1,
        start: 1,
        end: 3,
        variable: 'item',
        implicit: false,
        source: { kind: 'array', items: ['a', 'b', 'c'] },
        currentValue: 'a',
      };
      const state = makeState({ forStack: [fc] });
      mockManager.load.mockResolvedValue(state);

      const service = new ForIterationService(mockManager, mockActorService, TEST_PROJECT_ROOT);
      const result = await service.prepareIteration('test-123', steps);

      expect(result.status).toBe('no-resolution-needed');
      expect(mockedResolveForValue).not.toHaveBeenCalled();
    });

    it('returns ready when array value resolved', async () => {
      const fc: ForContext = {
        stepId: '1',
        iteration: 2,
        start: 1,
        end: 3,
        variable: 'item',
        implicit: false,
        source: { kind: 'array', items: ['a', 'b', 'c'] },
      };
      const state = makeState({ forStack: [fc] });
      const updatedState = makeState({ forStack: [{ ...fc, currentValue: 'b' }] });

      mockManager.load.mockResolvedValue(state);
      mockedResolveForValue.mockResolvedValue({
        kind: 'resolved',
        context: { ...fc, currentValue: 'b' },
      });
      mockManager.updateForContext.mockResolvedValue(updatedState);

      const service = new ForIterationService(mockManager, mockActorService, TEST_PROJECT_ROOT);
      const result = await service.prepareIteration('test-123', steps);

      expect(result.status).toBe('ready');
      expect(result.state).toBe(updatedState);
      expect(mockManager.updateForContext).toHaveBeenCalled();
    });

    it('returns exhausted with terminal state when array depleted', async () => {
      const fc: ForContext = {
        stepId: '1',
        iteration: 4,
        start: 1,
        end: 10,
        variable: 'item',
        implicit: false,
        source: { kind: 'array', items: ['a', 'b', 'c'] },
      };
      const state = makeState({ forStack: [fc] });
      const exitState = makeState({ step: '2' });
      const mockActor = {
        send: jest.fn(),
        getPersistedSnapshot: jest.fn().mockReturnValue({
          status: 'done',
          value: 'COMPLETE',
        }),
      };

      mockManager.load.mockResolvedValue(state);
      mockedResolveForValue.mockResolvedValue({
        kind: 'exhausted',
        capped: { ...fc, end: 4 },
      });
      mockManager.updateForContext.mockResolvedValue(undefined);
      mockActorService.sendAndSync.mockResolvedValue({
        actor: mockActor,
        state: exitState,
        snapshot: { status: 'done', value: 'COMPLETE' },
      });
      mockedIsComplete.mockReturnValue(true);
      mockedIsStopped.mockReturnValue(false);

      const service = new ForIterationService(mockManager, mockActorService, TEST_PROJECT_ROOT);
      const result = await service.prepareIteration('test-123', steps);

      expect(result.status).toBe('exhausted');
      if (result.status === 'exhausted') {
        expect(result.terminal).toBe('complete');
      }
      expect(mockActorService.sendAndSync).toHaveBeenCalledWith('test-123', steps, {
        type: 'PASS',
      });
    });

    it('throws when actor creation fails and reload returns null', async () => {
      const fc: ForContext = {
        stepId: '1',
        iteration: 4,
        start: 1,
        end: 10,
        variable: 'item',
        implicit: false,
        source: { kind: 'array', items: ['a', 'b', 'c'] },
      };
      const state = makeState({ forStack: [fc] });

      mockManager.load
        .mockResolvedValueOnce(state) // initial load
        .mockResolvedValueOnce(null); // reload after cap
      mockedResolveForValue.mockResolvedValue({
        kind: 'exhausted',
        capped: { ...fc, end: 4 },
      });
      mockManager.updateForContext.mockResolvedValue(undefined);
      mockActorService.sendAndSync.mockResolvedValue(null);

      const service = new ForIterationService(mockManager, mockActorService, TEST_PROJECT_ROOT);
      await expect(service.prepareIteration('test-123', steps)).rejects.toThrow(
        'Runbook test-123 not found after capping',
      );
    });

    it('returns exhausted with stopped terminal when actor creation fails but state exists', async () => {
      const fc: ForContext = {
        stepId: '1',
        iteration: 4,
        start: 1,
        end: 10,
        variable: 'item',
        implicit: false,
        source: { kind: 'array', items: ['a', 'b', 'c'] },
      };
      const state = makeState({ forStack: [fc] });
      const cappedState = makeState({ forStack: [{ ...fc, end: 4 }] });

      mockManager.load
        .mockResolvedValueOnce(state) // initial load
        .mockResolvedValueOnce(cappedState); // reload after cap
      mockedResolveForValue.mockResolvedValue({
        kind: 'exhausted',
        capped: { ...fc, end: 4 },
      });
      mockManager.updateForContext.mockResolvedValue(undefined);
      mockActorService.sendAndSync.mockResolvedValue(null);

      const service = new ForIterationService(mockManager, mockActorService, TEST_PROJECT_ROOT);
      const result = await service.prepareIteration('test-123', steps);

      expect(result.status).toBe('exhausted');
      if (result.status === 'exhausted') {
        expect(result.state).toBe(cappedState);
        expect(result.terminal).toBe('stopped');
      }
    });

    it('propagates ForResolutionError with code policy-violation from resolveForValue', async () => {
      const fc: ForContext = {
        stepId: '1',
        iteration: 1,
        start: 1,
        end: undefined,
        variable: 'items',
        implicit: false,
        source: { kind: 'variable', name: 'items' },
      };
      const stream = createJsonArrayStream('/etc/passwd');
      const state = makeState({
        forStack: [fc],
        templateVars: {
          items: stream,
        },
      });

      mockManager.load.mockResolvedValue(state);
      mockedResolveForValue.mockRejectedValue(
        new RealForResolutionError(
          'JsonArrayStream path "/etc/passwd" escapes project root "/safe"',
          'policy-violation',
        ),
      );

      const service = new ForIterationService(mockManager, mockActorService, '/safe');

      await expect(service.prepareIteration('test-123', steps)).rejects.toMatchObject({
        name: 'ForResolutionError',
        code: 'policy-violation',
        message: expect.stringContaining('escapes project root'),
      });

      // Confirm the constructor's projectRoot was forwarded into resolveForValue.
      expect(mockedResolveForValue).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        '/safe',
      );
    });
  });
});
