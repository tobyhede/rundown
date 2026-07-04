// __tests__/hook-refusal.test.ts
import { describe, it, expect } from '@jest/globals';
import { HOOK_REFUSAL_EXIT_CODE, refusalMessage } from '../src/hook-refusal.js';

describe('hook refusal (fail-closed CLI boundary, #470 defect 3)', () => {
  it('uses the blocking exit code 2 (exit 1 is non-blocking in the hook protocol)', () => {
    expect(HOOK_REFUSAL_EXIT_CODE).toBe(2);
  });

  it('empty_input names the missing payload and the fail-closed stance', () => {
    const msg = refusalMessage({ kind: 'empty_input' });
    expect(msg).toMatch(/empty hook payload/);
    expect(msg).toMatch(/fail-closed/);
  });

  it('invalid_payload carries the parse detail verbatim', () => {
    const msg = refusalMessage({ kind: 'invalid_payload', detail: 'Invalid input: expected cwd' });
    expect(msg).toContain('Invalid input: expected cwd');
    expect(msg).toMatch(/fail-closed/);
  });

  it('dispatch_failed carries the error detail and the rundown status remediation', () => {
    const msg = refusalMessage({ kind: 'dispatch_failed', detail: 'boom' });
    expect(msg).toContain('boom');
    expect(msg).toContain('rundown status');
  });
});
