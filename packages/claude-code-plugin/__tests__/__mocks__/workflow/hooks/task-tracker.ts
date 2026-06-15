// packages/claude-code-plugin/__tests__/__mocks__/workflow/hooks/task-tracker.ts
import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

// Explicit annotation: pnpm's isolated layout means the inferred `jest.fn()` type
// (Mock<UnknownFunction> from jest-mock) is not portably nameable (TS2883). Naming
// it via the direct jest-mock import keeps the exported type resolvable.
export const trackTaskDispatch: Mock = jest.fn();
