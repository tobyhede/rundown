import fc from 'fast-check';
import { PolicyEvaluator } from '../../src/policy/evaluator.js';
import { DEFAULT_POLICY, type PolicyConfig } from '../../src/policy/schema.js';

const repoRoot = '/test/repo';

const denyRunPolicy = (allow: string[]): PolicyConfig => ({
  ...DEFAULT_POLICY,
  default: {
    ...DEFAULT_POLICY.default,
    mode: 'deny',
    run: { allow, deny: [] },
  },
});

const prefixArb = fc.constantFrom('git', 'npm', 'node', 'echo', 'tool');
const suffixArb = fc.constantFrom('x', '-evil', '_evil', '2');

const dynamicExecutableCommandArb = fc
  .record({
    prefix: prefixArb,
    suffix: suffixArb,
    substitutionKind: fc.constantFrom<'dollar' | 'backtick' | 'var' | 'bracedVar'>(
      'dollar',
      'backtick',
      'var',
      'bracedVar',
    ),
    wrapper: fc.constantFrom<'bare' | 'env' | 'pipeline'>('bare', 'env', 'pipeline'),
  })
  .map(({ prefix, suffix, substitutionKind, wrapper }) => {
    const substitutionByKind = {
      dollar: `$(printf ${suffix})`,
      backtick: `\`printf ${suffix}\``,
      var: '$SUFFIX',
      bracedVar: '${SUFFIX}',
    };
    const substitution = substitutionByKind[substitutionKind];
    const command = `${prefix}${substitution} status`;

    if (wrapper === 'env') return `ENV=value ${command}`;
    if (wrapper === 'pipeline') return `${command} | cat`;
    return command;
  });

describe('Command parser properties', () => {
  it('never allows executable words with embedded substitutions as static allowlist matches', () => {
    fc.assert(
      fc.property(dynamicExecutableCommandArb, (command) => {
        const evaluator = new PolicyEvaluator(
          denyRunPolicy(['git', 'npm', 'node', 'echo', 'tool', 'printf', 'cat']),
          { repoRoot },
        );

        const decision = evaluator.checkCommand(command);

        expect(decision.allowed).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
