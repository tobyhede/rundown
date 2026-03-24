import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as readline from 'node:readline';
import * as crypto from 'node:crypto';
import type { FileSnapshot } from './types.js';
import { logger } from '../logger.js';

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
  /**
   * Read the next non-empty line from the file.
   *
   * @returns Promise resolving to `{ value, done }`. When `done` is false,
   *   `value` contains the trimmed line content. When `done` is true, `value`
   *   is an empty string and should be ignored. Rejects on I/O errors (the
   *   provider auto-closes on error).
   */
  next(): Promise<{ value: string; done: boolean }>;

  /**
   * Release the underlying file descriptor and readline interface.
   *
   * Resources are auto-released when `next()` returns `done: true`, so
   * callers only need to call `close()` for early abandonment (e.g.,
   * stopping iteration before exhaustion). Idempotent; safe to call
   * multiple times or after EOF.
   */
  close(): void;
}

/**
 * Create a FileProvider for lazy line-by-line streaming.
 *
 * @param filePath - Absolute path to the data file
 * @param options - Optional resume configuration
 * @param options.skipLines - Number of non-empty lines to skip for resume
 * @returns A FileProvider that streams non-empty lines
 * @throws {Error} On I/O errors (ENOENT, EACCES) during file open or line skipping
 */
export async function createFileProvider(
  filePath: string,
  options?: { skipLines?: number },
): Promise<FileProvider> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  // Safety net: prevent unhandled error events after readline detaches its listener.
  // During normal operation, readline's own handler still fires and propagates errors
  // through the async iterator. This only matters for errors emitted after rl.close().
  stream.on('error', (err) => {
    void logger.debug('Post-close stream error in FileProvider', {
      path: filePath,
      error: String(err),
    });
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const iterator = rl[Symbol.asyncIterator]();

  try {
    // Skip lines for resume
    const skip = options?.skipLines ?? 0;
    let skipped = 0;
    while (skipped < skip) {
      const result = await iterator.next();
      if (result.done) break;
      // Count non-empty lines (matches next() behavior for both formats)
      const line = result.value.trim();
      if (line.length > 0) {
        skipped++;
      }
    }
  } catch (error) {
    // Clean up resources on skip failure to prevent fd leak
    rl.close();
    stream.destroy();
    throw error;
  }

  let closed = false;

  return {
    async next() {
      try {
        for (;;) {
          const result = await iterator.next();
          if (result.done) {
            if (!closed) {
              closed = true;
              rl.close();
              stream.destroy();
            }
            return { value: '', done: true };
          }
          const line = result.value.trim();
          // Skip empty lines
          if (line.length === 0) continue;
          return { value: line, done: false };
        }
      } catch (error) {
        if (!closed) {
          closed = true;
          rl.close();
          stream.destroy();
        }
        throw error;
      }
    },
    close() {
      if (closed) return;
      closed = true;
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
 * @throws {Error} If drift is detected (file changed since snapshot)
 * @throws {Error} I/O errors (ENOENT, EACCES) from stat or computeFingerprint
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

  if (snapshot.fingerprint) {
    const currentFingerprint = await computeFingerprint(filePath, stat.size);
    if (currentFingerprint !== snapshot.fingerprint) {
      throw new Error(`File drift detected: ${filePath} content changed (fingerprint mismatch)`);
    }
    // Fingerprint matches — first FINGERPRINT_BYTES are identical.
    // Changes beyond that window (with identical size) may go undetected.
    return;
  }

  if (stat.mtimeMs !== snapshot.mtimeMs) {
    throw new Error(`File drift detected: ${filePath} modification time changed`);
  }
}

/**
 * Compute SHA-256 fingerprint from first 64 KiB of file content.
 *
 * Metadata (size, mtimeMs) is compared separately in validateFileSnapshot.
 * The fingerprint is content-only to avoid mtime drift forcing false mismatches.
 *
 * @param filePath - Absolute path to the file
 * @param size - Total file size in bytes (fingerprint covers min of size and 64 KiB)
 * @returns SHA-256 hex digest of the file content prefix
 */
async function computeFingerprint(filePath: string, size: number): Promise<string> {
  const fd = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(FINGERPRINT_BYTES, size));
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);

    const hash = crypto.createHash('sha256');
    hash.update(bytesRead < buffer.length ? buffer.subarray(0, bytesRead) : buffer);
    return hash.digest('hex');
  } finally {
    await fd.close();
  }
}
