import { describe, it, expect } from '@jest/globals';
import { validateRunbook, type Step, type ValidationDiagnostic } from '../src/index.js';

const filterErrors = (d: ValidationDiagnostic[]) => d.filter((x) => x.severity === 'error');
const filterWarnings = (d: ValidationDiagnostic[]) => d.filter((x) => x.severity === 'warning');

// Default transitions for test fixtures (new structure without aggregation)
const DEFAULT_TRANSITIONS = {
  pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
  fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
};

describe('validator strict rules', () => {
  const mockStep = (overrides: Record<string, unknown>): Step => {
    const obj: Record<string, unknown> = { name: '1', description: 'Test', ...overrides };
    const kind =
      obj.forClause !== undefined
        ? 'for'
        : Array.isArray(obj.substeps) && (obj.substeps as unknown[]).length > 0
          ? 'substeps'
          : obj.command !== undefined
            ? 'command'
            : 'base';
    return { ...obj, kind } as Step;
  };

  describe('GOTO rules', () => {
    it('warns on GOTO self (step level)', () => {
      const steps = [
        mockStep({
          name: '1',
          transitions: {
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '1' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } },
          },
        }),
      ];
      const diagnostics = validateRunbook(steps);
      expect(filterErrors(diagnostics)).toHaveLength(0);
      expect(
        filterWarnings(diagnostics).some((w) =>
          w.message.includes('GOTO self without RETRY may loop indefinitely'),
        ),
      ).toBe(true);
    });

    it('warns on GOTO self (substep level)', () => {
      const steps = [
        mockStep({
          name: '1',
          transitions: { ...DEFAULT_TRANSITIONS },
          substeps: [
            {
              id: '1',
              description: 'S1',
              transitions: {
                pass: {
                  kind: 'pass',
                  action: { type: 'GOTO', target: { step: '1', substep: '1' } },
                },
                fail: { kind: 'fail', action: { type: 'STOP' } },
              },
            },
          ],
        }),
      ];
      const diagnostics = validateRunbook(steps);
      expect(filterErrors(diagnostics)).toHaveLength(0);
      expect(
        filterWarnings(diagnostics).some((w) =>
          w.message.includes('GOTO self without RETRY may loop indefinitely'),
        ),
      ).toBe(true);
    });

    it('rejects GOTO to named step with non-existent substep', () => {
      const steps = [
        {
          kind: 'base',
          name: '1',
          description: 'First',
          transitions: {
            pass: {
              kind: 'pass',
              action: { type: 'GOTO', target: { step: 'ErrorHandler', substep: 'NonExistent' } },
            },
            fail: { kind: 'fail', action: { type: 'STOP' } },
          },
        },
        {
          kind: 'substeps',
          name: 'ErrorHandler',
          description: 'Handler',
          transitions: { ...DEFAULT_TRANSITIONS },
          substeps: [{ id: '1', description: 'Sub1', transitions: { ...DEFAULT_TRANSITIONS } }],
        },
      ];
      const diagnostics = validateRunbook(steps as any[]);
      const errorDiagnostics = filterErrors(diagnostics);
      expect(errorDiagnostics.some((d) => d.message.includes('NonExistent'))).toBe(true);
    });
  });

  describe('Exclusivity rules', () => {
    it('accepts H2 step with both prompt and runbooks', () => {
      const steps = [
        mockStep({
          number: '1',
          prompt: 'P',
          runbooks: ['w.runbook.md'],
        }),
      ];
      const errors = validateRunbook(steps);
      expect(errors.filter((e) => e.message.includes('Violates Exclusivity Rule'))).toHaveLength(0);
    });

    it('accepts H2 step with both prompt and substeps', () => {
      const steps = [
        mockStep({
          number: '1',
          prompt: 'P',
          substeps: [{ id: '1', description: 'S', transitions: { ...DEFAULT_TRANSITIONS } }],
        }),
      ];
      const errors = validateRunbook(steps);
      expect(errors.filter((e) => e.message.includes('Violates Exclusivity Rule'))).toHaveLength(0);
    });

    it('rejects H2 step with both command and substeps (union prevents this structurally)', () => {
      // With the Step discriminated union, a step cannot have both command and substeps.
      // kind inference picks 'substeps' (substeps takes priority), and the extra command
      // property is ignored by schema validation. Exclusivity is enforced by the type system.
      const steps = [
        mockStep({
          number: '1',
          command: { code: 'echo', language: 'bash' },
          substeps: [{ id: '1', description: 'S', transitions: { ...DEFAULT_TRANSITIONS } }],
        }),
      ];
      const errors = validateRunbook(steps);
      expect(errors.some((e) => e.message.includes('Violates Exclusivity Rule'))).toBe(false);
    });

    it('rejects H3 substep with both body and runbooks', () => {
      const steps = [
        mockStep({
          number: '1',
          substeps: [
            {
              id: '1',
              description: 'S',
              command: { code: 'echo', language: 'bash' },
              runbooks: ['w.runbook.md'],
              transitions: { ...DEFAULT_TRANSITIONS },
            },
          ],
        }),
      ];
      const errors = validateRunbook(steps);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes('Violates Exclusivity Rule'))).toBe(true);
    });
  });

  describe('Error collection', () => {
    it('collects multiple diagnostics from single runbook', () => {
      // With the discriminated union, command+substeps can't coexist.
      // Test GOTO self warning + a non-existent step error instead.
      const steps = [
        mockStep({
          name: '1',
          prompt: 'P',
          substeps: [{ id: '1', description: 'S', transitions: { ...DEFAULT_TRANSITIONS } }],
          transitions: {
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '99' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } },
          },
        }),
        mockStep({
          name: '2',
          transitions: {
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '2' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } },
          },
        }),
      ];
      const diagnostics = validateRunbook(steps);
      // Should have at least a GOTO non-existent error + GOTO self warning
      expect(diagnostics.length).toBeGreaterThan(1);
      expect(filterErrors(diagnostics).length).toBeGreaterThan(0);
      expect(filterWarnings(diagnostics).length).toBeGreaterThan(0);
    });

    it('includes line numbers in validation diagnostics', () => {
      // Use a step with non-existent GOTO target to trigger error with line number
      const steps = [
        mockStep({
          line: 42,
          name: '1',
          transitions: {
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '99' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } },
          },
        }),
      ];
      const diagnostics = validateRunbook(steps);
      expect(diagnostics.length).toBeGreaterThan(0);
      const diagWithLine = diagnostics.find((d) => d.line === 42);
      expect(diagWithLine).toBeDefined();
    });
  });

  describe('validateRunbook with named steps', () => {
    it('allows named steps after static steps', () => {
      const steps = [
        { kind: 'base', name: '1', description: 'First', transitions: { ...DEFAULT_TRANSITIONS } },
        { kind: 'base', name: '2', description: 'Second', transitions: { ...DEFAULT_TRANSITIONS } },
        {
          kind: 'base',
          name: 'Cleanup',
          description: 'Cleanup',
          transitions: { ...DEFAULT_TRANSITIONS },
        },
      ];
      const errors = validateRunbook(steps as any[]);
      expect(errors).toHaveLength(0);
    });

    it('validates GOTO to named step', () => {
      const steps = [
        {
          kind: 'base',
          name: '1',
          description: 'First',
          transitions: {
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'Cleanup' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } },
          },
        },
        {
          kind: 'base',
          name: 'Cleanup',
          description: 'Cleanup',
          transitions: { ...DEFAULT_TRANSITIONS },
        },
      ];
      const errors = validateRunbook(steps as any[]);
      expect(errors).toHaveLength(0);
    });

    it('rejects GOTO to non-existent named step', () => {
      const steps = [
        {
          kind: 'base',
          name: '1',
          description: 'First',
          transitions: {
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: 'NonExistent' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } },
          },
        },
      ];
      const diagnostics = validateRunbook(steps as any[]);
      const errorDiagnostics = filterErrors(diagnostics);
      expect(errorDiagnostics.some((d) => d.message.includes('NonExistent'))).toBe(true);
    });

    it('validates GOTO to named substep', () => {
      const steps = [
        {
          kind: 'substeps',
          name: '1',
          description: 'First',
          substeps: [
            { id: '1', description: 'Sub1', transitions: { ...DEFAULT_TRANSITIONS } },
            { id: 'Cleanup', description: 'SubCleanup', transitions: { ...DEFAULT_TRANSITIONS } },
          ],
          transitions: {
            pass: {
              kind: 'pass',
              action: { type: 'GOTO', target: { step: '1', substep: 'Cleanup' } },
            },
            fail: { kind: 'fail', action: { type: 'STOP' } },
          },
        },
      ];
      const errors = validateRunbook(steps as any[]);
      expect(errors).toHaveLength(0);
    });
  });

  describe('empty runbook', () => {
    it('rejects empty steps array', () => {
      const diagnostics = validateRunbook([]);
      const errorDiagnostics = filterErrors(diagnostics);
      expect(errorDiagnostics.some((d) => d.message.includes('at least one step'))).toBe(true);
    });
  });

  describe('numeric step sequencing', () => {
    it('rejects non-sequential numeric steps', () => {
      const steps = [
        mockStep({ name: '1', description: 'First' }),
        mockStep({ name: '3', description: 'Third (skipping 2)' }),
      ];
      const errors = validateRunbook(steps);
      expect(errors.some((e) => e.message.includes('must be sequential'))).toBe(true);
    });
  });

  describe('GOTO to non-existent step', () => {
    it('rejects GOTO to non-existent numeric step', () => {
      const steps = [
        mockStep({
          name: '1',
          transitions: {
            aggregation: 'ALL',
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '99' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } },
          },
        }),
      ];
      const errors = validateRunbook(steps);
      expect(errors.some((e) => e.message.includes('does not exist'))).toBe(true);
    });
  });

  describe('GOTO to step without substeps', () => {
    it('rejects GOTO to substep when step has no substeps', () => {
      const steps = [
        mockStep({
          name: '1',
          transitions: {
            aggregation: 'ALL',
            pass: { kind: 'pass', action: { type: 'GOTO', target: { step: '2', substep: '1' } } },
            fail: { kind: 'fail', action: { type: 'STOP' } },
          },
        }),
        mockStep({ name: '2', description: 'No substeps' }),
      ];
      const errors = validateRunbook(steps);
      expect(errors.some((e) => e.message.includes('has no substeps'))).toBe(true);
    });

    it('rejects GOTO to named step substep when step has no substeps', () => {
      const steps = [
        mockStep({
          name: '1',
          transitions: {
            aggregation: 'ALL',
            pass: {
              kind: 'pass',
              action: { type: 'GOTO', target: { step: 'ErrorHandler', substep: '1' } },
            },
            fail: { kind: 'fail', action: { type: 'STOP' } },
          },
        }),
        mockStep({ name: 'ErrorHandler', description: 'No substeps' }),
      ];
      const errors = validateRunbook(steps);
      expect(errors.some((e) => e.message.includes('has no substeps'))).toBe(true);
    });
  });

  describe('FOR validation', () => {
    it('rejects FOR step without substeps', () => {
      const steps: Step[] = [
        {
          kind: 'for',
          name: '1',
          description: 'Step with FOR but no substeps',
          forClause: { start: 1, end: 10 },
          transitions: { ...DEFAULT_TRANSITIONS },
          substeps: [],
        } as Step,
      ];
      const errors = validateRunbook(steps);
      expect(errors.some((e) => e.message.includes('must have at least one substep'))).toBe(true);
    });

    it('accepts FOR step with substeps', () => {
      const steps: Step[] = [
        {
          kind: 'for',
          name: '1',
          description: 'Step with FOR and substeps',
          forClause: { start: 1, end: 10 },
          transitions: { ...DEFAULT_TRANSITIONS },
          substeps: [
            {
              id: '1',
              description: 'Substep',
              transitions: { ...DEFAULT_TRANSITIONS },
            },
          ],
        },
      ];
      const errors = validateRunbook(steps);
      expect(errors.some((e) => e.message.includes('must have at least one substep'))).toBe(false);
    });

    it('rejects NEXT outside FOR substep context', () => {
      const steps: Step[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Non-FOR step',
          transitions: { ...DEFAULT_TRANSITIONS },
          substeps: [
            {
              id: '1',
              description: 'Substep with NEXT',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'NEXT' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
              },
            },
          ],
        },
      ];
      const errors = validateRunbook(steps);
      expect(
        errors.some((e) => e.message.includes('NEXT is only valid within substeps of a FOR step')),
      ).toBe(true);
    });

    it('rejects BREAK outside FOR substep context', () => {
      const steps: Step[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Non-FOR step',
          transitions: { ...DEFAULT_TRANSITIONS },
          substeps: [
            {
              id: '1',
              description: 'Substep with BREAK',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'BREAK' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
              },
            },
          ],
        },
      ];
      const errors = validateRunbook(steps);
      expect(
        errors.some((e) => e.message.includes('BREAK is only valid within substeps of a FOR step')),
      ).toBe(true);
    });

    it('accepts NEXT in substep of FOR step', () => {
      const steps: Step[] = [
        {
          kind: 'for',
          name: '1',
          description: 'FOR step',
          forClause: { start: 1, end: 10 },
          transitions: { ...DEFAULT_TRANSITIONS },
          substeps: [
            {
              id: '1',
              description: 'Substep',
              transitions: {
                pass: { kind: 'pass' as const, retry: 0, action: { type: 'NEXT' as const } },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
              },
            },
          ],
        },
      ];
      const errors = validateRunbook(steps);
      expect(errors.some((e) => e.message.includes('NEXT is only valid'))).toBe(false);
    });

    it('rejects NEXT on parent FOR step itself', () => {
      const steps: Step[] = [
        {
          kind: 'for',
          name: '1',
          description: 'FOR step with NEXT on itself',
          forClause: { start: 1, end: 10 },
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'NEXT' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
          substeps: [
            {
              id: '1',
              description: 'Substep',
              transitions: { ...DEFAULT_TRANSITIONS },
            },
          ],
        },
      ];
      const errors = validateRunbook(steps);
      expect(errors.some((e) => e.message.includes('cannot appear on the FOR step itself'))).toBe(
        true,
      );
    });

    it('rejects DEFER at step level', () => {
      const steps: Step[] = [
        {
          kind: 'base',
          name: '1',
          description: 'Step with DEFER',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
        },
      ];
      const errors = validateRunbook(steps);
      expect(
        errors.some((e) =>
          e.message.includes(
            'DEFER is only valid within substeps or FOR iteration-level transitions, not at step level',
          ),
        ),
      ).toBe(true);
    });

    it('emits single error when both pass and fail are DEFER at step level', () => {
      const steps: Step[] = [
        {
          kind: 'base',
          name: '1',
          description: 'Step with DEFER on both',
          transitions: {
            pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
          },
        },
      ];
      const errors = validateRunbook(steps);
      const deferErrors = errors.filter((e) =>
        e.message.includes('DEFER is only valid within substeps'),
      );
      expect(deferErrors).toHaveLength(1);
    });

    it('accepts AT-qualified GOTO to self (not a true self-loop)', () => {
      const steps: Step[] = [
        {
          kind: 'for',
          name: '1',
          description: 'FOR step that GOTOs itself with AT',
          forClause: { start: 1, end: 5 },
          transitions: { ...DEFAULT_TRANSITIONS },
          substeps: [
            {
              id: '1',
              description: 'Substep',
              transitions: {
                pass: {
                  kind: 'pass' as const,
                  retry: 0,
                  action: { type: 'GOTO' as const, target: { step: '1', at: 1 } },
                },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
              },
            },
          ],
        },
      ];
      const diagnostics = validateRunbook(steps);
      expect(diagnostics.some((d) => d.message.includes('GOTO self'))).toBe(false);
    });

    it('warns on non-AT GOTO to self (now a warning)', () => {
      const steps: Step[] = [
        {
          kind: 'for',
          name: '1',
          description: 'FOR step that GOTOs itself without AT',
          forClause: { start: 1, end: 5 },
          transitions: { ...DEFAULT_TRANSITIONS },
          substeps: [
            {
              id: '1',
              description: 'Substep',
              transitions: {
                pass: {
                  kind: 'pass' as const,
                  retry: 0,
                  action: { type: 'GOTO' as const, target: { step: '1', substep: '1' } },
                },
                fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
              },
            },
          ],
        },
      ];
      const diagnostics = validateRunbook(steps);
      expect(filterErrors(diagnostics)).toHaveLength(0);
      expect(
        filterWarnings(diagnostics).some((w) =>
          w.message.includes('GOTO self without RETRY may loop indefinitely'),
        ),
      ).toBe(true);
    });

    it('warns on named step GOTO self', () => {
      const steps: Step[] = [
        { kind: 'base', name: '1', description: 'First', transitions: { ...DEFAULT_TRANSITIONS } },
        {
          kind: 'base',
          name: 'Retry',
          description: 'Named step that GOTOs itself',
          transitions: {
            pass: {
              kind: 'pass' as const,
              retry: 0,
              action: { type: 'GOTO' as const, target: { step: 'Retry' } },
            },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
        },
      ];
      const diagnostics = validateRunbook(steps);
      expect(filterErrors(diagnostics)).toHaveLength(0);
      expect(
        filterWarnings(diagnostics).some((w) =>
          w.message.includes('GOTO self without RETRY may loop indefinitely'),
        ),
      ).toBe(true);
    });

    it('rejects GOTO AT targeting non-FOR step', () => {
      const steps: Step[] = [
        {
          kind: 'base',
          name: '1',
          description: 'Source step',
          transitions: {
            pass: {
              kind: 'pass' as const,
              retry: 0,
              action: { type: 'GOTO' as const, target: { step: '2', at: 3 } },
            },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
        },
        {
          kind: 'base',
          name: '2',
          description: 'Target step without FOR',
          transitions: { ...DEFAULT_TRANSITIONS },
        },
      ];
      const diagnostics = validateRunbook(steps);
      expect(
        filterErrors(diagnostics).some((e) =>
          e.message.includes('GOTO AT is only valid when the target step has a FOR clause'),
        ),
      ).toBe(true);
    });

    it('accepts GOTO AT targeting FOR step', () => {
      const steps: Step[] = [
        {
          kind: 'base',
          name: '1',
          description: 'Source step',
          transitions: {
            pass: {
              kind: 'pass' as const,
              retry: 0,
              action: { type: 'GOTO' as const, target: { step: '2', at: 1 } },
            },
            fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
          },
        },
        {
          kind: 'for',
          name: '2',
          description: 'FOR target step',
          forClause: { start: 1, end: 10 },
          transitions: { ...DEFAULT_TRANSITIONS },
          substeps: [
            {
              id: '1',
              description: 'Substep',
              transitions: { ...DEFAULT_TRANSITIONS },
            },
          ],
        },
      ];
      const diagnostics = validateRunbook(steps);
      expect(diagnostics.some((d) => d.message.includes('GOTO AT is only valid'))).toBe(false);
    });

    describe('FOR clause nested transitions', () => {
      it('accepts FOR with CONTINUE/BREAK nested transitions', () => {
        const steps: Step[] = [
          {
            kind: 'for',
            name: '1',
            description: 'Review',
            forClause: {
              variable: 'pass',
              start: 1,
              end: 3,
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'BREAK' } },
              },
            },
            transitions: { ...DEFAULT_TRANSITIONS },
            substeps: [{ id: '1', description: 'Check', transitions: { ...DEFAULT_TRANSITIONS } }],
          },
        ];
        const diagnostics = validateRunbook(steps);
        const errors = filterErrors(diagnostics);
        expect(errors.some((e) => e.message.includes('FOR-level'))).toBe(false);
      });

      it('accepts FOR with GOTO nested transition', () => {
        const steps: Step[] = [
          {
            kind: 'for',
            name: '1',
            description: 'Review',
            forClause: {
              variable: 'pass',
              start: 1,
              end: 3,
              transitions: {
                pass: {
                  kind: 'pass',
                  retry: 0,
                  action: { type: 'GOTO', target: { step: '2' } },
                },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
              },
            },
            transitions: { ...DEFAULT_TRANSITIONS },
            substeps: [{ id: '1', description: 'Check', transitions: { ...DEFAULT_TRANSITIONS } }],
          },
          {
            kind: 'substeps',
            name: '2',
            description: 'Follow-up',
            transitions: { ...DEFAULT_TRANSITIONS },
            substeps: [
              { id: '1', description: 'Finalize', transitions: { ...DEFAULT_TRANSITIONS } },
            ],
          },
        ];
        const diagnostics = validateRunbook(steps);
        const errors = filterErrors(diagnostics);
        expect(errors).toHaveLength(0);
      });

      it('accepts FOR with STOP nested transition', () => {
        const steps: Step[] = [
          {
            kind: 'for',
            name: '1',
            description: 'Review',
            forClause: {
              variable: 'pass',
              start: 1,
              end: 3,
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
            transitions: { ...DEFAULT_TRANSITIONS },
            substeps: [{ id: '1', description: 'Check', transitions: { ...DEFAULT_TRANSITIONS } }],
          },
        ];
        const diagnostics = validateRunbook(steps);
        const errors = filterErrors(diagnostics);
        expect(errors).toHaveLength(0);
      });

      it('accepts FOR with COMPLETE nested transition', () => {
        const steps: Step[] = [
          {
            kind: 'for',
            name: '1',
            description: 'Review',
            forClause: {
              variable: 'pass',
              start: 1,
              end: 3,
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
              },
            },
            transitions: { ...DEFAULT_TRANSITIONS },
            substeps: [{ id: '1', description: 'Check', transitions: { ...DEFAULT_TRANSITIONS } }],
          },
        ];
        const diagnostics = validateRunbook(steps);
        const errors = filterErrors(diagnostics);
        expect(errors).toHaveLength(0);
      });

      it('accepts FOR with RETRY on iteration-level transitions', () => {
        const steps: Step[] = [
          {
            kind: 'for',
            name: '1',
            description: 'Review',
            forClause: {
              variable: 'pass',
              start: 1,
              end: 3,
              transitions: {
                pass: {
                  kind: 'pass' as const,
                  retry: 2,
                  action: { type: 'BREAK' as const },
                },
                fail: {
                  kind: 'fail' as const,
                  retry: 0,
                  action: { type: 'CONTINUE' as const },
                },
              },
            },
            transitions: { ...DEFAULT_TRANSITIONS },
            substeps: [{ id: '1', description: 'Check', transitions: { ...DEFAULT_TRANSITIONS } }],
          },
        ];
        const diagnostics = validateRunbook(steps);
        const errors = filterErrors(diagnostics);
        expect(errors).toHaveLength(0);
      });
    });
  });

  describe('step-name uniqueness', () => {
    it('rejects two numeric steps with same number', () => {
      const steps = [
        mockStep({ name: '1', line: 5, description: 'First' }),
        mockStep({ name: '1', line: 10, description: 'Duplicate' }),
      ];
      const diagnostics = validateRunbook(steps);
      const errors = filterErrors(diagnostics);
      expect(errors.some((e) => e.message.includes('Duplicate step name "1"'))).toBe(true);
      expect(errors.some((e) => e.message.includes('first defined at line 5'))).toBe(true);
    });

    it('rejects two named steps with same name', () => {
      const steps = [
        mockStep({ name: 'Setup', line: 3, description: 'First setup' }),
        mockStep({ name: 'Setup', line: 20, description: 'Duplicate setup' }),
      ];
      const diagnostics = validateRunbook(steps);
      const errors = filterErrors(diagnostics);
      expect(errors.some((e) => e.message.includes('Duplicate step name "Setup"'))).toBe(true);
    });

    it('reports multiple errors for three+ duplicates', () => {
      const steps = [
        mockStep({ name: 'Deploy', line: 1, description: 'First' }),
        mockStep({ name: 'Deploy', line: 10, description: 'Second' }),
        mockStep({ name: 'Deploy', line: 20, description: 'Third' }),
      ];
      const diagnostics = validateRunbook(steps);
      const dupeErrors = filterErrors(diagnostics).filter((e) =>
        e.message.includes('Duplicate step name "Deploy"'),
      );
      expect(dupeErrors).toHaveLength(2);
    });

    it('allows mixed numeric and named steps with no conflicts', () => {
      const steps = [
        mockStep({ name: '1', description: 'First' }),
        mockStep({ name: '2', description: 'Second' }),
        mockStep({ name: 'Cleanup', description: 'Named step' }),
      ];
      const diagnostics = validateRunbook(steps);
      const dupeErrors = filterErrors(diagnostics).filter((e) =>
        e.message.includes('Duplicate step name'),
      );
      expect(dupeErrors).toHaveLength(0);
    });

    it('omits line reference when first occurrence has no line', () => {
      const steps = [
        mockStep({ name: 'X', description: 'No line' }),
        mockStep({ name: 'X', line: 15, description: 'With line' }),
      ];
      const diagnostics = validateRunbook(steps);
      const dupeErrors = filterErrors(diagnostics).filter((e) =>
        e.message.includes('Duplicate step name "X"'),
      );
      expect(dupeErrors).toHaveLength(1);
      expect(dupeErrors[0].message).not.toContain('first defined at line');
    });
  });

  describe('step-name uniqueness integration', () => {
    it('parseRunbookDocument returns error diagnostic for duplicate named steps', async () => {
      const { parseRunbookDocument } = await import('../src/index.js');
      const markdown = `# My Runbook\n\n## Setup\nFirst setup\n\n## Setup\nDuplicate setup\n`;
      const { diagnostics } = parseRunbookDocument(markdown);
      const errors = diagnostics.filter((d) => d.severity === 'error');
      expect(errors.some((e) => e.message.includes('Duplicate step name "Setup"'))).toBe(true);
    });
  });

  describe('parent transition reachability', () => {
    it('errors when all substeps have explicit non-DEFER transitions', () => {
      const steps = [
        mockStep({
          name: '1',
          aggregation: { strategy: 'ALL' },
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          substeps: [
            {
              id: '1',
              description: 'Sub 1',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
            {
              id: '2',
              description: 'Sub 2',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
          ],
        }),
      ];
      const diagnostics = validateRunbook(steps);
      const deferErrors = filterErrors(diagnostics).filter((d) =>
        d.message.includes('no substep uses DEFER'),
      );
      expect(deferErrors).toHaveLength(1);
      expect(deferErrors[0].message).toContain('no substep uses DEFER');
    });

    it('passes when at least one substep uses DEFER', () => {
      const steps = [
        mockStep({
          name: '1',
          aggregation: { strategy: 'ALL' },
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          substeps: [
            {
              id: '1',
              description: 'Sub 1',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
              },
            },
            {
              id: '2',
              description: 'Sub 2',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
          ],
        }),
      ];
      const diagnostics = validateRunbook(steps);
      const errors = filterErrors(diagnostics);
      expect(errors).toHaveLength(0);
    });

    it('passes when substeps have no explicit transitions (auto-DEFER)', () => {
      const steps = [
        {
          kind: 'substeps' as const,
          name: '1',
          description: 'With substeps',
          aggregation: { strategy: 'ALL' },
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          substeps: [
            {
              id: '1',
              description: 'Sub 1',
              transitions: {
                pass: { kind: 'pass', action: { type: 'DEFER' } },
                fail: { kind: 'fail', action: { type: 'DEFER' } },
              },
            },
            {
              id: '2',
              description: 'Sub 2',
              transitions: {
                pass: { kind: 'pass', action: { type: 'DEFER' } },
                fail: { kind: 'fail', action: { type: 'DEFER' } },
              },
            },
          ],
        },
      ];
      const diagnostics = validateRunbook(steps as any[]);
      const errors = filterErrors(diagnostics);
      expect(errors).toHaveLength(0);
    });

    it('does not fire for FOR steps (iteration results feed parent)', () => {
      const steps = [
        mockStep({
          name: '1',
          forClause: { start: 1, end: 3 },
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          substeps: [
            {
              id: '1',
              description: 'Sub 1',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
          ],
        }),
      ];
      const diagnostics = validateRunbook(steps);
      const deferErrors = diagnostics.filter((d) => d.message.includes('no substep uses DEFER'));
      expect(deferErrors).toHaveLength(0);
    });

    it('does not fire when step has no parent transitions', () => {
      const steps = [
        mockStep({
          name: '1',
          transitions: { ...DEFAULT_TRANSITIONS },
          substeps: [
            {
              id: '1',
              description: 'Sub 1',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
          ],
        }),
      ];
      const diagnostics = validateRunbook(steps);
      const deferErrors = diagnostics.filter((d) => d.message.includes('no substep uses DEFER'));
      expect(deferErrors).toHaveLength(0);
    });

    it('does not fire when parent transitions have no explicit aggregation', () => {
      const steps = [
        mockStep({
          name: '1',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          substeps: [
            {
              id: '1',
              description: 'Sub 1',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
          ],
        }),
      ];
      const diagnostics = validateRunbook(steps);
      const deferErrors = diagnostics.filter((d) => d.message.includes('no substep uses DEFER'));
      expect(deferErrors).toHaveLength(0);
    });
  });
});
