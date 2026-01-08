import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseWorkflow } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '../fixtures/conformance');

describe('Rundown Conformance (Fixture Driven)', () => {
  describe('Valid Workflows', () => {
    const validDir = path.join(FIXTURES_DIR, 'valid');
    const files = fs.readdirSync(validDir).filter(f => f.endsWith('.runbook.md'));

    it.each(files)('should parse valid workflow: %s', (file) => {
      const content = fs.readFileSync(path.join(validDir, file), 'utf8');
      expect(() => parseWorkflow(content)).not.toThrow();
    });
  });

  describe('Invalid Workflows', () => {
    const invalidDir = path.join(FIXTURES_DIR, 'invalid');
    const files = fs.readdirSync(invalidDir).filter(f => f.endsWith('.runbook.md'));

    it.each(files)('should reject invalid workflow: %s', (file) => {
      const content = fs.readFileSync(path.join(invalidDir, file), 'utf8');
      expect(() => parseWorkflow(content)).toThrow();
    });
  });
});