// packages/claude-code-plugin/__tests__/session.properties.test.ts
import fc from 'fast-check';
import { Session } from '../src/session.js';
import { SessionStateSchema } from '../src/shared/index.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Recursively check if value contains -0 anywhere (JSON doesn't preserve -0)
function containsNegativeZero(value: unknown): boolean {
  if (Object.is(value, -0)) return true;
  if (Array.isArray(value)) return value.some(containsNegativeZero);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(containsNegativeZero);
  }
  return false;
}

describe('Session Property Tests', () => {
  // Shared variable for per-iteration testDir
  let testDir: string;

  // Generator for valid SessionState
  const sessionStateArb = fc.record({
    session_id: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !s.includes('\0')),
    started_at: fc
      .date({ min: new Date('2000-01-01'), max: new Date('2100-01-01') })
      .filter((d) => !isNaN(d.getTime()))
      .map((d) => d.toISOString()),
    active_command: fc.option(fc.string({ maxLength: 100 }), { nil: null }),
    active_skill: fc.option(fc.string({ maxLength: 100 }), { nil: null }),
    edited_files: fc.array(
      fc.string({ maxLength: 200 }).filter((s) => !s.includes('\0')),
      { maxLength: 50 }
    ),
    file_extensions: fc.array(
      fc.string({ minLength: 1, maxLength: 10 }).filter((s) => /^[a-zA-Z0-9]+$/.test(s)),
      { maxLength: 20 }
    ),
    metadata: fc.dictionary(
      fc
        .string({ minLength: 1, maxLength: 20 })
        .filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s !== '__proto__'),
      fc.jsonValue().filter((v) => !containsNegativeZero(v)) // Exclude -0 anywhere since JSON doesn't preserve it
    )
  });

  it('roundtrips session state through save/load', async () => {
    await fc.assert(
      fc
        .asyncProperty(sessionStateArb, async (state) => {
          const session = new Session(testDir);

          // Save each field
          await session.set('active_command', state.active_command);
          await session.set('active_skill', state.active_skill);
          await session.set('metadata', state.metadata);

          for (const file of state.edited_files) {
            await session.append('edited_files', file);
          }
          for (const ext of state.file_extensions) {
            await session.append('file_extensions', ext);
          }

          // Load and verify
          const loadedCommand = await session.get('active_command');
          const loadedSkill = await session.get('active_skill');
          const loadedFiles = await session.get('edited_files');
          const loadedExts = await session.get('file_extensions');
          const loadedMeta = await session.get('metadata');

          expect(loadedCommand).toEqual(state.active_command);
          expect(loadedSkill).toEqual(state.active_skill);
          // Files are deduplicated, so use Set comparison
          expect(new Set(loadedFiles)).toEqual(new Set(state.edited_files));
          expect(new Set(loadedExts)).toEqual(new Set(state.file_extensions));
          expect(loadedMeta).toEqual(state.metadata);
        })
        .beforeEach(async () => {
          testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-session-prop-'));
        })
        .afterEach(async () => {
          await fs.rm(testDir, { recursive: true, force: true });
        }),
      { numRuns: 50 }
    );
  });

  it('append is idempotent for duplicate values', async () => {
    await fc.assert(
      fc
        .asyncProperty(
          fc.string({ minLength: 1, maxLength: 100 }).filter((s) => !s.includes('\0')),
          async (value) => {
            const session = new Session(testDir);

            await session.append('edited_files', value);
            await session.append('edited_files', value);
            await session.append('edited_files', value);

            const files = await session.get('edited_files');
            expect(files).toHaveLength(1);
            expect(files[0]).toBe(value);
          }
        )
        .beforeEach(async () => {
          testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-session-prop-'));
        })
        .afterEach(async () => {
          await fs.rm(testDir, { recursive: true, force: true });
        }),
      { numRuns: 100 }
    );
  });

  it('schema validates all generated states', () => {
    fc.assert(
      fc.property(sessionStateArb, (state) => {
        const result = SessionStateSchema.safeParse(state);
        expect(result.success).toBe(true);
      }),
      { numRuns: 200 }
    );
  });

  it('schema applies defaults for partial states', () => {
    const partialStateArb = fc.record({
      active_command: fc.option(fc.string({ maxLength: 50 }), { nil: null })
    });

    fc.assert(
      fc.property(partialStateArb, (partial) => {
        const result = SessionStateSchema.safeParse(partial);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.edited_files).toEqual([]);
          expect(result.data.file_extensions).toEqual([]);
          expect(result.data.metadata).toEqual({});
          expect(typeof result.data.session_id).toBe('string');
          expect(typeof result.data.started_at).toBe('string');
        }
      }),
      { numRuns: 100 }
    );
  });
});
