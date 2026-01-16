import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseRunbook } from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Point to the root runbooks/patterns directory
const FIXTURES_DIR = path.join(__dirname, '../fixtures/conformance');
// Point to the root runbooks/patterns directory relative to fixtures
const PATTERNS_DIR = path.resolve(FIXTURES_DIR, '../../../../runbooks/patterns');

function getFilesRecursively(dir: string): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir);
  
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      results = results.concat(getFilesRecursively(filePath));
    } else if (file.endsWith('.runbook.md')) {
      results.push(filePath);
    }
  }
  return results;
}

describe('Rundown Conformance (Fixture Driven)', () => {
  describe('Valid Runbooks (Patterns)', () => {
    // recursively find all runbook patterns
    const files = getFilesRecursively(PATTERNS_DIR);

    it.each(files)('should parse valid runbook: %s', (filePath) => {
      const content = fs.readFileSync(filePath, 'utf8');
      expect(() => parseRunbook(content)).not.toThrow();
    });
  });

  describe('Invalid Runbooks', () => {
    const invalidDir = path.join(FIXTURES_DIR, 'invalid');
    const files = fs.readdirSync(invalidDir).filter(f => f.endsWith('.runbook.md'));

    it.each(files)('should reject invalid runbook: %s', (file) => {
      const content = fs.readFileSync(path.join(invalidDir, file), 'utf8');
      expect(() => parseRunbook(content)).toThrow();
    });
  });
});