

















































































































































































































































































































































































































































































      expect(normalizeOutputPath(result.stdout)).toMatch(/^\.work\/\d{4}-\d{2}-\d{2}-plan\.json$/);
      expect(result.stderr).not.toContain('Invalid id');
    });

    it('soft-fails legacy session ownership format when RD_WORK_PATH is set', async () => {
      // 'Legacy session ownership format detected' is thrown when session.json
      // contains 'ownedRunbooks', 'stashedRunbookOwnership', or 'stacks' fields.
      // This is a new recoverable-error message added to isRecoverableActiveStateLookupError
      // in this PR. The path should assemble without a context segment and exit 0.
      await fs.mkdir(path.join(testDir, '.rundown'), { recursive: true });
      await fs.writeFile(
        path.join(testDir, '.rundown', 'session.json'),
        JSON.stringify(
          { ownedRunbooks: { 'wf-old-run': { runbookPath: 'foo.md' } } },
          null,
          2,
        ),
      );

      const result = await runRdpath(
        ['--file', 'plan.json'],
        {
          RD_WORK_PATH: '.work',
          RD_CONTEXT_ID: undefined,
        },
        testDir,
      );

      expect(result.exitCode).toBe(0);
      expect(normalizeOutputPath(result.stdout)).toMatch(/^\.work\/\d{4}-\d{2}-\d{2}-plan\.json$/);
      expect(result.stderr).toBe('');
    });

    it('soft-fails session.json with invalid Zod-schema data when RD_WORK_PATH is set', async () => {
      // 'Session file contains invalid' is thrown when session.json parses as
      // JSON but fails SessionDataSchema validation. The truncated match
      // (previously 'Session file contains invalid entries') now also covers
      // the full message 'Session file contains invalid runbook targeting data'.
      await fs.mkdir(path.join(testDir, '.rundown'), { recursive: true });
      await fs.writeFile(
        path.join(testDir, '.rundown', 'session.json'),
        JSON.stringify({ defaultStack: [{ not: 'a-string' }] }, null, 2),
      );

      const result = await runRdpath(
        ['--file', 'plan.json'],
        {
          RD_WORK_PATH: '.work',
          RD_CONTEXT_ID: undefined,
        },
        testDir,
      );

      expect(result.exitCode).toBe(0);
      expect(normalizeOutputPath(result.stdout)).toMatch(/^\.work\/\d{4}-\d{2}-\d{2}-plan\.json$/);
      expect(result.stderr).toBe('');
    });

    it('soft-fails legacy stacks session format when RD_WORK_PATH is set', async () => {
      // Tests a second variant of the legacy ownership format ('stacks' field)
      // to verify the broader legacy detection in isRecoverableActiveStateLookupError.
      await fs.mkdir(path.join(testDir, '.rundown'), { recursive: true });
      await fs.writeFile(
        path.join(testDir, '.rundown', 'session.json'),
        JSON.stringify({ stacks: { default: [] } }, null, 2),
      );

      const result = await runRdpath(
        ['--file', 'plan.json'],
        {
          RD_WORK_PATH: '.work',
          RD_CONTEXT_ID: undefined,
        },
        testDir,
      );

      expect(result.exitCode).toBe(0);
      expect(normalizeOutputPath(result.stdout)).toMatch(/^\.work\/\d{4}-\d{2}-\d{2}-plan\.json$/);
      expect(result.stderr).toBe('');
    });
  });
});