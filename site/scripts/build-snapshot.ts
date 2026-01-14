/**
 * Build-time script to create a WebContainer snapshot with @rundown/cli pre-installed.
 * This eliminates the 5-15 second npm install at runtime.
 */
import { snapshot } from '@webcontainer/snapshot';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function buildSnapshot() {
  console.log('Creating WebContainer snapshot with @rundown/cli...');

  // 1. Create temp directory
  const tempDir = mkdtempSync(join(tmpdir(), 'rundown-env-'));
  console.log(`Working directory: ${tempDir}`);

  // 2. Write package.json
  const packageJson = {
    name: 'rundown-demo',
    type: 'module',
    dependencies: {
      '@rundown/cli': 'latest',
    },
  };
  writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

  // 3. Run npm install at build time
  console.log('Installing @rundown/cli (this may take a moment)...');
  execSync('npm install', { cwd: tempDir, stdio: 'inherit' });

  // 4. Create binary snapshot (includes node_modules!)
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
}

buildSnapshot().catch((err) => {
  console.error('Failed to create snapshot:', err);
  process.exit(1);
});
