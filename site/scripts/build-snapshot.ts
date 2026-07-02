/**
 * Build-time script to create a WebContainer snapshot with @rundown-org/cli pre-installed.
 * This eliminates the 5-15 second npm install at runtime.
 *
 * Uses local packages when @rundown-org/cli is not published to npm.
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

/**
 * Recursively walk a node_modules tree resolving symlinks in all `.bin` directories.
 * The WebContainer snapshot tool cannot serialize symlinks, so each symlink is
 * replaced with a copy of its target file.
 */
function resolveAllBinSymlinks(nodeModulesDir: string) {
  function walkAndResolve(dir: string) {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.name === '.bin' && entry.isDirectory()) {
        const binFiles = readdirSync(fullPath);
        for (const file of binFiles) {
          const filePath = join(fullPath, file);
          const stat = lstatSync(filePath);
          if (stat.isSymbolicLink()) {
            const target = readlinkSync(filePath);
            const resolvedTarget = resolve(fullPath, target);
            if (!existsSync(resolvedTarget)) {
              console.warn(`Skipping broken symlink: ${filePath} → ${resolvedTarget}`);
              continue;
            }
            unlinkSync(filePath);
            copyFileSync(resolvedTarget, filePath);
          }
        }
      } else if (entry.isDirectory() && entry.name !== '.bin') {
        walkAndResolve(fullPath);
      }
    }
  }
  walkAndResolve(nodeModulesDir);
}

async function buildSnapshot() {
  console.log('Creating WebContainer snapshot with @rundown-org/cli...');

  // 1. Create temp directory
  const tempDir = mkdtempSync(join(tmpdir(), 'rundown-env-'));
  console.log(`Working directory: ${tempDir}`);

  try {
    // 2. Try to use local packages first (for development)
    const useLocalPackages = !process.env.USE_NPM_PACKAGES;

    if (useLocalPackages) {
      console.log('Using local packages (set USE_NPM_PACKAGES=1 to use npm)...');

      // Skip install+build only when all required local build outputs are present
      // (e.g. CI with downloaded build artifacts). Checking only the CLI entry point
      // would let a partial/stale build slip through, since `npm pack` below packs
      // parser, core, and cli — all three need current dist/ outputs.
      const cliEntryPoint = join(projectRoot, 'packages/cli/dist/cli.js');
      const parserDistDir = join(projectRoot, 'packages/parser/dist');
      const coreDistDir = join(projectRoot, 'packages/core/dist');
      const hasAllDistOutputs =
        existsSync(cliEntryPoint) &&
        existsSync(parserDistDir) &&
        existsSync(coreDistDir);

      if (!hasAllDistOutputs) {
        // Install + build the monorepo dev workspace (needed when building from the
        // site directory). This is a dev-workspace operation, so it uses pnpm — the
        // repo's package manager. (The tarball pack + tempDir install below stay on
        // npm: that path simulates a consumer/WebContainer install.)
        console.log('Installing monorepo dependencies...');
        execSync('pnpm install', { cwd: projectRoot, stdio: 'inherit' });

        // Build packages first to ensure dist folders exist
        console.log('Building packages...');
        execSync('pnpm run build', { cwd: projectRoot, stdio: 'inherit' });
      } else {
        console.log('Skipping monorepo install/build — parser/core/cli dist outputs already present.');
      }

      // Verify critical files exist
      if (!existsSync(cliEntryPoint)) {
        throw new Error(`CLI entry point not found at ${cliEntryPoint}. Build may have failed.`);
      }
      console.log('✓ CLI entry point verified');

      // Pack local packages
      const packagesDir = join(projectRoot, 'packages');
      const tarballs: string[] = [];

      for (const pkg of ['parser', 'core', 'cli']) {
        const pkgDir = join(packagesDir, pkg);
        console.log(`Packing @rundown-org/${pkg}...`);
        // --ignore-scripts: core's prepack guard (scripts/assert-native.mjs)
        // requires the Linux rd-landlock binaries, which are never built in
        // the site path and are unusable inside WebContainer anyway (the
        // sandbox fails closed to "unavailable" without them). Publishing to
        // npm still runs the guard.
        const output = execSync('npm pack --json --ignore-scripts', {
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
          '@rundown-org/parser': `file:${tarballs[0]}`,
          '@rundown-org/core': `file:${tarballs[1]}`,
          '@rundown-org/cli': `file:${tarballs[2]}`,
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
          '@rundown-org/cli': 'latest',
        },
      };
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify(packageJson, null, 2)
      );

      console.log('Installing @rundown-org/cli from npm...');
      execSync('npm install', { cwd: tempDir, stdio: 'inherit' });
    }

    // 4. Resolve symlinks in all .bin directories (snapshot tool can't handle symlinks)
    const nodeModulesDir = join(tempDir, 'node_modules');
    if (existsSync(nodeModulesDir)) {
      console.log('Resolving symlinks in node_modules/.bin directories...');
      resolveAllBinSymlinks(nodeModulesDir);
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
