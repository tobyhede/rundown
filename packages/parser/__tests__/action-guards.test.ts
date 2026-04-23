import { describe, it, expect } from '@jest/globals';
import {
  isAccumulatingAction,
  isBreakAction,
  isLoopControlAction,
  isStepExitAction,
  isTerminalAction,
} from '../src/helpers.js';
import type { Action } from '../src/schemas.js';

const allActions: Action[] = [
  { type: 'CONTINUE' },
  { type: 'DEFER' },
  { type: 'NEXT' },
  { type: 'BREAK' },
  { type: 'STOP' },
  { type: 'COMPLETE' },
  { type: 'GOTO', target: { step: '2' } },
];

function typesMatching(guard: (a: Action) => boolean): string[] {
  return allActions.filter(guard).map((a) => a.type);
}

describe('action type guards', () => {
  describe('isAccumulatingAction', () => {
    it('matches DEFER only', () => {
      expect(typesMatching(isAccumulatingAction)).toEqual(['DEFER']);
    });
  });

  describe('isLoopControlAction', () => {
    it('matches NEXT and BREAK', () => {
      expect(typesMatching(isLoopControlAction)).toEqual(['NEXT', 'BREAK']);
    });
  });

  describe('isStepExitAction', () => {
    it('matches CONTINUE only', () => {
      expect(typesMatching(isStepExitAction)).toEqual(['CONTINUE']);
    });
  });

  describe('isTerminalAction', () => {
    it('matches STOP, COMPLETE, and GOTO', () => {
      expect(typesMatching(isTerminalAction)).toEqual(['STOP', 'COMPLETE', 'GOTO']);
    });
  });

  describe('isBreakAction', () => {
    it('matches BREAK only', () => {
      expect(typesMatching(isBreakAction)).toEqual(['BREAK']);
    });
  });

  describe('exhaustiveness', () => {
    it('every action type is covered by exactly one category', () => {
      const guards = [
        isAccumulatingAction,
        isLoopControlAction,
        isStepExitAction,
        isTerminalAction,
      ];
      for (const action of allActions) {
        const matchCount = guards.filter((g) => g(action)).length;
        expect({ type: action.type, matchCount }).toEqual({ type: action.type, matchCount: 1 });
      }
    });
  });
});
