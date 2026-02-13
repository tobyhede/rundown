import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as readline from 'node:readline';
import * as crypto from 'node:crypto';
import type { FileFormat, FileSnapshot } from './types.js';

/** Maximum bytes to read for fingerprint computation */
const FINGERPRINT_BYTES = 64 * 1024;

/**
 * Sequential line provider for file-backed data sources.
 *
 * Purpose-built for forward-only streaming. Not a generic iterator.
 * On resume, a new provider is constructed from a FileSnapshot
 * (open file, validate drift, skip to line).
 */
export interface FileProvider {
  next(): Promise<{ value: string; done: boolean }>;
  close(): void;
}

/**
 * Create a FileProvider for lazy line-by-line streaming.
 *
 * @param filePath - Absolute path to the data file
 * @param format - File format (text or jsonl)
 * @param options - Optional: skipLines to resume from a position
 * @returns A FileProvider that streams non-empty lines
 */
export async function createFileProvider(
  filePath: string,
  format: FileFormat,
  options?: { skipLines?: number },
): Promise<FileProvider> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const iterator = rl[Symbol.asyncIterator]();

  try {
    // Skip lines for resume
    const skip = options?.skipLines ?? 0;
    let skipped = 0;
    while (skipped < skip) {
      const result = await iterator.next();
      if (result.done) break;
      // Count non-empty lines for text, all lines for jsonl
      const line = result.value.trim();
      if (format === 'jsonl' || line.length > 0) {
        skipped++;
      }
    }
  } catch (error) {
    // Clean up resources on skip failure to prevent fd leak
    rl.close();
    stream.destroy();
    throw error;
  }

  return {
    async next() {
      try {
        for (;;) {
          const result = await iterator.next();
          if (result.done) return { value: '', done: true };
          const line = result.value.trim();
          // Skip empty lines for text format; jsonl keeps all non-empty
          if (line.length === 0) continue;
          return { value: line, done: false };
        }
      } catch (error) {
        rl.close();
        stream.destroy();
        throw error;
      }
    },
    close() {
      rl.close();
      stream.destroy();
    },
  };
}

/**
 * Compute a FileSnapshot for drift detection and resume.
 *
 * @param filePath - Absolute path to the file
 * @param line - Next line to read (1-based)
 * @returns FileSnapshot with size, mtime, and fingerprint
 */
export async function computeFileSnapshot(filePath: string, line: number): Promise<FileSnapshot> {
  const stat = await fsp.stat(filePath);
  const fingerprint = await computeFingerprint(filePath, stat.size);

  return {
    line,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    fingerprint,
  };
}

/**
 * Validate a persisted FileSnapshot against current file state.
 *
 * @param filePath - Absolute path to the file
 * @param snapshot - Persisted snapshot to validate
 * @throws Error if drift is detected (file changed since snapshot)
 */
export async function validateFileSnapshot(
  filePath: string,
  snapshot: FileSnapshot,
): Promise<void> {
  const stat = await fsp.stat(filePath);

  if (stat.size !== snapshot.size) {
    throw new Error(
      `File drift detected: ${filePath} size changed (expected ${String(snapshot.size)}, got ${String(stat.size)})`,
    );
  }

  if (stat.mtimeMs !== snapshot.mtimeMs) {
    // mtime changed but size same — check fingerprint if available
    if (snapshot.fingerprint) {
      const currentFingerprint = await computeFingerprint(filePath, stat.size);
      if (currentFingerprint !== snapshot.fingerprint) {
        throw new Error(`File drift detected: ${filePath} content changed (fingerprint mismatch)`);
      }
      // Fingerprint matches despite mtime change — likely a touch or backup, allow resume
      return;
    }
    throw new Error(`File drift detected: ${filePath} modification time changed`);
  }
}

/**
 * Compute SHA-256 fingerprint from first 64 KiB of file content.
 *
 * Metadata (size, mtimeMs) is compared separately in validateFileSnapshot.
 * The fingerprint is content-only to avoid mtime drift forcing false mismatches.
 */
async function computeFingerprint(filePath: string, size: number): Promise<string> {
  const fd = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(FINGERPRINT_BYTES, size));
    await fd.read(buffer, 0, buffer.length, 0);

    const hash = crypto.createHash('sha256');
    hash.update(buffer);
    return hash.digest('hex');
  } finally {
    await fd.close();
  }
}
