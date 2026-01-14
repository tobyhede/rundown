/**
 * Build-time script to create a WebContainer snapshot with @rundown/cli pre-installed.
 * This eliminates the 5-15 second npm install at runtime.
 *
 * Uses local packages when @rundown/cli is not published to npm.
 */
import { snapshot } from '@webcontainer/snapshot';
import { execSync } from 'child_process';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  cpSync,
  rmSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  unlinkSync,
  copyFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');

async function buildSnapshot() {
  console.log('Creating WebContainer snapshot with @rundown/cli...');

  // 1. Create temp directory
  const tempDir = mkdtempSync(join(tmpdir(), 'rundown-env-'));
  console.log(`Working directory: ${tempDir}`);

  try {
    // 2. Try to use local packages first (for development)
    const useLocalPackages = !process.env.USE_NPM_PACKAGES;

    if (useLocalPackages) {
      console.log('Using local packages (set USE_NPM_PACKAGES=1 to use npm)...');

      // Pack local packages
      const packagesDir = join(projectRoot, 'packages');
      const tarballs: string[] = [];

      for (const pkg of ['parser', 'core', 'cli']) {
        const pkgDir = join(packagesDir, pkg);
        console.log(`Packing @rundown/${pkg}...`);
        const output = execSync('npm pack --json', {
          cwd: pkgDir,
          encoding: 'utf-8',
        });
        const [info] = JSON.parse(output);
        const tarball = join(pkgDir, info.filename);
        tarballs.push(tarball);
      }

      // Write package.json referencing local tarballs
      const packageJson = {
        name: 'rundown-demo',
        type: 'module',
        dependencies: {
          '@rundown/parser': `file:${tarballs[0]}`,
          '@rundown/core': `file:${tarballs[1]}`,
          '@rundown/cli': `file:${tarballs[2]}`,
        },
      };
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      // Install from tarballs
      console.log('Installing from local tarballs...');
      execSync('npm install', { cwd: tempDir, stdio: 'inherit' });

      // Clean up tarballs
      for (const tarball of tarballs) {
        rmSync(tarball, { force: true });
      }
    } else {
      // Use npm packages
      const packageJson = {
        name: 'rundown-demo',
        type: 'module',
        dependencies: {
          '@rundown/cli': 'latest',
        },
      };
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      console.log('Installing @rundown/cli from npm...');
      execSync('npm install', { cwd: tempDir, stdio: 'inherit' });
    }

    // 4. Resolve symlinks in .bin directory (snapshot tool can't handle symlinks)
    const binDir = join(tempDir, 'node_modules', '.bin');
    if (existsSync(binDir)) {
      console.log('Resolving symlinks in node_modules/.bin...');
      const files = readdirSync(binDir);
      for (const file of files) {
        const filePath = join(binDir, file);
        const stat = lstatSync(filePath);
        if (stat.isSymbolicLink()) {
          const target = readlinkSync(filePath);
          const resolvedTarget = resolve(binDir, target);
          unlinkSync(filePath);
          copyFileSync(resolvedTarget, filePath);
        }
      }
    }

    // 5. Create binary snapshot (includes node_modules!)
    console.log('Creating binary snapshot...');
    const binarySnapshot = await snapshot(tempDir);

    // 5. Write to public directory
    const outputPath = join(__dirname, '..', 'public', 'rundown-snapshot.bin');
    const outputDir = dirname(outputPath);
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
    writeFileSync(outputPath, Buffer.from(binarySnapshot));

    const sizeMB = (binarySnapshot.byteLength / (1024 * 1024)).toFixed(2);
    console.log(`✓ Snapshot created: public/rundown-snapshot.bin (${sizeMB} MB)`);
  } finally {
    // Clean up temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

buildSnapshot().catch((err) => {
  console.error('Failed to create snapshot:', err);
  process.exit(1);
});
