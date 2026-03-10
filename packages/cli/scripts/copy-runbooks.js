#!/usr/bin/env node
/**
 * Copy bundled runbooks from monorepo to dist directory.
 * Preserves the category directory structure for path-based resolution.
 * Detects filename collisions to prevent silent overwrites.
 */
import { cpSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const sourceDir = join(__dirname, '..', '..', '..', 'runbooks');
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
      const relPath = srcPath.slice(sourceDir.length + 1);
      const destPath = join(destDir, relPath);

      // Check for collision
      if (seen.has(relPath)) {
        throw new Error(
          `Duplicate runbook path "${relPath}":\n` +
            `  - ${seen.get(relPath)}\n` +
            `  - ${srcPath}`,
        );
      }
      seen.set(relPath, srcPath);

      mkdirSync(dirname(destPath), { recursive: true });
      cpSync(srcPath, destPath);
      count++;
    }
  }
}

copyRunbooks(sourceDir);
console.log(`Copied ${count} runbooks to ${destDir}`);
