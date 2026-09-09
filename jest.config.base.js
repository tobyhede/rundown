// Worker pool size, overridable by environment. The default of 2 is the value
// every package's `test:*` script used to pass as `--maxWorkers=2`; it lives in
// config now so `JEST_MAX_WORKERS=1` can bound every Jest run in the tree. A
// CLI `--maxWorkers` flag still beats this, which is why those flags were
// removed from the scripts.
export const maxWorkers = Math.max(1, Number(process.env.JEST_MAX_WORKERS) || 2);

export default {
  maxWorkers,
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/../../.worktrees/', '/\\.stryker-tmp/'],
  modulePathIgnorePatterns: ['<rootDir>/../../.worktrees/', '/\\.stryker-tmp/'],
  watchPathIgnorePatterns: ['<rootDir>/../../.worktrees/', '/\\.stryker-tmp/'],
};
