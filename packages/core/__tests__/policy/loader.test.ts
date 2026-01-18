import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadPolicy,
  loadPolicySync,
  loadPolicyFromFile,
  loadPolicyFromFileSync,
} from '../../src/policy/loader.js';

describe('Policy Loader - package.json', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundown-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const createPackageJson = (rundownConfig: object) => {
    const packageJson = {
      name: 'test-package',
      version: '1.0.0',
      rundown: rundownConfig,
    };
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );
  };

  describe('loadPolicy', () => {
    it('should load policy from package.json rundown field', async () => {
      createPackageJson({
        version: 1,
        default: { mode: 'deny' },
      });

      const result = await loadPolicy({ cwd: tempDir });

      expect(result.isDefault).toBe(false);
      expect(result.policy.default.mode).toBe('deny');
    });
  });

  describe('loadPolicySync', () => {
    it('should load policy from package.json rundown field', () => {
      createPackageJson({
        version: 1,
        default: { mode: 'deny' },
      });

      const result = loadPolicySync({ cwd: tempDir });

      expect(result.isDefault).toBe(false);
      expect(result.policy.default.mode).toBe('deny');
    });
  });

  describe('loadPolicyFromFile', () => {
    it('should load policy from package.json rundown field', async () => {
      createPackageJson({
        version: 1,
        default: { mode: 'deny' },
      });

      const result = await loadPolicyFromFile(path.join(tempDir, 'package.json'));

      expect(result.isDefault).toBe(false);
      expect(result.policy.default.mode).toBe('deny');
    });
  });

  describe('loadPolicyFromFileSync', () => {
    it('should load policy from package.json rundown field', () => {
      createPackageJson({
        version: 1,
        default: { mode: 'deny' },
      });

      const result = loadPolicyFromFileSync(path.join(tempDir, 'package.json'));

      expect(result.isDefault).toBe(false);
      expect(result.policy.default.mode).toBe('deny');
    });
  });
});
