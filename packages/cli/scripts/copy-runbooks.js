#!/usr/bin/env node
/**
 * Copy bundled runbooks from monorepo to dist directory.
 * Flattens the category structure for simpler resolution.
 * Detects filename collisions to prevent silent overwrites.
 */
import { cpSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const sourceDir = join(__dirname, '..', '..', '..', 'runbooks', 'patterns');
const destDir = join(__dirname, '..', 'dist', 'runbooks');

// Check if source directory exists
if (!existsSync(sourceDir)) {
  console.log('No source runbooks directory found, skipping copy.');
  process.exit(0);
}

// Ensure destination exists
mkdirSync(destDir, { recursive: true });

let count = 0;
const seen = new Map(); // Track source paths for collision detection

/**
 * Recursively find and copy all .runbook.md files
 */
function copyRunbooks(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      copyRunbooks(srcPath);
    } else if (entry.name.endsWith('.runbook.md')) {
      const destPath = join(destDir, entry.name);

      // Check for collision
      if (seen.has(entry.name)) {
        throw new Error(
          `Duplicate runbook filename "${entry.name}":\n` +
          `  - ${seen.get(entry.name)}\n` +
          `  - ${srcPath}`
        );
      }
      seen.set(entry.name, srcPath);

      cpSync(srcPath, destPath);
      count++;
    }
  }
}

copyRunbooks(sourceDir);
console.log(`Copied ${count} runbooks to ${destDir}`);
