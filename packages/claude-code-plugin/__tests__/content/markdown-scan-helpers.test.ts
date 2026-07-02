import { describe, expect, it } from '@jest/globals';
import { fencedBlocks, inlineCodeSpans } from './markdown-scan-helpers.js';

describe('fencedBlocks', () => {
  it('extracts a single simple fenced block', () => {
    const markdown = '```bash\nrundown status\n```\n';
    expect(fencedBlocks(markdown)).toEqual(['rundown status\n']);
  });

  it('extracts multiple sibling fenced blocks independently', () => {
    const markdown = '```bash\nfirst\n```\n\ntext\n\n```bash\nsecond\n```\n';
    expect(fencedBlocks(markdown)).toEqual(['first\n', 'second\n']);
  });

  it('does not desync on a longer outer fence wrapping a shorter inner fence', () => {
    // A real, already-used pattern (packages/claude-code-plugin/skills/writing-runbooks/house-style.md):
    // a 4-backtick fence wraps a worked example that itself contains a 3-backtick fence.
    // A naive "any run of 3+ backticks closes the fence" scan treats the inner
    // fence's opening backticks as the outer fence's close, desyncing every
    // block boundary after it.
    const markdown = [
      '````markdown',
      'outer line 1',
      '```bash',
      'rundown status',
      '```',
      'outer line 2',
      '````',
      '',
    ].join('\n');

    const blocks = fencedBlocks(markdown);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('rundown status');
    expect(blocks[0]).toContain('outer line 1');
    expect(blocks[0]).toContain('outer line 2');
  });
});

describe('inlineCodeSpans', () => {
  it('extracts single-backtick spans outside fenced blocks', () => {
    const markdown = 'Run `rundown status` to check.';
    expect(inlineCodeSpans(markdown)).toEqual(['rundown status']);
  });

  it('excludes content inside fenced blocks', () => {
    const markdown = '```bash\n`not a span`\n```\n';
    expect(inlineCodeSpans(markdown)).toEqual([]);
  });
});
