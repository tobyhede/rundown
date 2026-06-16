// packages/claude-code-plugin/__tests__/__mocks__/workflow/hooks/task-tracker.ts
import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

/**
 * Mock task-dispatch hook used by workflow hook tests.
 *
 * The explicit `Mock` annotation is required because pnpm's isolated layout makes
 * the inferred `jest.fn()` type (`Mock<UnknownFunction>` from jest-mock) not
 * portably nameable (TS2883); naming it via the direct jest-mock import keeps the
 * exported type resolvable.
 */
export const trackTaskDispatch: Mock = jest.fn();
