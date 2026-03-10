import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { promises as fs } from 'node:fs';
import path from 'node:path';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Recursively get all files in a directory.
 *
 * @param dir - Absolute path to the directory to scan
 * @returns Array of absolute file paths found recursively
 */
export async function getFilesRecursively(dir: string): Promise<string[]> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(dirents.map((dirent) => {
    const res = path.join(dir, dirent.name);
    return dirent.isDirectory() ? getFilesRecursively(res) : Promise.resolve([res]);
  }));
  return files.flat();
}
