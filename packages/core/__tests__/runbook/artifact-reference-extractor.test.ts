import { describe, expect, it } from '@jest/globals';
import { parseRunbookDocument, type Runbook } from '@rundown-org/parser';
import { extractFileArtifactReferences } from '../../src/runbook/artifact-reference-extractor.js';

function extract(markdown: string): readonly string[] {
  return extractFileArtifactReferences(parseRunbookDocument(markdown).runbook);
}

describe('extractFileArtifactReferences', () => {
  it('finds static relative file refs on steps and substeps', () => {
    const refs = extract(`# Fixture artifacts

## 1. Parent
- ARTIFACTS
  - Schema "schemas/review.schema.json"
- PASS CONTINUE

### 1.1 Child
- ARTIFACTS
  - Config "fixtures/config.json"
- PASS CONTINUE

\`\`\`bash
rd echo --result pass
\`\`\`
`);

    expect(refs).toEqual(['schemas/review.schema.json', 'fixtures/config.json']);
  });

  it('finds static relative file refs on for-loop substeps', () => {
    const refs = extract(`# Fixture artifacts

## 1. Iterate
- FOR item IN {{ items }}
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Child
- ARTIFACTS
  - Schema "schemas/loop.schema.json"
- PASS CONTINUE

\`\`\`bash
rd echo --result pass
\`\`\`
`);

    expect(refs).toEqual(['schemas/loop.schema.json']);
  });

  it('deduplicates in source order', () => {
    const refs = extract(`# Fixture artifacts

## 1. First
- ARTIFACTS
  - A "schemas/a.json"
  - B "schemas/b.json"
- PASS CONTINUE

### 1.1 Child
- ARTIFACTS
  - ADupe "schemas/a.json"
  - C "schemas/c.json"
- PASS CONTINUE

\`\`\`bash
rd echo --result pass
\`\`\`
`);

    expect(refs).toEqual(['schemas/a.json', 'schemas/b.json', 'schemas/c.json']);
  });

  it('ignores non-static file-reference artifact tokens', () => {
    const runbook: Runbook = {
      steps: [
        {
          kind: 'base',
          name: '1',
          description: 'Mixed',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
          artifacts: [
            { name: 'Naked', rawToken: null },
            { name: 'Managed', rawToken: 'plan.json' },
            { name: 'Selector', rawToken: '*/plan.json' },
            { name: 'Uri', rawToken: 'rd://artifacts/ctx1/*/plan.json' },
            { name: 'Absolute', rawToken: '/tmp/plan.json' },
            { name: 'Templated', rawToken: '{{Dir}}/plan.json' },
            { name: 'Glob', rawToken: 'schemas/*.json' },
            { name: 'Static', rawToken: 'schemas/review.schema.json' },
          ],
        },
      ],
    };
    const refs = extractFileArtifactReferences(runbook);

    expect(refs).toEqual(['schemas/review.schema.json']);
  });
});
