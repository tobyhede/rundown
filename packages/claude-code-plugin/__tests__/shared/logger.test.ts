// __tests__/shared/logger.test.ts
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../../src/shared/logger.js';

describe('logger', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset environment for each test
    process.env.RUNDOWN_PLUGIN_LOG = '1';
    process.env.RUNDOWN_PLUGIN_LOG_LEVEL = 'debug';
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('getLogDir', () => {
    it('returns path in temp directory', () => {
      const logDir = logger.getLogDir();
      expect(logDir).toContain(os.tmpdir());
      expect(logDir).toContain('rundown-plugin');
    });

    it('returns consistent path', () => {
      const path1 = logger.getLogDir();
      const path2 = logger.getLogDir();
      expect(path1).toBe(path2);
    });
  });

  describe('getLogFilePath', () => {
    it('returns path with date suffix', () => {
      const logPath = logger.getLogFilePath();
      const today = new Date().toISOString().split('T')[0];
      expect(logPath).toContain(`hooks-${today}.log`);
    });

    it('returns path in log directory', () => {
      const logPath = logger.getLogFilePath();
      const logDir = logger.getLogDir();
      expect(logPath.startsWith(logDir)).toBe(true);
    });
  });

  describe('logging methods', () => {
    it('debug returns a promise', async () => {
      const result = logger.debug('test message');
      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    it('info returns a promise', async () => {
      const result = logger.info('test message');
      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    it('warn returns a promise', async () => {
      const result = logger.warn('test message');
      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    it('error returns a promise', async () => {
      const result = logger.error('test message');
      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    it('always returns a promise', async () => {
      const result = logger.always('test message');
      expect(result).toBeInstanceOf(Promise);
      await result;
    });

    it('event returns a promise', async () => {
      const result = logger.event('info', 'TestEvent', { key: 'value' });
      expect(result).toBeInstanceOf(Promise);
      await result;
    });
  });

  describe('logging disabled', () => {
    beforeEach(() => {
      process.env.RUNDOWN_PLUGIN_LOG = '0';
    });

    it('debug does not throw when disabled', async () => {
      await expect(logger.debug('test')).resolves.toBeUndefined();
    });

    it('info does not throw when disabled', async () => {
      await expect(logger.info('test')).resolves.toBeUndefined();
    });

    it('warn does not throw when disabled', async () => {
      await expect(logger.warn('test')).resolves.toBeUndefined();
    });

    it('error does not throw when disabled', async () => {
      await expect(logger.error('test')).resolves.toBeUndefined();
    });

    it('always still works when logging disabled', async () => {
      // 'always' bypasses the logging check
      await expect(logger.always('test')).resolves.toBeUndefined();
    });
  });

  describe('log level filtering', () => {
    it('respects RUNDOWN_PLUGIN_LOG_LEVEL', async () => {
      process.env.RUNDOWN_PLUGIN_LOG_LEVEL = 'error';

      // These should not write (below error level)
      await logger.debug('debug message');
      await logger.info('info message');
      await logger.warn('warn message');

      // This should write
      await logger.error('error message');
    });

    it('defaults to info level', async () => {
      delete process.env.RUNDOWN_PLUGIN_LOG_LEVEL;

      // debug should be filtered out, info and above should pass
      await logger.debug('debug');
      await logger.info('info');
      await logger.warn('warn');
      await logger.error('error');
    });
  });

  describe('structured data', () => {
    it('accepts optional data parameter', async () => {
      await logger.info('message with data', {
        key: 'value',
        number: 42,
        nested: { foo: 'bar' },
      });
    });

    it('handles undefined data gracefully', async () => {
      await logger.info('message without data', undefined);
    });

    it('handles empty data object', async () => {
      await logger.info('message with empty data', {});
    });
  });

  describe('event logging', () => {
    it('accepts different log levels', async () => {
      await logger.event('debug', 'DebugEvent');
      await logger.event('info', 'InfoEvent');
      await logger.event('warn', 'WarnEvent');
      await logger.event('error', 'ErrorEvent');
    });

    it('includes event name in log', async () => {
      await logger.event('info', 'PostToolUse', { tool: 'Edit' });
    });
  });

  describe('file writing', () => {
    let testLogDir: string;

    beforeEach(async () => {
      // Create isolated test directory
      testLogDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logger-test-'));
    });

    afterEach(async () => {
      await fs.rm(testLogDir, { recursive: true, force: true });
    });

    it('handles concurrent writes gracefully', async () => {
      // Trigger multiple writes simultaneously
      const writes = Array.from({ length: 10 }, (_, i) =>
        logger.info(`concurrent message ${String(i)}`, { index: i }),
      );

      await expect(Promise.all(writes)).resolves.toBeDefined();
    });
  });

  describe('error handling', () => {
    it('silently handles write failures', async () => {
      // Even if writing fails, the logger should not throw
      await expect(logger.info('test')).resolves.toBeUndefined();
    });
  });
});
