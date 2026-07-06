import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// Mock node:fs — control existsSync for sibling discovery
const mockExistsSync = jest.fn<(path: string) => boolean>();
jest.unstable_mockModule('node:fs', () => ({
  existsSync: mockExistsSync,
}));

// Import after mocking
const { getPluginRoot, _resetPluginRootCache } = await import('../../src/helpers/plugin-root.js');

describe('getPluginRoot()', () => {
  let originalClaudePluginRoot: string | undefined;
  let originalCodexPluginRoot: string | undefined;
  let originalRundownPluginRoot: string | undefined;

  beforeEach(() => {
    originalClaudePluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    originalCodexPluginRoot = process.env.CODEX_PLUGIN_ROOT;
    originalRundownPluginRoot = process.env.RUNDOWN_PLUGIN_ROOT;
  });

  afterEach(() => {
    // Restore env
    if (originalClaudePluginRoot !== undefined) {
      process.env.CLAUDE_PLUGIN_ROOT = originalClaudePluginRoot;
    } else {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    }
    if (originalCodexPluginRoot !== undefined) {
      process.env.CODEX_PLUGIN_ROOT = originalCodexPluginRoot;
    } else {
      delete process.env.CODEX_PLUGIN_ROOT;
    }
    if (originalRundownPluginRoot !== undefined) {
      process.env.RUNDOWN_PLUGIN_ROOT = originalRundownPluginRoot;
    } else {
      delete process.env.RUNDOWN_PLUGIN_ROOT;
    }
    originalClaudePluginRoot = undefined;
    originalCodexPluginRoot = undefined;
    originalRundownPluginRoot = undefined;

    // Reset cache between tests
    _resetPluginRootCache();
    mockExistsSync.mockReset();
  });

  it('returns CLAUDE_PLUGIN_ROOT env var when set', () => {
    process.env.CLAUDE_PLUGIN_ROOT = '/custom/plugin/root';

    expect(getPluginRoot()).toBe('/custom/plugin/root');
  });

  it('env var is not cached — changing it between calls returns new value', () => {
    process.env.CLAUDE_PLUGIN_ROOT = '/first';
    expect(getPluginRoot()).toBe('/first');

    process.env.CLAUDE_PLUGIN_ROOT = '/second';
    expect(getPluginRoot()).toBe('/second');
  });

  it('returns CODEX_PLUGIN_ROOT env var when Claude root is unset', () => {
    delete process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CODEX_PLUGIN_ROOT = '/codex/plugin/root';
    process.env.RUNDOWN_PLUGIN_ROOT = '/neutral/plugin/root';

    expect(getPluginRoot()).toBe('/codex/plugin/root');
  });

  it('returns RUNDOWN_PLUGIN_ROOT env var when Claude and Codex roots are unset', () => {
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CODEX_PLUGIN_ROOT;
    process.env.RUNDOWN_PLUGIN_ROOT = '/neutral/plugin/root';

    expect(getPluginRoot()).toBe('/neutral/plugin/root');
  });

  it('keeps CLAUDE_PLUGIN_ROOT as highest priority for compatibility', () => {
    process.env.CLAUDE_PLUGIN_ROOT = '/claude/plugin/root';
    process.env.CODEX_PLUGIN_ROOT = '/codex/plugin/root';
    process.env.RUNDOWN_PLUGIN_ROOT = '/neutral/plugin/root';

    expect(getPluginRoot()).toBe('/claude/plugin/root');
  });

  it('returns sibling plugin path when existsSync returns true', () => {
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CODEX_PLUGIN_ROOT;
    delete process.env.RUNDOWN_PLUGIN_ROOT;
    mockExistsSync.mockReturnValue(true);

    const result = getPluginRoot();

    expect(result).not.toBeNull();
    expect(result).toContain('claude-code-plugin');
    expect(mockExistsSync).toHaveBeenCalledTimes(1);

    // Verify the returned root matches the probed path with /runbooks stripped
    const checkedPath = mockExistsSync.mock.calls[0][0];
    expect(checkedPath.replace(/[\\/]runbooks$/, '')).toBe(result);
  });

  it('returns null when existsSync returns false and env var unset', () => {
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CODEX_PLUGIN_ROOT;
    delete process.env.RUNDOWN_PLUGIN_ROOT;
    mockExistsSync.mockReturnValue(false);

    expect(getPluginRoot()).toBeNull();
  });

  it('caches sibling discovery result — second call skips filesystem', () => {
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CODEX_PLUGIN_ROOT;
    delete process.env.RUNDOWN_PLUGIN_ROOT;
    mockExistsSync.mockReturnValue(true);

    getPluginRoot();
    getPluginRoot();

    // existsSync called only once — second call used cache
    expect(mockExistsSync).toHaveBeenCalledTimes(1);
  });

  it('_resetPluginRootCache clears cache so next call re-discovers', () => {
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CODEX_PLUGIN_ROOT;
    delete process.env.RUNDOWN_PLUGIN_ROOT;
    mockExistsSync.mockReturnValue(false);

    expect(getPluginRoot()).toBeNull();

    // Reset cache and change mock behavior
    _resetPluginRootCache();
    mockExistsSync.mockReturnValue(true);

    expect(getPluginRoot()).not.toBeNull();
    expect(mockExistsSync).toHaveBeenCalledTimes(2);
  });

  it('env var takes precedence over cached sibling result', () => {
    delete process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CODEX_PLUGIN_ROOT;
    delete process.env.RUNDOWN_PLUGIN_ROOT;
    mockExistsSync.mockReturnValue(true);

    // First call populates cache via sibling discovery
    const siblingResult = getPluginRoot();
    expect(siblingResult).toContain('claude-code-plugin');

    // Set env var — should take precedence over cached sibling
    process.env.CLAUDE_PLUGIN_ROOT = '/env/override';
    expect(getPluginRoot()).toBe('/env/override');
  });
});
