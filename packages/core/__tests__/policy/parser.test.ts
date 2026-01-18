import {
  extractCommands,
  extractPrimaryExecutable,
  extractAllExecutables,
} from '../../src/policy/parser.js';

describe('Command Parser', () => {
  describe('extractCommands', () => {
    it('should extract simple command', () => {
      const result = extractCommands('git status');

      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('git');
      expect(result[0].original).toBe('git status');
    });

    it('should extract command with arguments', () => {
      const result = extractCommands('npm install --save-dev typescript');

      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('npm');
    });

    it('should extract command with absolute path', () => {
      const result = extractCommands('/usr/bin/git status');

      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('git');
    });

    it('should extract commands from pipeline', () => {
      const result = extractCommands('cat file.txt | grep pattern');

      expect(result).toHaveLength(2);
      expect(result[0].executable).toBe('cat');
      expect(result[1].executable).toBe('grep');
    });

    it('should extract commands from logical AND', () => {
      const result = extractCommands('npm test && npm run build');

      expect(result).toHaveLength(2);
      expect(result[0].executable).toBe('npm');
      expect(result[1].executable).toBe('npm');
    });

    it('should extract commands from logical OR', () => {
      const result = extractCommands('command1 || command2');

      expect(result).toHaveLength(2);
      expect(result[0].executable).toBe('command1');
      expect(result[1].executable).toBe('command2');
    });

    it('should handle sh -c wrapper', () => {
      const result = extractCommands('sh -c "npm test"');

      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('npm');
    });

    it('should handle bash -c wrapper', () => {
      const result = extractCommands('bash -c "git commit -m message"');

      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('git');
    });

    it('should handle nested commands in sh -c', () => {
      const result = extractCommands('sh -c "npm test && npm run build"');

      expect(result).toHaveLength(2);
      expect(result[0].executable).toBe('npm');
      expect(result[1].executable).toBe('npm');
    });

    it('should handle command with quoted arguments', () => {
      const result = extractCommands('git commit -m "fix: bug fix"');

      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('git');
    });

    it('should skip environment variable assignment and extract actual executable', () => {
      const result = extractCommands('NODE_ENV=production node app.js');

      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('node');
      expect(result[0].original).toBe('NODE_ENV=production node app.js');
    });

    it('should skip multiple environment variable assignments', () => {
      const result = extractCommands('NODE_ENV=production DEBUG=1 npm test');

      expect(result).toHaveLength(1);
      expect(result[0].executable).toBe('npm');
    });

    it('should handle only env assignments (no executable)', () => {
      const result = extractCommands('FOO=bar');

      // No executable, just env assignment
      expect(result).toHaveLength(0);
    });

    it('should return empty for empty command', () => {
      const result = extractCommands('');

      expect(result).toHaveLength(0);
    });

    it('should handle semicolon-separated commands', () => {
      const result = extractCommands('command1; command2');

      expect(result).toHaveLength(2);
    });
  });

  describe('extractPrimaryExecutable', () => {
    it('should return primary executable for simple command', () => {
      const result = extractPrimaryExecutable('git status');

      expect(result).toBe('git');
    });

    it('should return first executable for pipeline', () => {
      const result = extractPrimaryExecutable('cat file | grep pattern');

      expect(result).toBe('cat');
    });

    it('should return nested command for sh -c', () => {
      const result = extractPrimaryExecutable('sh -c "npm test"');

      expect(result).toBe('npm');
    });

    it('should return null for empty command', () => {
      const result = extractPrimaryExecutable('');

      expect(result).toBeNull();
    });
  });

  describe('extractAllExecutables', () => {
    it('should return unique executables', () => {
      const result = extractAllExecutables('npm test && npm run build');

      expect(result).toEqual(['npm']);
    });

    it('should return all different executables', () => {
      const result = extractAllExecutables('git fetch && npm install');

      expect(result).toContain('git');
      expect(result).toContain('npm');
      expect(result).toHaveLength(2);
    });

    it('should return empty array for empty command', () => {
      const result = extractAllExecutables('');

      expect(result).toEqual([]);
    });
  });
});
